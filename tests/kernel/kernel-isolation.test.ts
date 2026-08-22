import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const KERNEL_DIR = path.resolve(__dirname, '../../src/server/kernel');

function listKernelFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return listKernelFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/**
 * ADR-0004：内核禁止直接依赖任何具体插件；插件间也不互相依赖。
 * 用静态扫描守住这条边界，防止未来误引入。
 */
describe('内核边界（ADR-0004）', () => {
  it('kernel 目录不 import 任何插件模块', () => {
    const violations: string[] = [];
    for (const file of listKernelFiles(KERNEL_DIR)) {
      const source = readFileSync(file, 'utf8');
      const importMatches = source.matchAll(/from\s+['"]([^'"]+)['"]/g);
      for (const match of importMatches) {
        // violations: absolute '@/plugins/…' or relative escape '../plugins/…'
        // (kernel's own './plugin' module is fine — it lives inside the kernel)
        if (/^@\/plugins\/|\.\.\/plugins\//.test(match[1])) {
          violations.push(`${path.relative(process.cwd(), file)} → ${match[1]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
