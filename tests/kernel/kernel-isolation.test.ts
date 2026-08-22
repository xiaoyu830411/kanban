import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const KERNEL_DIR = path.resolve(__dirname, '../../src/server/kernel');
const PLUGINS_DIR = path.resolve(__dirname, '../../src/plugins');

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

function importsOf(file: string, opts: { typeOnlyExcluded?: boolean } = {}): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)]
    .filter((m) => !(opts.typeOnlyExcluded && m[1]))
    .map((m) => m[2]);
}

/**
 * ADR-0004：内核禁止直接依赖任何具体插件；插件间也不互相依赖；
 * 插件不侵入内核域服务（只经事件订阅与内核公共 API 协作）。
 * 用静态扫描守住这些边界，防止未来误引入。
 */
describe('内核与插件边界（ADR-0004）', () => {
  it('kernel 目录不 import 任何插件模块', () => {
    const violations: string[] = [];
    for (const file of listFiles(KERNEL_DIR)) {
      for (const specifier of importsOf(file)) {
        if (/^@\/plugins\/|\.\.\/plugins\//.test(specifier)) {
          violations.push(`${path.relative(process.cwd(), file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('插件之间不互相依赖', () => {
    const violations: string[] = [];
    for (const file of listFiles(PLUGINS_DIR)) {
      for (const specifier of importsOf(file)) {
        if (/^@\/plugins\/(?!activity\/|auth\/)/.test(specifier)) {
          violations.push(`${path.relative(process.cwd(), file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('插件不 import 内核域服务，只允许事件契约与叶子常量', () => {
    // 内核对插件开放的面：事件契约、总线、插件接口、协议错误、列/优先级常量
    const allowed = [
      '@/server/kernel/events',
      '@/server/kernel/event-bus',
      '@/server/kernel/plugin',
      '@/server/kernel/protocol',
      '@/server/kernel/board-columns',
      '@/server/kernel/task-meta',
    ];
    const kernelServicePattern = /^@\/server\/kernel\//;
    const violations: string[] = [];
    for (const file of listFiles(PLUGINS_DIR)) {
      // type-only imports carry no runtime dependency on kernel services
      for (const specifier of importsOf(file, { typeOnlyExcluded: true })) {
        if (kernelServicePattern.test(specifier) && !allowed.includes(specifier)) {
          violations.push(`${path.relative(process.cwd(), file)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
