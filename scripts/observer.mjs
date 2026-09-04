/**
 * 会话观察器（ADR-0005，随 launcher 常驻）。
 *
 * 轮询 ~/.claude/projects/<项目目录>/<sessionId>.jsonl 转录文件：
 * - 白名单项目的新会话 → 登记建卡（registered Run）
 * - 启动器拉起（pending workdir 命中）→ 绑定 launched Run
 * - 状态推导（running/idle/finished/interrupted）经 Agent API 上报；
 *   列迁移等域规则全部在服务端（src/server/kernel/runs.ts）。
 *
 * 解析防御式（ADR-0005：jsonl 无官方稳定性承诺）：未知条目类型忽略、
 * 单行损坏跳过、单文件失败不影响其余观察。
 *
 * 存活探测为进程级（实测 claude 按次 append、不持久持有转录 fd，
 * 文件级 lsof 不可用）：ps 找 claude 进程 → lsof -d cwd 比对会话 cwd；
 * 结果按 cwd 缓存 30s，判死前连探两次防竞态抖动。同 cwd 多会话的
 * 歧义降级由空闲超时兜底（idle_timeout）。
 *
 * 配置（环境变量，launcher resolveConfig 汇入）：
 *   TASKBOARD_WATCH_PATHS      cwd 白名单（逗号/冒号分隔；默认空=不登记）
 *   TASKBOARD_WATCH_INTERVAL   轮询间隔 ms（默认 5000）
 *   TASKBOARD_WATCH_IDLE_TIMEOUT 空闲转完结 ms（默认 30 分钟）
 *   TASKBOARD_CLAUDE_DIR       转录根目录（默认 ~/.claude/projects）
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open as openFile, readFile, readdir, stat } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 128 * 1024;
const ALIVE_CACHE_MS = 30_000;
/** 静默超过此值的历史转录连读都不读（既不存活也无新意，#24）。 */
const STALE_FILE_MS = 24 * 60 * 60_000;

/** cwd 归一化：去尾斜杠（白名单/绑定/存活比对统一口径）。 */
export function normalizeCwd(cwd) {
  return String(cwd).replace(/\/+$/, '') || '/';
}

// ---- jsonl 解析（防御式） ----

/** 解析一段文本里的 JSON 行；坏行跳过，未知结构原样透传由 derive 过滤。 */
export function parseJsonlLines(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // 单行损坏（半行写入/损坏）：跳过
    }
  }
  return entries;
}

/** 头部信息：cwd（白名单判定基准）、首条 prompt（占位标题）、会话名。 */
export function deriveHeadSnapshot(entries) {
  let cwd = null;
  let firstPrompt = null;
  let aiTitle = null;
  for (const entry of entries) {
    if (!cwd && typeof entry.cwd === 'string' && entry.cwd) cwd = entry.cwd;
    if (!firstPrompt && entry.type === 'user' && typeof entry.message?.content === 'string') {
      const text = entry.message.content.trim();
      if (text) firstPrompt = text.slice(0, 80);
    }
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      aiTitle = entry.aiTitle.trim(); // 取最后一个（标题会精化）
    }
  }
  return { cwd, firstPrompt, aiTitle };
}

/** 尾部信息：最后一条 assistant 的 stop_reason、最后条目时间、会话名。 */
export function deriveTailSnapshot(entries) {
  let lastStopReason = null;
  let lastEntryAt = null;
  let aiTitle = null;
  for (const entry of entries) {
    const reason = entry.message?.stop_reason;
    if (entry.type === 'assistant' && typeof reason === 'string') lastStopReason = reason;
    if (typeof entry.timestamp === 'string') lastEntryAt = new Date(entry.timestamp);
    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      aiTitle = entry.aiTitle.trim();
    }
  }
  return { lastStopReason, lastEntryAt, aiTitle };
}

// ---- 状态推导 ----

/**
 * 双信号终态判定（ADR-0005）：进程不在 → 终态（end_turn=完结，否则中断）；
 * 进程在 → 空闲超阈值转完结；否则按 stop_reason（tool_use=运行，end_turn=空闲）。
 *
 * @param {{ stopReason?: string | null, lastEntryAt?: Date | null, alive?: boolean }} signals
 * @param {{ now?: number, idleTimeoutMs?: number }} [options]
 */
