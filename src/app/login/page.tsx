import { enabledLoginProviders, isDevProviderEnabled } from '@/plugins/auth/plugin';
import DevLoginForm from './dev-login-form';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  const providers = enabledLoginProviders();
  const devEnabled = isDevProviderEnabled();

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">登录</h1>
        <p className="mt-1 text-sm text-neutral-500">首次登录将自动创建成员；首位登录者成为组织管理员。</p>
      </div>

      {devEnabled && <DevLoginForm />}

      {!devEnabled && providers.length === 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          当前没有可用的登录方式：开发登录已关闭，飞书扫码尚未配置。请联系管理员或在环境变量中启用。
        </p>
      )}
    </main>
  );
}
