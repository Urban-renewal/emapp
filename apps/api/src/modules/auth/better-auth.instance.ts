import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  baAccount,
  baInvitation,
  baMember,
  baOrganization,
  baSession,
  baUser,
  baVerification,
  db,
} from '@emapp/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';

export const auth = betterAuth({
  secret: serverEnv.BETTER_AUTH_SECRET,
  advanced: { database: { generateId: () => randomUUID() } },
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: baUser,
      session: baSession,
      account: baAccount,
      verification: baVerification,
      organization: baOrganization,
      member: baMember,
      invitation: baInvitation,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
    }),
  ],
  session: {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
});

export type Auth = typeof auth;
