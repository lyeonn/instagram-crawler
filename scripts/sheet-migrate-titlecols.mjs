// 일회성 마이그레이션: test 탭에 [링크 / 제목주제 대만 / 제목주제 한국] 3열 구조 적용.
//
// 변경 전: E = "게시물 제목 / 주제" (한국어 데이터가 들어있음)
// 변경 후: E = 링크(🔗) | F = 게시물 제목 / 주제 대만(빈칸) | G = 게시물 제목 / 주제 한국(기존값 이동)
//   → E 위치에 2열 삽입 → 기존 E(한국어)가 G로 밀리고 새 E/F 생성. permalink 숨김키 Z→AB.
//   → 상단 배너 병합(B2:Q2 등)이 고정경계를 가로질러 copyPaste 불가 →
//     제목열(G) 서식을 읽어 repeatCell 로 F(+E)에 복제한다 (병합 검사 없이 서식만).
//
// 실행: node scripts/sheet-migrate-titlecols.mjs   (test 탭에서만 동작)
import 'dotenv/config';
import { google } from 'googleapis';
import { readFileSync } from 'node:fs';

const spreadsheetId = process.env.GSHEET_ID;
const tab = process.env.GSHEET_TAB || '인스타';
const HEADER_ROW = 6, BAND_ROW = 7, DATA_START = 8;
const creds = JSON.parse(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

if (!tab.includes('test')) {
  console.error(`중단: GSHEET_TAB='${tab}' — test 탭이 아니라 실행 안 함.`);
  process.exit(1);
}

const meta = await sheets.spreadsheets.get({
  spreadsheetId, fields: 'sheets.properties(sheetId,title,gridProperties)',
});
const sh = meta.data.sheets.find((s) => s.properties.title === tab);
if (!sh) { console.error(`탭 '${tab}' 없음`); process.exit(1); }
const sheetId = sh.properties.sheetId;
const rowCount = sh.properties.gridProperties.rowCount;

// 멱등성: 이미 마이그레이션됐으면 중단
const hdr = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A${HEADER_ROW}:H${HEADER_ROW}` });
const hdrCells = (hdr.data.values?.[0] ?? []).map((c) => String(c).replace(/\s/g, ''));
if (hdrCells.some((c) => c.includes('대만') || c.includes('한국'))) {
  console.error('중단: 이미 대만/한국 헤더가 있음 (재실행 방지).');
  process.exit(1);
}
console.log(`대상 탭: ${tab} (gid=${sheetId}, rows=${rowCount})`);
console.log('현재 헤더:', hdrCells.join(' | '));

// ── 1) E 위치에 2열 삽입 (앞열 D 서식 상속) ─────────────────────
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      { insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 6 }, inheritFromBefore: true } },
    ],
  },
});
console.log('✓ 2열 삽입 (E=신규, F=신규, 옛 제목열 → G)');

// ── 2) 헤더 텍스트 즉시 기록 (재실행 방지용 마커 겸용) ───────────
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId,
  requestBody: {
    valueInputOption: 'RAW',
    data: [
      { range: `${tab}!E${HEADER_ROW}`, values: [['링크']] },
      { range: `${tab}!F${HEADER_ROW}`, values: [['게시물 제목 / 주제 대만']] },
      { range: `${tab}!G${HEADER_ROW}`, values: [['게시물 제목 / 주제 한국']] },
      { range: `${tab}!E${BAND_ROW}`, values: [['기본']] },
      { range: `${tab}!F${BAND_ROW}`, values: [['기본']] },
    ],
  },
});
console.log('✓ 헤더 텍스트 (E=링크, F=대만, G=한국)');

// ── 3) 제목열(G) 서식을 읽어 F·E 에 복제 (repeatCell) ───────────
const fmtRes = await sheets.spreadsheets.get({
  spreadsheetId,
  ranges: [`${tab}!G${HEADER_ROW}`, `${tab}!G${BAND_ROW}`, `${tab}!G${DATA_START}`],
  fields: 'sheets.data.rowData.values.userEnteredFormat',
  includeGridData: true,
});
const cellFmt = (di) => fmtRes.data.sheets[0].data[di]?.rowData?.[0]?.values?.[0]?.userEnteredFormat ?? {};
const fHeader = cellFmt(0), fBand = cellFmt(1), fData = cellFmt(2);
const rc = (fmt, r0, r1, c0) => ({
  repeatCell: {
    range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c0 + 1 },
    cell: { userEnteredFormat: fmt },
    fields: 'userEnteredFormat',
  },
});
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      // F(대만): 제목열과 완전히 동일한 서식
      rc(fHeader, HEADER_ROW - 1, HEADER_ROW, 5),
      rc(fBand, BAND_ROW - 1, BAND_ROW, 5),
      rc(fData, DATA_START - 1, rowCount, 5),
      // E(링크): 제목열 서식 기반 + 폭 좁게 + 가운데 정렬
      rc(fHeader, HEADER_ROW - 1, HEADER_ROW, 4),
      rc(fBand, BAND_ROW - 1, BAND_ROW, 4),
      rc(fData, DATA_START - 1, rowCount, 4),
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 54 }, fields: 'pixelSize' } },
      { repeatCell: { range: { sheetId, startRowIndex: DATA_START - 1, endRowIndex: rowCount, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } }, fields: 'userEnteredFormat.horizontalAlignment' } },
      // 삽입 시 앞열 D(콘텐츠유형)의 드롭다운(데이터검증)까지 상속되므로 E·F·G 에서 제거
      // (데이터검증은 userEnteredFormat 이 아니라 별도 필드라 위 서식복사로는 안 지워짐)
      { setDataValidation: { range: { sheetId, startRowIndex: DATA_START - 1, endRowIndex: rowCount, startColumnIndex: 4, endColumnIndex: 7 } } },
    ],
  },
});
console.log('✓ 서식 복제 (F=제목과 동일) + 링크열 폭54·가운데정렬');

// ── 4) 🔗 백필: AB열 permalink → E열 HYPERLINK ─────────────────
const keys = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!AB${DATA_START}:AB${rowCount}` });
const perma = keys.data.values ?? [];
const linkData = [];
perma.forEach((row, i) => {
  const url = row?.[0];
  if (url && String(url).startsWith('http')) {
    linkData.push({ range: `${tab}!E${DATA_START + i}`, values: [[`=HYPERLINK("${url}","🔗")`]] });
  }
});
if (linkData.length) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption: 'USER_ENTERED', data: linkData },
  });
}
console.log(`✓ 🔗 링크 백필: ${linkData.length}행`);
console.log('\n완료. E=🔗링크 | F=제목/주제 대만(빈칸) | G=제목/주제 한국(기존값) | permalink=AB');
