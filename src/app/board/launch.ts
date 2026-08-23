import type { BoardColumn } from '@/server/kernel/board-columns';

/**
 * 「启动」交互层（ADR-0002 修订）：浏览器直连本机启动器，看板服务器不经手。
 * 纯逻辑模块，无 React 依赖——判定/探测/启动三个函数都可单测。
 */

export const LAUNCHER_URL =
  process.env.NEXT_PUBLIC_TASKBOARD_LAUNCHER_URL ?? 'http://127.0.0.1:7642';

export interface LauncherHealth {
  ok: boolean;
  apiBase: string;
  /** 启动器绑定的 Agent（token → 身份）；解析不到为 null。 */
  agent: { id: number; name: string } | null;
}

export interface LaunchableTaskShape {
  column: BoardColumn;
  assigneeAgentId: number | null;
  heldByAgentId: number | null;
}

/**
 * 是否显示「启动」按钮：仅待办列，且可认领——未指派或指派给启动器绑定的
 * Agent（与 kernel 可认领列表同规则，见 listClaimable / claimTask）。
 */
export function isLaunchable(task: LaunchableTaskShape, launcherAgentId: number | null): boolean {
  return (
    task.column === 'todo' &&
    task.heldByAgentId === null &&
    (task.assigneeAgentId === null || task.assigneeAgentId === launcherAgentId)
  );
}

/** 探测本地启动器；不可达/超时 → null（按钮置灰）。 */
export async function probeLauncher(url = LAUNCHER_URL): Promise<LauncherHealth | null> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return (await response.json()) as LauncherHealth;
  } catch {
    return null;
  }
}

export type LaunchResult =
  | { ok: true; taskId: number; workdir: string | null }
  | { ok: false; code: string; message: string };

/** 点击「启动」：预认领在启动器侧原子完成，成功即进行中。 */
export async function launchViaLauncher(taskId: number, url = LAUNCHER_URL): Promise<LaunchResult> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; taskId?: number; workdir?: string | null; error?: { code?: string; message?: string } }
      | null;
    if (response.ok && body?.ok) {
      return { ok: true, taskId, workdir: body.workdir ?? null };
    }
    return {
      ok: false,
      code: body?.error?.code ?? 'launcher_error',
      message: body?.error?.message ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'launcher_unreachable',
      message: `连不上本地执行器：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
