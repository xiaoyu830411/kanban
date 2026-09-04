import { afterAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifySession,
  createLaunchRegistry,
  createObserver,
  deriveHeadSnapshot,
  deriveTailSnapshot,
  parseJsonlLines,
} from '../../scripts/observer.mjs';

const harnessRoots: string[] = [];
afterAll(() => {
  for (const dir of harnessRoots) rmSync(dir, { recursive: true, force: true });
});

// ---- 纯函数 ----

describe('jsonl 解析（防御式）', () => {
  it('坏行跳过、空行忽略、非对象忽略', () => {
    const entries = parseJsonlLines(
      ['{"type":"user"}', 'not json', '', 'null', '"string"', '{"type":"assistant"}'].join('\n'),
    );
    expect(entries.map((entry: { type: string }) => entry.type)).toEqual(['user', 'assistant']);
  });

  it('头部信息：cwd / 首 prompt（纯文本才认）/ 会话名（取最后）', () => {
    const head = deriveHeadSnapshot([
      { type: 'user', message: { content: [{ type: 'tool_result' }] }, cwd: '/w' },
      { type: 'user', message: { content: '帮我修登录 bug' }, cwd: '/w' },
      { type: 'ai-title', aiTitle: '旧标题' },
      { type: 'ai-title', aiTitle: '修复登录' },
    ]);
    expect(head).toEqual({ cwd: '/w', firstPrompt: '帮我修登录 bug', aiTitle: '修复登录' });
  });

  it('尾部信息：最后 assistant 的 stop_reason / 最后条目时间 / 会话名', () => {
    const tail = deriveTailSnapshot([
      { type: 'assistant', message: { stop_reason: 'tool_use' }, timestamp: '2026-09-04T10:00:00Z' },
      { type: 'user', timestamp: '2026-09-04T10:01:00Z' },
      { type: 'assistant', message: { stop_reason: 'end_turn' }, timestamp: '2026-09-04T10:02:00Z' },
    ]);
    expect(tail.lastStopReason).toBe('end_turn');
    expect(tail.lastEntryAt).toEqual(new Date('2026-09-04T10:02:00Z'));
    expect(tail.aiTitle).toBeNull();
  });
});

describe('classifySession（双信号终态，ADR-0005）', () => {
  const idle = { idleTimeoutMs: 30 * 60_000 };
  const now = 1_000_000_000_000;

  it('进程不在：end_turn=完结，其余=中断', () => {
    expect(classifySession({ stopReason: 'end_turn', alive: false }, { ...idle, now })).toEqual({
      status: 'finished',
      endCause: 'graceful',
    });
    expect(classifySession({ stopReason: 'tool_use', alive: false }, { ...idle, now })).toEqual({
      status: 'interrupted',
      endCause: 'process_gone',
    });
    expect(classifySession({ stopReason: null, alive: false }, { ...idle, now })).toEqual({
      status: 'interrupted',
      endCause: 'process_gone',
    });
  });

  it('进程在：空闲超阈值转完结；否则按 stop_reason', () => {
    const recent = new Date(now - 60_000);
    const stale = new Date(now - 2 * 60 * 60_000);
    expect(classifySession({ stopReason: 'tool_use', lastEntryAt: recent, alive: true }, { ...idle, now })).toEqual({
      status: 'running',
      endCause: null,
    });
    expect(classifySession({ stopReason: 'end_turn', lastEntryAt: recent, alive: true }, { ...idle, now })).toEqual({
      status: 'idle',
      endCause: null,
    });
    expect(classifySession({ stopReason: 'end_turn', lastEntryAt: stale, alive: true }, { ...idle, now })).toEqual({
      status: 'finished',
      endCause: 'idle_timeout',
    });
    expect(classifySession({ stopReason: null, lastEntryAt: null, alive: true }, { ...idle, now })).toEqual({
      status: 'running',
      endCause: null,
    });
  });
});

describe('createLaunchRegistry（待绑定 + TTL）', () => {
  it('命中/移除/过期', () => {
    let clock = 0;
    const registry = createLaunchRegistry({ now: () => clock, ttlMs: 100 });
    registry.add('/tmp/wt', 7);
    expect(registry.match('/tmp/wt/')).toBe(7); // 尾斜杠归一
    expect(registry.match('/tmp/other')).toBeNull();
    clock = 101;
    expect(registry.match('/tmp/wt')).toBeNull(); // 过期自清
    expect(registry.size).toBe(0);
  });
});

// ---- 观察器集成（每用例独立 tmp 转录根目录 + 假 client + 注入存活与时钟） ----

interface CallLog {
  register: Array<Record<string, unknown>>;
  report: Array<Record<string, unknown>>;
  bind: Array<Record<string, unknown>>;
}

function fakeClient() {
  const calls: CallLog = { register: [], report: [], bind: [] };
  return {
    calls,
    async registerObservation(input: Record<string, unknown>) {
      calls.register.push(input);
      return { task: { id: 100 + calls.register.length }, run: { status: 'running' }, existing: false };
    },
    async reportObservation(input: Record<string, unknown>) {
      calls.report.push(input);
      return { task: {}, run: {} };
    },
    async bindObservation(input: Record<string, unknown>) {
      calls.bind.push(input);
      return { run: { status: 'running' }, existing: false };
    },
  };
}

