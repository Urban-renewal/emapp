import { z } from 'zod';

// Pure Zod DTO (no Nest/runtime imports) so the API-docs generator
// (Doc 09 §1.4) can source it without booting the controller/env.
export const ProviderLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfa_code: z.string().min(6).max(64), // TOTP (6 digits) or recovery code
});

export type ProviderLoginDto = z.infer<typeof ProviderLoginSchema>;
