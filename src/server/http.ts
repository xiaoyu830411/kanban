import { NextResponse } from 'next/server';
import type { Agent, Member } from '@/db/schema';
import { resolveAgentByToken } from './kernel/agents';
import { ProtocolError } from './kernel/protocol';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  resolveSessionToken,
} from './kernel/sessions';

export { ProtocolError as ApiError };

export async function handleRoute(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ProtocolError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    console.error('[api] unhandled error:', error);
    return NextResponse.json(
      { error: { code: 'internal_error', message: 'internal server error' } },
      { status: 500 },
    );
  }
}

/** 解析请求 JSON 体；空体返回 {}。 */
export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ProtocolError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

// ---- 会话 cookie（成员侧） ----

export function sessionCookieHeader(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookieHeader(): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

export function readSessionCookie(request: Request): string | undefined {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=');
  }
  return undefined;
}

/** 成员守卫：会话缺失/无效 → 401 协议错误。只认 cookie，不认 Bearer。 */
export async function requireMember(request: Request): Promise<Member> {
  const member = await resolveSessionToken(readSessionCookie(request));
  if (!member) {
    throw new ProtocolError(401, 'unauthorized', 'member session required');
  }
  return member;
}

/** Agent 守卫：Bearer token 鉴权（与成员会话不混用）。 */
export async function requireAgent(request: Request): Promise<Agent> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new ProtocolError(
      401,
      'agent_auth_required',
      'Authorization: Bearer <agent token> required',
    );
  }
  const agent = await resolveAgentByToken(header.slice('Bearer '.length).trim());
  if (!agent) {
    throw new ProtocolError(401, 'agent_auth_required', 'invalid agent token');
  }
  return agent;
}
