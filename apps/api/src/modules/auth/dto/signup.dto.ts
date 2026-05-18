import { z } from 'zod';

export const SignupSchema = z.object({
  org_name: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  // Doc07 §6.3 (NIST 2020): length-only, NO composition rules. Upper bound
  // only to bound argon2 cost (DoS), not a complexity rule.
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .max(256, 'Password must be at most 256 characters'),
});

export type SignupDto = z.infer<typeof SignupSchema>;
