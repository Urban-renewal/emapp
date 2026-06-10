import { z } from 'zod';

// Canonical auth request contracts (Doc 11 source of truth). BE DTOs
// re-export these; FE imports the same. Schemas are byte-equivalent to the
// originals so the gen-api-docs §1.4 gate stays stable.

/** Self-serve signup: org + first manager. Password is length-only (Doc07 §6.3 / NIST). */
export const SignupSchema = z.object({
  org_name: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(256, 'Password must be at most 256 characters'),
});
export type SignupDto = z.infer<typeof SignupSchema>;

/** Org-user password login. */
export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginDto = z.infer<typeof LoginSchema>;

/** Switch the active org (must be an active membership). */
export const OrgSwitchSchema = z.object({
  org_id: z.string().uuid(),
});
export type OrgSwitchDto = z.infer<typeof OrgSwitchSchema>;

/**
 * P1 R0.1 — Self-service password reset (OWASP Forgot-Password).
 *
 * Request a reset link. ALWAYS answered with a generic 200 (anti-enumeration,
 * D.14 posture — never reveals whether the email exists). Email-shape only;
 * no password here.
 */
export const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordSchema>;

/**
 * Consume a reset token + set a new password. The token is the raw value from
 * the emailed link; the server looks it up by its SHA-256 hash. `newPassword`
 * enforces the SAME policy as signup (length-only, Doc07 §6.3 / NIST: min 12,
 * max 256). On success the BE purges ALL the user's active sessions.
 */
export const ResetPasswordSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(256, 'Password must be at most 256 characters'),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordSchema>;

/** Provider Admin login — MFA mandatory (TOTP 6 digits or recovery code). */
export const ProviderLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfa_code: z.string().min(6).max(64),
});
export type ProviderLoginDto = z.infer<typeof ProviderLoginSchema>;

/** Tenant OTP request (D.20).
 * Phone normalized/validated server-side.
 *
 * F2 (audit-pass III, D.30) — optional `org_slug` disambiguates a phone
 * that is a legitimate owner in MULTIPLE orgs (docs/01 §5.3: a resident
 * can own apartments in different developers' projects). Without it the
 * historical code picked an arbitrary owner and the Tenant ended up
 * authed to a wrong org. With it the caller pins the org. If the slug
 * is absent and >1 owners match, the service returns the same generic
 * no-op as the unknown-phone path (anti-enumeration preserved). The
 * Phase-5 FE link is per-project, so it can always supply the slug. */
export const OtpRequestSchema = z.object({
  phone: z.string().min(9).max(20),
  org_slug: z.string().min(1).max(100).optional(),
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

/** Tenant OTP verify — 6-digit single-use code. */
export const OtpVerifySchema = z.object({
  phone: z.string().min(9).max(20),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;

/** GET /api/v1/me response body. Mirrors `UserProfile` in
 *  apps/api/src/modules/auth/auth.service.ts:37 (verbatim shape).
 *  Org `slug` is the public URL-safe identifier (D.31 G1a) — zero PII.
 *  FE imports this and `.parse()`s the proxied `{ data: ... }` response
 *  (Phase 4a S1). */
export const UserProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.string().min(1),
  avatarColor: z.string().nullable(),
  organization: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    slug: z.string().min(1),
  }),
  /**
   * D2-DEF-3 / D.54 — whether THIS actor may reveal owner PII (cleartext
   * national_id/phone): manager always, agent iff the `view_owner_pii`
   * capability is granted, viewer never. UX-only (the BE reveal endpoint is
   * the authority); the owner "Reveal PII" button is offered only when this
   * is true. OPTIONAL (add-only) — populated by `GET /me`; absent on an
   * older producer is treated as "not granted" (safe default).
   */
  view_owner_pii: z.boolean().optional(),
  /**
   * IAM slice 4 — the actor's EXACT effective permission-set on the active
   * org scope, resolved live by the enterprise-IAM engine (covering
   * `role_assignments`, implication closure expanded). Each entry is a
   * catalog permission string (e.g. `projects.read`). ADDITIVE / non-gating:
   * `GET /me` now returns it, but NOTHING gates on it yet — the FE cutover is
   * slice 5; `policy.ts` + the guards remain the live enforcer. OPTIONAL
   * (add-only) — absent on an older producer is treated as "no extra grants",
   * the safe default. Same add-only pattern as `view_owner_pii` (D2-DEF-3).
   */
  permissions: z.array(z.string()).optional(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/** GET /api/v1/provider/me response body — V10-S1 closure (H1
 *  Provider FE topology fix). Provider Admin self-identity for the
 *  `provider/layout.tsx` server-side role gate.
 *
 *  Tier-isolated by design: `role` is a literal `'provider_admin'` —
 *  matches `DB_TO_JWT_ROLE` in provider-auth.service.ts (Audit v1.1
 *  SA-3). Adding new provider roles (e.g. `provider_viewer`) is a
 *  Gate-6 / D.NN decision that requires extending this literal
 *  alongside the policy + guard surfaces.
 *
 *  Deliberately narrower than UserProfile: no org (Provider is
 *  cross-tenant; no single org context), no avatar (Provider tier
 *  is operational, not branded). Internal columns (passwordHash,
 *  mfaSecretEncrypted, recoveryCodesHash, failedLoginCount,
 *  lockedUntil, lastLoginAt, disabledAt) MUST NEVER appear in this
 *  shape — the BE's column allowlist enforces it. */
export const ProviderProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  role: z.literal('provider_admin'),
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;
