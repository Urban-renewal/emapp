import { z } from 'zod';

// Canonical Member (org membership) contract (Doc 11 SoT; Phase 3
// Slice C — closes the ISO A.9 runtime-enforcement gap: lets a Manager
// provision Agent/Viewer/Manager users so D.17 deny is provable
// end-to-end). Roles = the locked Tier-1 set (D.17). Member creation is
// an invite: a user row (no password) + membership (acceptedAt=null) is
// created atomically; the invitee sets their OWN password via
// /auth/accept-invite (industry standard — the inviter never knows it,
// ISO A.9.2.1/A.9.4.3). Email delivery (Resend) is deferred & recorded;
// the one-time invite token is returned by the create call meanwhile.

export const OrgRoleEnum = z.enum(['manager', 'agent', 'viewer']);
export type OrgRole = z.infer<typeof OrgRoleEnum>;

export const MemberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: OrgRoleEnum,
  isPrimary: z.boolean(),
  invitedBy: z.string().uuid().nullable(),
  acceptedAt: z.coerce.date().nullable(), // null ⇒ invite pending
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type Member = z.infer<typeof MemberSchema>;

/** POST /members — invite a user into the caller's org with a role. */
export const CreateMemberInput = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
    role: OrgRoleEnum,
  })
  .strict();
export type CreateMember = z.infer<typeof CreateMemberInput>;

/** PATCH /members/:userId — change a member's role. */
export const UpdateMemberInput = z.object({ role: OrgRoleEnum }).strict();
export type UpdateMember = z.infer<typeof UpdateMemberInput>;

/** POST /auth/accept-invite — invitee sets their own password. Public. */
export const AcceptInviteInput = z
  .object({
    token: z.string().min(10).max(4096),
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(256, 'Password must be at most 256 characters'),
  })
  .strict();
export type AcceptInvite = z.infer<typeof AcceptInviteInput>;

export const ListMembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListMembersQueryDto = z.infer<typeof ListMembersQuery>;