export function classifySession(
  { stopReason, lastEntryAt, alive },
  { now = Date.now(), idleTimeoutMs = 30 * 60_000 } = {},
) {
  if (!alive) {
    return stopReason === 'end_turn'
      ? { status: 'finished', endCause: 'graceful' }
      : { status: 'interrupted', endCause: 'process_gone' };
  }
  // 空闲超时只对「有过条目」的会话生效：刚诞生还没有条目的会话视为运行中
  const hasLast = lastEntryAt instanceof Date && !Number.isNaN(lastEntryAt.getTime());
  if (hasLast && now - lastEntryAt.getTime() > idleTimeoutMs) {
    return { status: 'finished', endCause: 'idle_timeout' };
  }
  if (stopReason === 'end_turn') return { status: 'idle', endCause: null };
  return { status: 'running', endCause: null };
}

// ---- 存活探测（进程级） ----

async function probeCwdOnce(cwd, excludePid) {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,command=']);
  const target = normalizeCwd(cwd);
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceAt = trimmed.indexOf(' ');
    const pid = Number(trimmed.slice(0, spaceAt));
    const command = trimmed.slice(spaceAt + 1);
    if (!(Number.isInteger(pid) && pid > 0) || pid === excludePid) continue;
    // 匹配可执行名/路径段 claude（排除观察器自身与 grep 等误配）
    if (!/(?:^|[\/\s])claude(?:\s|$|[-.\/])/i.test(command)) continue;
    if (/observer\.mjs|launcher\.mjs|\bgrep\b/.test(command)) continue;
    try {
      const { stdout: lsofOut } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', String(pid)]);
      if (
        lsofOut
          .split('\n')
          .some((l) => l.startsWith('n') && normalizeCwd(l.slice(1)) === target)
      ) {
        return true;
      }
    } catch {
      // 进程在 ps 与 lsof 之间退出：跳过该 pid
    }
  }
  return false;
}

/** 存活检查器：按 cwd 缓存 30s；判死前连探两次（防 lsof/ps 瞬时失败）。 */
export function createAliveChecker({ excludePid = process.pid, now = Date.now } = {}) {
  const cache = new Map();
  return async function aliveCheck(cwd) {
    const hit = cache.get(cwd);
    if (hit && now() - hit.at < ALIVE_CACHE_MS) return hit.alive;
    let alive = await probeCwdOnce(cwd, excludePid).catch(() => false);
    if (!alive) alive = await probeCwdOnce(cwd, excludePid).catch(() => false);
    cache.set(cwd, { alive, at: now() });
    return alive;
  };
}

// ---- 启动器待绑定登记 ----

/** pending：workdir → taskId（启动后等转录出现；TTL 默认 15 分钟）。 */
export function createLaunchRegistry({ now = Date.now, ttlMs = 15 * 60_000 } = {}) {
  const pending = new Map();
  return {
    add(workdir, taskId) {
      pending.set(normalizeCwd(workdir), { taskId, until: now() + ttlMs });
    },
    /** 命中返回 taskId（过期自动清），未命中返回 null。 */
    match(workdir) {
      const key = normalizeCwd(workdir);
      const hit = pending.get(key);
      if (!hit) return null;
      if (now() > hit.until) {
        pending.delete(key);
        return null;
      }
      return hit.taskId;
    },
    remove(workdir) {
      pending.delete(normalizeCwd(workdir));
    },
    get size() {
      return pending.size;
    },
  };
}

// ---- 启动器领土（#24） ----

/**
 * 从 cwd 反解启动器执行现场的 taskId：worktree 根/<id> 或 tmp 根/taskboard-<id>。
 * 返回 null 表示不在启动器领土内（普通项目目录，正常走登记）。
 */
export function territoryTaskId(cwd, config) {
  const normalized = normalizeCwd(cwd);
  const worktreeRoot = normalizeCwd(config.worktreeRoot ?? '');
  if (worktreeRoot && normalized.startsWith(`${worktreeRoot}/`)) {
    const segment = normalized.slice(worktreeRoot.length + 1).split('/')[0];
    return /^\d+$/.test(segment) ? Number(segment) : null;
  }
  const tmpRoot = normalizeCwd(config.tmpRoot ?? '');
  if (tmpRoot && normalized.startsWith(`${tmpRoot}/taskboard-`)) {
    const segment = normalized.slice(tmpRoot.length + '/taskboard-'.length).split('/')[0];
    return /^\d+$/.test(segment) ? Number(segment) : null;
  }
  return null;
}

