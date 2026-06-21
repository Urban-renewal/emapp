/* TEMP — replicate the EXACT otp.service.request() flow with per-step logging
 * to find where the challenge insert is lost. Uses production db + hashField. */
import { and, eq, gt, sql } from 'drizzle-orm';

import { closeAllPools, db, env, hashField, otpCodes, owners, organizations } from '@emapp/db';

const RL_WINDOW_MS = 15 * 60 * 1000;
const RL_MAX = 3;

// Inlined (NOT imported from @emapp/validators) — this dev-QA script lives in
// packages/db whose tsconfig rootDir forbids cross-package source imports.
function normalizeIsraeliPhone(input: string): string | null {
  const cleaned = input.replace(/[\s\-().]/g, '');
  const digits = cleaned.startsWith('+972') ? cleaned.slice(4)
    : cleaned.startsWith('972') ? cleaned.slice(3)
    : cleaned.startsWith('0') ? cleaned.slice(1) : null;
  return digits && /^\d{9}$/.test(digits) ? `+972${digits}` : null;
}

async function main() {
  const phone = normalizeIsraeliPhone('0501234567');
  console.log('[1] normalized phone =', phone);
  if (!phone) return;
  const phoneHash = hashField(phone, env.PII_HASH_KEY as string);
  console.log('[2] phoneHash (12) =', phoneHash.slice(0, 12));

  await db.execute(sql`DELETE FROM otp_codes WHERE phone_hash = ${phoneHash}`);
  console.log('[3] cleared otp_codes for phone');

  const rl = await db.select({ n: sql<number>`count(*)::int` }).from(otpCodes).where(
    and(eq(otpCodes.phoneHash, phoneHash), gt(otpCodes.createdAt, new Date(Date.now() - RL_WINDOW_MS))),
  );
  console.log('[4] rate-limit count =', rl[0]?.n, '(>= ' + RL_MAX + '? ' + ((rl[0]?.n ?? 0) >= RL_MAX) + ')');

  const matched = await db
    .select({ id: owners.id, orgId: owners.orgId })
    .from(owners)
    .innerJoin(organizations, eq(organizations.id, owners.orgId))
    .where(and(eq(owners.phoneHash, phoneHash), eq(organizations.slug, 'alpha-dev')))
    .limit(1);
  console.log('[5] owner lookup matched =', matched.length, matched[0] ? `id=${matched[0].id.slice(0, 8)} org=${matched[0].orgId.slice(0, 8)}` : '(NONE)');
  if (!matched[0]) { console.log('[5!] NO OWNER → request would silently no-op. THIS is the 401 root cause.'); return; }

  try {
    const ins = await db.insert(otpCodes).values({
      phoneHash,
      codeHash: hashField('123456', env.PII_HASH_KEY as string),
      ownerId: matched[0].id,
      orgId: matched[0].orgId,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    }).returning({ id: otpCodes.id });
    console.log('[6] INSERT ok, challenge id =', ins[0]?.id?.slice(0, 8));
  } catch (e) {
    console.log('[6!] INSERT THREW:', (e as Error).message);
  }

  const after = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM otp_codes WHERE phone_hash = ${phoneHash}`);
  console.log('[7] otp_codes rows now =', after.rows[0]?.n);
}
main().then(closeAllPools).then(() => process.exit(0)).catch(async (e) => { console.error('FATAL', e); await closeAllPools(); process.exit(1); });
