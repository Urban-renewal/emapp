/**
 * PURE dev-auth-bypass gate — no env / no imports, so the security guard spec
 * (`dev-auth-bypass.spec.ts`) can prove every combination with zero setup.
 *
 * The bypass is an AUTH BYPASS, so it must be provably impossible in prod:
 * it requires NODE_ENV==='development' AND an explicit DEV_AUTH_BYPASS==='1'.
 * The explicit flag is the real guard (NODE_ENV defaults to 'development' in
 * config; prod never sets DEV_AUTH_BYPASS).
 */

/** The only code the bypass accepts. Never a real credential. */
export const DEV_FIXED_AUTH_CODE = '000000';

/** Pure gate — true only for the exact dev combination. */
export function computeDevAuthBypass(
  nodeEnv: string | undefined,
  flag: string | undefined,
): boolean {
  return nodeEnv === 'development' && flag === '1';
}
