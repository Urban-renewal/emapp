// Live proof: manager Dana creates+sends an SR in Trial; resident signs;
// Dana's in-app bell increments with a signature_received notification.
const API = 'http://localhost:3000/api/v1';
function jar() {
  const c = {};
  return {
    cap(r) { for (const s of (r.headers.getSetCookie?.() || [])) { const [kv] = s.split(';'); const i = kv.indexOf('='); c[kv.slice(0, i)] = kv.slice(i + 1); } },
    h() { return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}
async function rq(m, p, cookie, body) {
  const h = { 'Content-Type': 'application/json', 'x-throttle-bypass': 'contract-suite' };
  if (cookie) h.Cookie = cookie;
  const r = await fetch(API + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { }
  return { s: r.status, t, j };
}
function vid(seed) { const e = String(seed % 100000000).padStart(8, '0'); let s = 0; for (let i = 0; i < 8; i++) { let d = +e[i]; if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2; s += d; } return e + String((10 - s % 10) % 10); }

const out = {};
const j = jar();
const lg = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-throttle-bypass': 'contract-suite' }, body: JSON.stringify({ email: 'dana@trial.dev', password: 'DevPassword123!' }) });
j.cap(lg); const C = j.h();
out.login = lg.status;
out.unreadBefore = (await rq('GET', '/notifications/unread-count', C)).j?.data?.count;

const rnd = Math.floor(Math.random() * 1e9);
const doc = await rq('POST', '/documents', C, { name: 'הסכם-חתימה-לייב.pdf', type: 'contract', mimeType: 'application/pdf', sizeBytes: 2048, contentHash: 'sha256:live-' + rnd });
const docId = doc.j?.data?.document?.id; out.doc = doc.s;
const own = await rq('POST', '/owners', C, { name: 'נועה גרין', national_id: vid(70000000 + (rnd % 9000000)), phone: '0541234567', email: 'noa@trial.dev' });
const ownerId = own.j?.data?.id; out.owner = own.s;
const sr = await rq('POST', '/signature-requests', C, { documentId: docId, ownerId });
out.sr = sr.s; const token = sr.j?.data?.signUrl ? sr.j.data.signUrl.split('/sign/')[1] : null; out.gotToken = !!token;

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M10 10 L50 25 L90 10" stroke="black" fill="none"/></svg>';
out.sign = (await rq('POST', '/sign/' + token, null, { signatureSvg: svg })).s;

out.unreadAfter = (await rq('GET', '/notifications/unread-count', C)).j?.data?.count;
const list = await rq('GET', '/notifications?limit=5', C);
const note = (list.j?.data || []).find((n) => n.type === 'signature_received');
out.notification = note ? { type: note.type, title: note.title, body: note.body, metadata: note.metadata } : 'NONE';
console.log(JSON.stringify(out, null, 1));
