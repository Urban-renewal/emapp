import type { UserProfile } from '@emapp/shared-types';

/** SAMPLE_USERS — single Manager that matches `seed-dev.ts` org Alpha. */
export const SAMPLE_USERS: UserProfile[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'מיכל מנהלת',
    email: 'manager@alpha.dev',
    role: 'manager',
    avatarColor: '#0f766e',
    organization: {
      id: '22222222-2222-2222-2222-222222222222',
      name: 'Alpha',
      slug: 'alpha-dev',
    },
  },
];

export const SAMPLE_ME: UserProfile = SAMPLE_USERS[0]!;
