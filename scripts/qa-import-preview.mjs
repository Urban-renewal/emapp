// E2E: import preview→confirm. requireConfirm import must PAUSE at
// awaiting_confirm (nothing persisted), then PERSIST after POST /confirm.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const require = createRequire(import.meta.url);
const ExcelJS = require('C:/emapp/node_modules/.pnpm/exceljs@4.4.0/node_modules/exceljs/excel.js');
const API = 'http://localhost:3000/api/v1';
const PROJ = '72d1f4b1-b84c-4831-9a4b-f3bd983702a5';
const israeliId = (b8) => { let s = 0; for (let i = 0; i < 8; i++) { let d = +b8[i] * ((i % 2) + 1); if (d > 9) d -= 9; s += d; } return b8 + ((10 - (s % 10)) % 10); };
function jar() { const c = {}; return { cap(r) { for (const s of (r.headers.getSetCookie?.() || [])) { const [kv] = s.split(';'); const i = kv.indexOf('='); c[kv.slice(0, i)] = kv.slice(i + 1); } }, h() { return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '); } }; }
async function req(method, path, { body, cookie, raw, headers = {} } = {}) {
  const h = { ...headers, 'x-throttle-bypass': 'contract-suite' }; if (!raw) h['Content-Type'] = 'application/json'; if (cookie) h.Cookie = cookie;
  const res = await fetch(API + path, { method, headers: h, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json };
}
const out = {};
// unique new owners so we can detect persistence
const seed = 30000000 + Math.floor(Math.random() * 9000000);
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('owners');
ws.addRow(['national_id', 'phone', 'name', 'apartment_number', 'building_address', 'ownership_pct']);
ws.addRow([israeliId(String(seed).padStart(8, '0')), '+972539911111', 'פרבי טסט', '7', 'הרצל 10', 100]);
ws.addRow([israeliId(String(seed + 1).padStart(8, '0')), '+972539911112', 'גמא טסט', '8', 'הרצל 10', 100]);
const buf = Buffer.from(await wb.xlsx.writeBuffer());
const size = buf.byteLength; const hash = crypto.createHash('sha256').update(buf).digest('hex');

const j = jar();
const lg = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-throttle-bypass': 'contract-suite' }, body: JSON.stringify({ email: 'dana@trial.dev', password: 'DevPassword123!' }) });
j.cap(lg); const cookie = j.h();
const ownersBefore = (await req('GET', '/owners', { cookie })).json?.data?.length ?? -1;
out.ownersBefore = ownersBefore;

// 1) create WITH requireConfirm
const cr = await req('POST', '/imports', { cookie, body: { projectId: PROJ, fileName: 'preview-test.xlsx', fileSizeBytes: size, fileContentHash: hash, requireConfirm: true } });
const importId = cr.json?.data?.import?.id; const uploadUrl = cr.json?.data?.uploadUrl;
out.create = { status: cr.status, id: importId, requireConfirm: cr.json?.data?.import?.requireConfirm };
if (uploadUrl) { const pr = await fetch(uploadUrl, { method: 'PUT', body: buf, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }); out.uploadR2 = pr.status; }
await req('POST', `/imports/${importId}/start`, { cookie, body: {} });

// 2) poll until awaiting_confirm (or terminal). If mapping needed, submit it.
let mapped = false, st = '';
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 1200));
  const s = await req('GET', `/imports/${importId}`, { cookie }); st = s.json?.data?.status;
  if (!mapped && (st === 'awaiting_mapping')) {
    await req('POST', `/imports/${importId}/mapping`, { cookie, body: { columns: { national_id: 0, phone: 1, name: 2, apartment_number: 3, building_address: 4, ownership_pct: 5 } } });
    mapped = true; continue;
  }
  if (['awaiting_confirm', 'done', 'failed', 'cancelled'].includes(st)) break;
}
out.statusAfterValidate = st;
out.ownersAfterPause = (await req('GET', '/owners', { cookie })).json?.data?.length ?? -1;
out.pausedWithoutPersist = (st === 'awaiting_confirm') && (out.ownersAfterPause === ownersBefore);

// 3) confirm → persist
if (st === 'awaiting_confirm') {
  const cf = await req('POST', `/imports/${importId}/confirm`, { cookie });
  out.confirm = cf.status;
  let st2 = '';
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const s = await req('GET', `/imports/${importId}`, { cookie }); st2 = s.json?.data?.status;
    if (['done', 'failed', 'cancelled'].includes(st2)) break;
  }
  out.statusAfterConfirm = st2;
  out.ownersAfterConfirm = (await req('GET', '/owners', { cookie })).json?.data?.length ?? -1;
  out.persistedAfterConfirm = (st2 === 'done') && (out.ownersAfterConfirm > ownersBefore);
}
console.log(JSON.stringify(out, null, 1));