// ---- git 辅助（best-effort：非 git 目录静默返回空） ----

async function gitHead(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
    return stdout.trim().slice(0, 64) || null;
  } catch {
    return null;
  }
}

async function gitChangedFiles(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, 200);
  } catch {
    return [];
  }
}

// ---- 观察器 ----

async function readHead(file) {
  const buffer = await readFile(file, { encoding: 'utf8', flag: 'r' } );
  return buffer.slice(0, HEAD_BYTES);
}

async function readTail(file, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await openFile(file, 'r');
  try {
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * 创建观察器。依赖全部可注入（测试用）：
 * client（TaskboardClient）、config、launches（启动器 registry）、
 * aliveCheck、now、log。
 */
export function createObserver({
  client,
  config,
  launches = createLaunchRegistry(),
  aliveCheck = createAliveChecker(),
  now = Date.now,
  log = console.log,
}) {
  const watchlist = (config.watchPaths ?? []).map(normalizeCwd);
  /** sessionId → 观察记录。 */
  const tracked = new Map();
  /** cwd 不匹配的文件（按路径记，永不再看）。 */
  const excluded = new Set();
  let timer = null;
  let ticking = false;

  async function discover() {
    let dirs;
    try {
      dirs = await readdir(config.claudeProjectsDir, { withFileTypes: true });
    } catch {
      return; // 目录不存在（未装 claude）：安静跳过
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files;
      try {
        files = await readdir(`${config.claudeProjectsDir}/${dir.name}`);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = `${config.claudeProjectsDir}/${dir.name}/${file}`;
        if (excluded.has(filePath) || tracked.has(file.slice(0, -6))) continue;
        await adopt(filePath).catch((error) => log(`[observer] adopt failed: ${filePath}: ${error.message}`));
      }
    }
  }

  /** 新转录文件收养（#24：全量扫描，存活门槛）：
   *  pending 绑定 > 启动器领土（恢复绑定或排除）> 可选白名单 > 存活过滤 > 登记。 */
  async function adopt(filePath) {
    const sessionId = filePath.split('/').pop().slice(0, -6);
    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      return; // 文件消失：下轮再看
    }
    if (stats.size === 0) return; // 尚未写入：下轮再看
    // 静默已久的历史转录（>24h 未动）：不存活、无新意，连读都不读
    if (now() - stats.mtimeMs > STALE_FILE_MS) {
      excluded.add(filePath);
      return;
    }
    const head = deriveHeadSnapshot(parseJsonlLines(await readHead(filePath)));
    if (!head.cwd) return; // 头部无 cwd（半行）：下轮再看

    const launchedTaskId = launches.match(head.cwd);
    if (launchedTaskId != null) {
      const result = await client.bindObservation({
        taskId: launchedTaskId,
        sessionId,
        agentType: 'claude_code',
        cwd: head.cwd,
        gitBaseline: await gitHead(head.cwd),
      });
      launches.remove(head.cwd);
      tracked.set(sessionId, {
        sessionId,
        filePath,
        cwd: head.cwd,
        origin: 'launched',
        taskId: launchedTaskId,
        reportedStatus: result?.run?.status ?? 'running',
        titleSent: true, // 启动器任务不补写标题
      });
      log(`[observer] bound launched run: task #${launchedTaskId} ← session ${sessionId.slice(0, 8)} @ ${head.cwd}`);
      return;
    }

    // 启动器领土（#24）：worktree/tmp 现场的会话不登记成新卡——
    // 任务仍被持有则恢复绑定（覆盖启动器重启丢 pending 的缺口），否则排除。
    const territory = territoryTaskId(head.cwd, config);
    if (territory != null) {
      let bound = false;
      try {
        const detail = await client.taskDetail(territory);
        if (detail?.task?.column === 'in_progress' && detail.task.heldByAgentId != null) {
          await client.bindObservation({
            taskId: territory,
            sessionId,
            agentType: 'claude_code',
            cwd: head.cwd,
            gitBaseline: await gitHead(head.cwd),
          });
          tracked.set(sessionId, {
            sessionId,
            filePath,
            cwd: head.cwd,
            origin: 'launched',
            taskId: territory,
            reportedStatus: 'running',
            titleSent: true,
          });
          bound = true;
          log(`[observer] recovered launched run: task #${territory} ← session ${sessionId.slice(0, 8)} @ ${head.cwd}`);
        }
      } catch {
        // 任务不存在/网络失败：按排除处理
      }
      if (!bound) excluded.add(filePath);
      return;
    }

    // 白名单是可选限制器（#24）：设置了才过滤，缺省观察全部
    if (watchlist.length > 0 && !watchlist.includes(normalizeCwd(head.cwd))) {
      excluded.add(filePath);
      return;
    }

    // 全量模式的登记门槛：存活（死会话不上看板）
    if (!(await aliveCheck(head.cwd))) {
      excluded.add(filePath);
      return;
    }

    const title = head.aiTitle ?? head.firstPrompt ?? '未命名 claude 会话';
    const result = await client.registerObservation({
      sessionId,
      agentType: 'claude_code',
      cwd: head.cwd,
      title,
      aiTitleApplied: head.aiTitle != null,
      gitBaseline: await gitHead(head.cwd),
    });
    tracked.set(sessionId, {
      sessionId,
      filePath,
      cwd: head.cwd,
      origin: 'registered',
      taskId: result?.task?.id ?? null,
      reportedStatus: result?.run?.status ?? 'running',
      titleSent: head.aiTitle != null,
    });
    log(`[observer] registered: task #${result?.task?.id} ← session ${sessionId.slice(0, 8)} @ ${head.cwd}`);
  }

  async function poll(session) {
    let size;
    try {
      size = (await stat(session.filePath)).size;
    } catch {
      size = 0; // 文件没了：按已知快照判死
    }
    let tail = { lastStopReason: null, lastEntryAt: null, aiTitle: null };
    if (size > 0) {
      tail = deriveTailSnapshot(parseJsonlLines(await readTail(session.filePath, size)));
      if (tail.aiTitle) session.pendingTitle = tail.aiTitle;
    }
    const alive = size > 0 ? await aliveCheck(session.cwd) : false;
    const { status, endCause } = classifySession(
      { stopReason: tail.lastStopReason, lastEntryAt: tail.lastEntryAt, alive },
      { now: now(), idleTimeoutMs: config.idleTimeoutMs },
    );
    if (status === session.reportedStatus && !session.pendingTitle) return;
    if (status === session.reportedStatus && session.pendingTitle && session.titleSent) {
      session.pendingTitle = null;
      return;
    }

    const body = {
      sessionId: session.sessionId,
      agentType: 'claude_code',
      status,
      stopReason: tail.lastStopReason,
      lastEntryAt: tail.lastEntryAt ? tail.lastEntryAt.toISOString() : null,
    };
    if (status !== session.reportedStatus) body.endCause = endCause;
    if (status === 'finished' || status === 'interrupted') {
      body.changedFiles = await gitChangedFiles(session.cwd);
    }
    if (session.pendingTitle && !session.titleSent) {
      body.title = session.pendingTitle;
      session.titleSent = true;
      session.pendingTitle = null;
    }

    try {
      await client.reportObservation(body);
      session.reportedStatus = status;
    } catch (error) {
      // 服务端丢了 Run（如库被清）：登记型就地重登记再上报；其余下次重试
      if (error?.code === 'unknown_session' && session.origin === 'registered') {
        const again = await client.registerObservation({
          sessionId: session.sessionId,
          agentType: 'claude_code',
          cwd: session.cwd,
          title: session.pendingTitle ?? '未命名 claude 会话',
        });
        session.taskId = again?.task?.id ?? session.taskId;
        session.titleSent = true;
        await client.reportObservation(body);
        session.reportedStatus = status;
      } else {
        throw error;
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await discover();
      for (const session of tracked.values()) {
        await poll(session).catch((error) =>
          log(`[observer] poll failed: ${session.sessionId.slice(0, 8)}: ${error.message}`),
        );
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), config.watchIntervalMs);
      timer.unref?.();
      void tick();
      log(
        `[observer] watching ${config.claudeProjectsDir} (scope: ${watchlist.length ? watchlist.join(',') : '全部项目，存活会话登记'} interval ${config.watchIntervalMs}ms idle ${config.idleTimeoutMs}ms)`,
      );
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get trackedCount() {
      return tracked.size;
    },
  };
}
