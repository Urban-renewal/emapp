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

// ───────────────────────────────────────────────────────────────────
// D.46 — Agent capability matrix. A per-AGENT curated set of 6 toggles
// (JSONB, D.17), MANAGER-controlled, enforced SERVER-SIDE in the
// services (the coarse AuthorizationGuard is role-only and cannot see
// these). Base (always on once a project is assigned): view assigned
// project data. Managers implicitly hold ALL capabilities; viewers hold
// none (they are read-only). Defaults: everything OFF except
// `view_owners` (ON, PII masked per D.47).
//
// NOTE (enforcement status — updated 2026-06-06; the old "only edit_project_data
// is wired" canary is OBSOLETE): 6 of 7 capabilities are now ENFORCED at the
// service layer via `requireAgentCapability`/`agentHasCapability`:
//   • edit_project_data — buildings + apartments writes
//   • manage_documents  — documents writes/finalize
//   • manage_signatures — signature-request writes
//   • manage_tasks      — task writes
//   • run_imports       — import start/mapping/confirm
//   • view_owners       — owner reads (OwnersService.assertAgentCanViewOwners)
// The 7th, `view_owner_pii`, gates PII FIDELITY (unmasked vs masked) on owner
// read / reveal-pii / signed-document via `resolveOwnerPiiFidelity`. A stored
// `true` now actually grants the scoped capability — it is NO LONGER inert.
// ───────────────────────────────────────────────────────────────────
export const AGENT_CAPABILITY_KEYS = [
  'edit_project_data',
  'manage_documents',
  'manage_signatures',
  'manage_tasks',
  'run_imports',
  'view_owners',
  'view_owner_pii',
] as const;
export type AgentCapabilityKey = (typeof AGENT_CAPABILITY_KEYS)[number];

export const AgentCapabilitiesSchema = z
  .object({
    /** edit buildings / apartments / owners (ENFORCED for buildings+apartments). */
    edit_project_data: z.boolean(),
    manage_documents: z.boolean(),
    manage_signatures: z.boolean(),
    manage_tasks: z.boolean(),
    run_imports: z.boolean(),
    /** view owners AT ALL (default ON; scoped to assigned projects, D.54).
     *  OFF → the agent sees no owners. */
    view_owners: z.boolean(),
    /** D.54 — read PII fidelity: when ON the agent sees UNMASKED national_id /
     *  phone (field staff who must verify identity); default OFF = masked.
     *  Applies uniformly to list / detail / edit / export via one resolver. */
    view_owner_pii: z.boolean(),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = {
  edit_project_data: false,
  manage_documents: false,
  manage_signatures: false,
  manage_tasks: false,
  run_imports: false,
  view_owners: true,
  // D.54 — masked by default (least-privilege); manager grants unmasked.
  view_owner_pii: false,
};

/** PATCH /members/:userId/capabilities — manager toggles a SUBSET; merged
 *  onto the stored set. At least one key required. */
export const UpdateAgentCapabilitiesInput = AgentCapabilitiesSchema.partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, {
    message: 'at least one capability must be provided',
  });
export type UpdateAgentCapabilities = z.infer<typeof UpdateAgentCapabilitiesInput>;

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
  // D.46 — the agent capability set (managers/viewers carry the stored
  // default; only agents' flags are meaningful for enforcement). OPTIONAL in
  // the wire contract for add-only cross-track safety (existing consumers /
  // fixtures predate it); the BE ALWAYS populates it on every Member response.
  capabilities: AgentCapabilitiesSchema.optional(),
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
