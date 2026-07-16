import { Injectable, Logger } from '@nestjs/common';
import { google, sheets_v4 } from 'googleapis';
import { readFileSync } from 'node:fs';

// report 의 한 행(객체)
export type ReportRow = Record<string, unknown>;

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private _sheets?: sheets_v4.Sheets;
  private _sheetId?: number;

  // 보고서 양식 컬럼 매핑. 담당자(C)/메모(P)/No.(A) 는 안 건드림(수동).
  // D(콘텐츠유형)=드롭다운 매핑, E(제목주제)=캡션 앞부분 자동 기록.
  private readonly map: Record<string, string> = {
    B: '게시일',
    D: '콘텐츠유형',
    E: '제목주제',
    F: '도달',
    G: '노출',
    H: '좋아요',
    I: '댓글',
    J: '저장',
    K: '공유',
    L: '참여율',
    M: '팔로워증감',
    N: '프로필방문',
    O: '링크클릭',
  };

  private get spreadsheetId(): string {
    const id = process.env.GSHEET_ID;
    if (!id) throw new Error('GSHEET_ID 가 .env 에 없다.');
    return id;
  }
  private get tab(): string {
    return process.env.GSHEET_TAB || '인스타';
  }
  private get startRow(): number {
    return Number(process.env.GSHEET_DATA_START_ROW || 8);
  }
  private get keyCol(): string {
    return (process.env.GSHEET_KEY_COL || 'Z').toUpperCase();
  }
  /** 제목주제가 기록되는 열 (map 에서 역으로 찾음, 기본 E) */
  private get titleCol(): string {
    return Object.keys(this.map).find((c) => this.map[c] === '제목주제') ?? 'E';
  }

  private get sheets(): sheets_v4.Sheets {
    if (this._sheets) return this._sheets;
    const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
    const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!file && !inline) {
      throw new Error(
        'GOOGLE_SERVICE_ACCOUNT_FILE(경로) 또는 GOOGLE_SERVICE_ACCOUNT_JSON 이 .env 에 필요하다.',
      );
    }
    const credentials = inline
      ? JSON.parse(inline)
      : JSON.parse(readFileSync(file as string, 'utf8'));
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this._sheets = google.sheets({ version: 'v4', auth });
    return this._sheets;
  }

  /** 탭 이름 -> 시트 gid (정렬 API 에 필요, 1회 조회 후 캐시) */
  private async getSheetId(): Promise<number> {
    if (this._sheetId != null) return this._sheetId;
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets.properties(sheetId,title)',
    });
    const sh = meta.data.sheets?.find((s) => s.properties?.title === this.tab);
    if (sh?.properties?.sheetId == null) throw new Error(`탭 '${this.tab}' 을 찾을 수 없다.`);
    this._sheetId = sh.properties.sheetId;
    return this._sheetId;
  }

  /** 데이터 영역(start행~)을 게시일(B열) 내림차순 정렬 — 최신 글이 맨 위로. */
  async sortByDateDesc(): Promise<void> {
    const sheetId = await this.getSheetId();
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            sortRange: {
              range: {
                sheetId,
                startRowIndex: this.startRow - 1, // 0-indexed, 헤더 제외
                startColumnIndex: 0,
                endColumnIndex: 26, // A:Z (수동칸·키열 포함해 행째로 이동)
              },
              sortSpecs: [{ dimensionIndex: 1, sortOrder: 'DESCENDING' }], // B=게시일
            },
          },
        ],
      },
    });
  }

  // USER_ENTERED 로 기록 → 날짜/퍼센트가 셀 서식대로 해석됨
  private toCell(col: string, r: ReportRow): string | number {
    const v = r[this.map[col]];
    if (v == null) return '';
    if (col === 'B') return String(v).slice(0, 10); // 게시일 -> YYYY-MM-DD
    if (col === 'L') return `${v}%`; // 참여율 -> "16.84%" (셀이 알아서 % 처리)
    return v as number;
  }

  /**
   * 이미 시트에 기록된 permalink -> 제목주제 맵.
   * VLM 재분석을 건너뛸 판단에 쓴다 (제목주제 칸이 이미 차 있으면 그 글은 분석 완료로 간주).
   */
  async getExistingTitles(): Promise<Map<string, string>> {
    const start = this.startRow;
    const res = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: [
        `${this.tab}!${this.keyCol}${start}:${this.keyCol}`, // 키(permalink)
        `${this.tab}!${this.titleCol}${start}:${this.titleCol}`, // 제목주제
      ],
    });
    const keys = res.data.valueRanges?.[0]?.values ?? [];
    const titles = res.data.valueRanges?.[1]?.values ?? [];
    const out = new Map<string, string>();
    keys.forEach((row, i) => {
      const link = row?.[0];
      const title = titles[i]?.[0];
      if (link && title && String(title).trim()) {
        out.set(String(link), String(title).trim());
      }
    });
    return out;
  }

  /**
   * 보고서 양식에 맞춰 upsert.
   * - permalink(숨김 키 열 R) 로 기존 줄 매칭 → 숫자 칸만 최신값 갱신 (줄 위치/수동칸/서식 보존)
   * - 신규 글은 마지막 줄 뒤에 추가 (담당자/유형/제목/메모는 빈칸)
   */
  async upsertReport(
    rows: ReportRow[],
    opts: { skipTitle?: boolean } = {},
  ): Promise<{ updated: number; added: number }> {
    const start = this.startRow;

    // 키 열(permalink) 읽어서 줄 매핑
    const keyRes = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!${this.keyCol}${start}:${this.keyCol}`,
    });
    const keyVals = keyRes.data.values ?? [];
    const rowOf = new Map<string, number>();
    let lastRow = start - 1;
    keyVals.forEach((row, i) => {
      const link = row[0];
      if (link) {
        rowOf.set(link, start + i);
        lastRow = Math.max(lastRow, start + i);
      }
    });

    const data: sheets_v4.Schema$ValueRange[] = [];
    let updated = 0;
    let added = 0;

    for (const r of rows) {
      const link = String(r.permalink ?? '');
      if (!link) continue;
      let rowNum = rowOf.get(link);
      if (rowNum) {
        updated++;
      } else {
        rowNum = ++lastRow;
        rowOf.set(link, rowNum);
        added++;
        data.push({ range: `${this.tab}!${this.keyCol}${rowNum}`, values: [[link]] });
      }
      for (const col of Object.keys(this.map)) {
        // 지표 동기화(skipTitle)는 제목주제 칸을 건드리지 않는다 (VLM 결과 보존)
        if (opts.skipTitle && col === this.titleCol) continue;
        data.push({ range: `${this.tab}!${col}${rowNum}`, values: [[this.toCell(col, r)]] });
      }
    }

    if (data.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }

    // 신규 글이 맨 아래 붙으므로, 갱신 후 게시일 내림차순으로 재정렬 (최신이 위)
    if (added > 0) await this.sortByDateDesc();

    this.logger.log(
      `시트 동기화: 갱신 ${updated} / 신규 ${added}${opts.skipTitle ? ' (제목 보존)' : ''}`,
    );
    return { updated, added };
  }

  /**
   * 기존 데이터를 전부 지우고 rows 를 처음부터 다시 쓴다 (덮어쓰기 아님, 완전 교체).
   * ⚠️ 데이터 영역(start행 이후 A:Z)을 통째로 비우므로 담당자/메모 같은 수동 칸도 사라짐.
   */
  async replaceReport(rows: ReportRow[]): Promise<{ written: number }> {
    const start = this.startRow;
    // 1) 데이터 영역 전체 비우기 (서식은 유지, 값만 삭제)
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${start}:Z`,
    });
    // 2) 처음부터 새로 기록
    const data: sheets_v4.Schema$ValueRange[] = [];
    rows.forEach((r, i) => {
      const rowNum = start + i;
      data.push({
        range: `${this.tab}!${this.keyCol}${rowNum}`,
        values: [[String(r.permalink ?? '')]],
      });
      for (const col of Object.keys(this.map)) {
        data.push({ range: `${this.tab}!${col}${rowNum}`, values: [[this.toCell(col, r)]] });
      }
    });
    if (data.length) {
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }
    this.logger.log(`시트 전체 교체: ${rows.length}행 기록`);
    return { written: rows.length };
  }
}