function makeHarness(watchPaths: string[], launches = createLaunchRegistry()) {
  const harnessRoot = mkdtempSync(path.join(os.tmpdir(), 'observer-h-'));
  harnessRoots.push(harnessRoot);
  const client = fakeClient();
  const alive: Record<string, boolean> = {};
  let clock = 1_000_000_000_000;
  const observer = createObserver({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    config: {
      watchPaths,
      watchIntervalMs: 60_000,
      idleTimeoutMs: 30 * 60_000,
      claudeProjectsDir: harnessRoot,
    },
    launches,
    aliveCheck: async (cwd: string) => alive[cwd] ?? false,
    now: () => clock,
    log: () => {},
  });
  const file = (proj: string, sessionId: string) => {
    const dir = path.join(harnessRoot, proj);
    mkdirSync(dir, { recursive: true });
    return path.join(dir, `${sessionId}.jsonl`);
  };
  return { client, alive, launches, advance: (ms: number) => (clock += ms), observer, file };
}

describe('createObserver（登记 / 排除 / 绑定 / 状态流转）', () => {
  it('白名单新会话 → 登记建卡（标题=首 prompt）；非白名单 → 永久排除', async () => {
    const { client, observer, file } = makeHarness(['/work/proj']);
    appendFileSync(
      file('proj-a', 'sess-r1'),
      JSON.stringify({ type: 'user', message: { content: '帮我修登录 bug' }, cwd: '/work/proj', timestamp: '2026-09-04T10:00:00Z' }) + '\n',
    );
    appendFileSync(
      file('proj-b', 'sess-r2'),
      JSON.stringify({ type: 'user', message: { content: '无关会话' }, cwd: '/elsewhere' }) + '\n',
    );

    await observer.tick();
    expect(client.calls.register).toHaveLength(1);
    expect(client.calls.register[0]).toMatchObject({
      sessionId: 'sess-r1',
      agentType: 'claude_code',
      cwd: '/work/proj',
      title: '帮我修登录 bug',
      aiTitleApplied: false,
    });
    expect(client.calls.bind).toHaveLength(0);

    await observer.tick(); // 排除不重试
    expect(client.calls.register).toHaveLength(1);
  });

  it('pending workdir 命中 → 绑定 launched Run（优先于白名单）', async () => {
    const launches = createLaunchRegistry();
    launches.add('/work/wt', 42);
    const { client, observer, file } = makeHarness([], launches);
    appendFileSync(file('proj-c', 'sess-b1'), JSON.stringify({ type: 'user', message: { content: 'go' }, cwd: '/work/wt' }) + '\n');

    await observer.tick();
    expect(client.calls.bind).toHaveLength(1);
    expect(client.calls.bind[0]).toMatchObject({ taskId: 42, sessionId: 'sess-b1', cwd: '/work/wt' });
    expect(client.calls.register).toHaveLength(0); // 绑定路径不走登记
    expect(launches.size).toBe(0);
  });

  it('状态流转：running → idle → 完结(graceful) → 复活(running)；ai-title 补写一次', async () => {
    const { client, alive, advance, observer, file } = makeHarness(['/work/proj']);
    const transcript = file('proj-d', 'sess-f1');
    appendFileSync(
      transcript,
      JSON.stringify({ type: 'user', message: { content: '干活' }, cwd: '/work/proj', timestamp: new Date(1_000_000_000_000).toISOString() }) + '\n',
    );
    alive['/work/proj'] = true;

    await observer.tick(); // 登记（首报 running 隐含于登记响应，不重复上报）
    expect(client.calls.register).toHaveLength(1);
    expect(client.calls.report).toHaveLength(0);

    // 回合结束 → idle；同时 ai-title 到达
    advance(10_000);
    appendFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' }, timestamp: new Date(1_000_000_010_000).toISOString() }) + '\n' +
        JSON.stringify({ type: 'ai-title', aiTitle: 'AI 起的正式标题' }) + '\n',
    );
    await observer.tick();
    expect(client.calls.report).toHaveLength(1);
    expect(client.calls.report[0]).toMatchObject({ sessionId: 'sess-f1', status: 'idle', title: 'AI 起的正式标题' });

    // 进程消失（end_turn 后）→ 完结
    alive['/work/proj'] = false;
    advance(5_000);
    await observer.tick();
    expect(client.calls.report).toHaveLength(2);
    expect(client.calls.report[1]).toMatchObject({ status: 'finished', endCause: 'graceful' });

    // 会话复活（用户继续输入）→ running（服务端按 revertible 决定回退）
    alive['/work/proj'] = true;
    advance(5_000);
    appendFileSync(
      transcript,
      JSON.stringify({ type: 'user', message: { content: '再改一下' }, timestamp: new Date(1_000_000_020_000).toISOString() }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' }, timestamp: new Date(1_000_000_020_500).toISOString() }) + '\n',
    );
    await observer.tick();
    expect(client.calls.report).toHaveLength(3);
    expect(client.calls.report[2]).toMatchObject({ status: 'running' });
    expect(client.calls.report[2].title).toBeUndefined(); // 标题只补一次
  });

  it('空闲超阈值（进程还在）→ 完结 idle_timeout', async () => {
    const { client, alive, observer, file } = makeHarness(['/work/idle']);
    appendFileSync(
      file('proj-e', 'sess-i1'),
      JSON.stringify({ type: 'user', message: { content: '长会话' }, cwd: '/work/idle', timestamp: new Date(1_000_000_000_000 - 2 * 60 * 60_000).toISOString() }) + '\n',
    );
    alive['/work/idle'] = true;

    await observer.tick();
    expect(client.calls.register).toHaveLength(1);
    expect(client.calls.report.at(-1)).toMatchObject({ sessionId: 'sess-i1', status: 'finished', endCause: 'idle_timeout' });
  });
});
