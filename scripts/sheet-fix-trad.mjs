// 대만(F) 칸에 한글이 섞인 행만 골라, /to-trad 로 번체로 변환해 F만 갱신.
// 한국(G)은 건드리지 않는다 (이미 올바른 한국어).
//   node scripts/sheet-fix-trad.mjs        # 반영
//   node scripts/sheet-fix-trad.mjs --dry  # 미리보기
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const VL = process.env.VL_SERVICE_URL || 'http://127.0.0.1:8088';
const id = process.env.GSHEET_ID, tab = process.env.GSHEET_TAB;
const DATA_START = 8;
const HANGUL = /[가-힣]/;

const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${tab}!F${DATA_START}:F` });
const col = r.data.values ?? [];
const targets = [];
col.forEach((x, i) => { const f = (x[0] || '').trim(); if (f && HANGUL.test(f)) targets.push({ row: DATA_START + i, f }); });
console.log(`대만 칸 한글 섞인 ${targets.length}행 → 번체 변환` + (DRY ? ' (dry-run)' : ''));

async function toTrad(text) {
  const res = await fetch(`${VL}/to-trad`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`to-trad ${res.status}`);
  return (await res.json()).title_zh || '';
}

const updates = [];
let ok = 0, still = 0;
for (const t of targets) {
  let zh = '';
  try { zh = (await toTrad(t.f)).trim(); } catch (e) { console.log(`  ${t.row}: 오류 ${e.message}`); continue; }
  const good = zh && !HANGUL.test(zh);
  if (good) ok++; else still++;
  console.log(`  ${t.row}: ${good ? '✅' : '△남음'} [${t.f.slice(0, 20)}] → [${zh.slice(0, 24)}]`);
  if (zh) updates.push({ range: `${tab}!F${t.row}`, values: [[zh]] });
}
if (!DRY && updates.length) {
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'USER_ENTERED', data: updates } });
}
console.log(`\n완료: 번체 변환 ${ok} / 한글 잔존 ${still}` + (DRY ? ' (기록 안 함)' : ` / ${updates.length}행 기록`));
