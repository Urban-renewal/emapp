'use server';

import { cookies } from 'next/headers';

const API_BASE = process.env['API_URL'] ?? 'http://localhost:3000';

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarColor: string | null;
  organization: { id: string; name: string };
}

export async function getMe(): Promise<UserProfile | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE}/api/v1/me`, {
      headers: { Cookie: `access_token=${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: UserProfile };
    return body.data;
  } catch {
    return null;
  }
}
