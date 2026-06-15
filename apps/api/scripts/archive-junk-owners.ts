/**
 * Dev maintenance — archive TEST-JUNK owners polluting the demo org.
 *
 * The audit e2e specs (apps/web/e2e/audit/layer2-flows, layer5-security) run
 * against the real dev backend as manager and create owners named
 * `audit-owner-<ts>` / `<…>-api`, plus security probes leave bidi-spoof names
 * containing `.exe`. With no per-run cleanup these accumulate and make the
 * owners list look unprofessional (the owner's "אוסף של שמות" complaint).
 *
 * This archives them via the REAL audited DELETE /owners/:id (SOFT archive —
 * reversible, sets archived_at; never a hard delete) using a normal manager
 * session, so RLS + audit hold. SAFE: dry-run by DEFAULT (prints what it would
 * archive); pass `--apply` to actually archive. Pattern-scoped to unambiguous
 * test names so a real owner is never touched.
 *
 * Run (API must be up on :3000):
 *   pnpm --filter @emapp/api exec tsx scripts/archive-junk-owners.ts          # dry-run
 *   pnpm --filter @emapp/api exec tsx scripts/archive-junk-owners.ts --apply  # archive
 */
const API = process.env['API_URL'] ?? 'http://localhost:3000';
const EMAIL = process.env['DEV_MANAGER_EMAIL'] ?? 'manager@alpha.dev';
const PASSWORD = process.env['DEV_MANAGER_PASSWORD'] ?? 'DevPassword123!';
const APPLY = process.argv.includes('--apply');

/** Unambiguous test-junk name patterns. A real owner name never matches these. */
const JUNK = [/^audit-owner-\d+(-api)?$/i, /\.exe(\b|$)/i, /^audit-viewer-/i];

// stdout/stderr writers — a CLI script must print; `console` is lint-banned.
const out = (s = ''): void => void process.stdout.write(`${s}\n`);
const errOut = (s = ''): void => void process.stderr.write(`${s}\n`);

interface OwnerRow {
  id: string;
  name: string | null;
}

function isJunk(name: string | null): boolean {
  if (!name) return false;
  return JUNK.some((re) => re.test(name));
}

async function main(): Promise<void> {
  // Cookie jar — capture Set-Cookie from login, replay on every call.
  let cookie = '';
  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no auth cookie from login');

  // Paginate the owners list (manager sees decrypted names).
  const junk: OwnerRow[] = [];
  let total = 0;
  let cursor: string | null = null;
  do {
    const qs = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(`${API}/api/v1/owners?${qs}`, { headers: { cookie } });
    if (!res.ok) throw new Error(`list owners failed: ${res.status}`);
    const body = (await res.json()) as {
      data: OwnerRow[];
      page: { cursor: string | null; has_more: boolean };
    };
    total += body.data.length;
    for (const o of body.data) if (isJunk(o.name)) junk.push({ id: o.id, name: o.name });
    cursor = body.page.has_more ? body.page.cursor : null;
  } while (cursor);

  out(`scanned ${total} active owners — ${junk.length} match a test-junk pattern:`);
  for (const o of junk) out(`  ${o.id}  ${JSON.stringify(o.name)}`);

  if (!APPLY) {
    out(`\nDRY-RUN. Re-run with --apply to soft-archive these ${junk.length} owners.`);
    return;
  }

  let archived = 0;
  for (const o of junk) {
    const res = await fetch(`${API}/api/v1/owners/${o.id}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    if (res.ok || res.status === 204) archived += 1;
    else errOut(`  archive FAILED ${o.id}: ${res.status}`);
  }
  out(`\narchived ${archived}/${junk.length} test-junk owners (soft; reversible).`);
}

main().catch((e) => {
  errOut(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
