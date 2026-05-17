/**
 * One-time bootstrap script to create the first Provider Admin account.
 * Requires: providerDb (available after P1.13), bcryptjs, otplib.
 *
 * Usage:
 *   BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
 *   BOOTSTRAP_ADMIN_PASSWORD=<strong-password> \
 *   infisical run --env=dev -- tsx scripts/bootstrap-provider-admin.ts
 *
 * This script is intentionally not implemented until P1.13 (providerDb exists).
 */
throw new Error(
  'bootstrap-provider-admin.ts requires providerDb from P1.13. Run after P1.13 is implemented.',
);
