import { redirect } from 'next/navigation';

import { getMe } from '@/lib/auth';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getMe();

  if (!user) {
    redirect('/login');
  }

  return <>{children}</>;
}
