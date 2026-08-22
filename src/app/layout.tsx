import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent 任务看板',
  description: '人机协作任务看板：成员建任务，Agent 认领执行，成员验收',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
