import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, resolveSessionToken } from '@/server/kernel/sessions';

export const dynamic = 'force-dynamic';

/** 已登录 → 看板；未登录 → 登录页。 */
export default async function Home() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const member = await resolveSessionToken(token);
  redirect(member ? '/board' : '/login');
}
