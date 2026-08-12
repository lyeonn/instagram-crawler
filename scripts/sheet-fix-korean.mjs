// 한국(G) 칸에 한자가 남은 행만 골라, 대만(F, 번체)을 /translate 로 재번역해서 G만 갱신.
// 대만(F) 칸은 건드리지 않는다.
//   node scripts/sheet-fix-korean.mjs        # 실제 반영
//   node scripts/sheet-fix-korean.mjs --dry  # 미리보기(기록 안 함)
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const VL = process.env.VL_SERVICE_URL || 'http://127.0.0.1:8088';
const id = process.env.GSHEET_ID, tab = process.env.GSHEET_TAB;
const DATA_START = 8;
const HAN = /[㐀-鿿]/;
const LEAK = /한국어로만|한국어 제목만|남기지 마|옮겨라|번체중문|다시 써라|①|②|실패다/;
const bad = (ko) => HAN.test(ko) || LEAK.test(ko);

const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const sheets = google.sheets({ version: 'v4', auth });

const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `${tab}!F${DATA_START}:G` });
const fg = r.data.values ?? [];

// 한국(G)에 한자 남은 행만
const targets = [];
fg.forEach((x, i) => {
  const zh = (x[0] || '').trim(), ko = (x[1] || '').trim();
  if (zh && bad(ko)) targets.push({ row: DATA_START + i, zh, ko });
});
console.log(`한자 잔존 ${targets.length}행 재번역` + (DRY ? ' (dry-run)' : ''));

async function translate(text) {
  const res = await fetch(`${VL}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!res.ok) throw new Error(`translate ${res.status}`);
  return (await res.json()).title_ko || '';
}

const updates = [];
let fixed = 0, still = 0;
for (const t of targets) {
  let ko = '';
  try { ko = (await translate(t.zh)).trim(); } catch (e) { console.log(`  ${t.row}: 오류 ${e.message}`); continue; }
  const ok = ko && !bad(ko);
  if (ok) fixed++; else still++;
  console.log(`  ${t.row}: ${ok ? '✅' : '△남음'} [${t.ko.slice(0, 16)}] → [${ko.slice(0, 22)}]`);
  if (ko) updates.push({ range: `${tab}!G${t.row}`, values: [[ko]] });
}

if (!DRY && updates.length) {
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: id, requestBody: { valueInputOption: 'USER_ENTERED', data: updates } });
}
console.log(`\n완료: 깨끗이 정리 ${fixed} / 한자 일부 잔존 ${still}` + (DRY ? ' (dry-run, 기록 안 함)' : ` / ${updates.length}행 기록`));
