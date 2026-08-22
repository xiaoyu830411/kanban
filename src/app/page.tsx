import { cookies } from 'next/headers';
import Link from 'next/link';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Agent 任务看板</h1>
      <p className="text-neutral-600">人机协作任务看板：成员建任务，Agent 认领执行，成员验收。</p>
      {member ? (
        <p className="text-sm text-neutral-500">
          已登录：<span className="font-medium text-neutral-800">{member.name}</span>
          （{member.role === 'admin' ? '管理员' : '成员'}）
        </p>
      ) : (
        <Link
          href="/login"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
        >
          登录
        </Link>
      )}
    </main>
  );
}
