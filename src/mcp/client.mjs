/**
 * Taskboard REST 客户端（Agent 侧）。
 * Agent token 经环境变量注入：TASKBOARD_TOKEN（必填）、TASKBOARD_API_BASE（默认本机）。
 * 协议错误（{ error: { code, message } }）被解析为 ApiCallError 供工具层透传。
 */

export const API_BASE = process.env.TASKBOARD_API_BASE ?? 'http://localhost:3000';

export class ApiCallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiCallError';
    this.status = status;
    this.code = code;
  }
}

export class TaskboardClient {
  constructor({ baseUrl = API_BASE, token = process.env.TASKBOARD_TOKEN } = {}) {
    if (!token) {
      throw new Error('TASKBOARD_TOKEN is required (agent API token, see /agents page)');
    }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应按原文透传
    }

    if (!response.ok) {
      const error = payload?.error;
      throw new ApiCallError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    return payload;
  }

  listClaimable() {
    return this.request('GET', '/api/agent/tasks');
  }

  taskDetail(taskId) {
    return this.request('GET', `/api/agent/tasks/${taskId}`);
  }

  createTask(input) {
    return this.request('POST', '/api/agent/tasks', input);
  }

  claimTask(taskId) {
    return this.request('POST', `/api/agent/tasks/${taskId}/claim`);
  }

  moveTask(taskId, to) {
    return this.request('PATCH', `/api/agent/tasks/${taskId}/move`, { to });
  }

  submitReport(taskId, body, changedFiles) {
    return this.request('POST', `/api/agent/tasks/${taskId}/report`, { body, changedFiles });
  }

  addComment(taskId, body) {
    return this.request('POST', `/api/agent/tasks/${taskId}/comments`, { body });
  }

  checkDod(taskId, itemId, evidence) {
    return this.request('PATCH', `/api/agent/tasks/${taskId}/dod/${itemId}/check`, { evidence });
  }
}
