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

/** Provider Admin login — MFA mandatory (TOTP 6 digits or recovery code). */
export const ProviderLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfa_code: z.string().min(6).max(64),
});
export type ProviderLoginDto = z.infer<typeof ProviderLoginSchema>;

/** Tenant OTP request (D.20). Phone normalized/validated server-side. */
export const OtpRequestSchema = z.object({
  phone: z.string().min(9).max(20),
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

/** Tenant OTP verify — 6-digit single-use code. */
export const OtpVerifySchema = z.object({
  phone: z.string().min(9).max(20),
  code: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;
