import { redirect } from 'next/navigation';

import { getMe } from '@/lib/auth';

import { AuthGuard } from './_components/auth-guard';
import { QueryProvider } from './_components/query-provider';
import { Sidebar } from './_components/sidebar';
import { Topbar } from './_components/topbar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getMe();
  if (!user) redirect('/login');

  return (
    <QueryProvider>
      <div className="flex h-screen flex-col">
        <Topbar user={user} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar role={user.role} />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
        <AuthGuard />
      </div>
    </QueryProvider>
  );
}
