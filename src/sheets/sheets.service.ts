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

  // 보고서 양식 컬럼 매핑. No.(A)/담당자(C)/그 외 수동칸(R 이후)은 안 건드림.
  // D(콘텐츠유형)=드롭다운, E(링크)=🔗 하이퍼링크, F/G(제목주제 대만/한국)=VLM 결과.
  private readonly map: Record<string, string> = {
    B: '게시일',
    D: '콘텐츠유형',
    E: '링크', // permalink 로부터 =HYPERLINK(...,"🔗") 생성
    F: '제목주제_대만', // 번체(대만) 요약
    G: '제목주제_한국', // 한국어 요약
    H: '도달',
    I: '노출',
    J: '좋아요',
    K: '댓글',
    L: '저장',
    M: '공유',
    N: '참여율',
    O: '팔로워증감',
    P: '프로필방문',
    Q: '링크클릭',
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
    // permalink 숨김 키. 링크·제목(대만/한국) 2열 삽입으로 Z→AB 로 이동.
    return (process.env.GSHEET_KEY_COL || 'AB').toUpperCase();
  }
  /** VLM 결과가 기록되는 제목주제 열(대만·한국) — 지표 동기화 시 보존 대상 */
  private get titleCols(): string[] {
    return Object.keys(this.map).filter((c) => this.map[c].startsWith('제목주제'));
  }
  /** '분석 완료' 판단 기준 열 = 한국어 제목주제 (기본 G) */
  private get titleColKo(): string {
    return Object.keys(this.map).find((c) => this.map[c] === '제목주제_한국') ?? 'G';
  }
  /** 대만어 제목주제 열 (기본 F) */
  private get titleColZh(): string {
    return Object.keys(this.map).find((c) => this.map[c] === '제목주제_대만') ?? 'F';
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
                endColumnIndex: 28, // A:AB (수동칸·키열 포함해 행째로 이동)
              },
              sortSpecs: [{ dimensionIndex: 1, sortOrder: 'DESCENDING' }], // B=게시일
            },
          },
        ],
      },
    });
  }

  // USER_ENTERED 로 기록 → 날짜/퍼센트/수식이 셀 서식대로 해석됨
  private toCell(col: string, r: ReportRow): string | number {
    const field = this.map[col];
    // 링크: permalink 로부터 클릭 가능한 🔗 하이퍼링크 생성
    if (field === '링크') {
      const url = String(r.permalink ?? '');
      return url ? `=HYPERLINK("${url}","🔗")` : '';
    }
    const v = r[field];
    if (v == null) return '';
    if (field === '게시일') return String(v).slice(0, 10); // -> YYYY-MM-DD
    if (field === '참여율') return `${v}%`; // -> "16.84%" (셀이 알아서 % 처리)
    return v as number;
  }

  /**
   * 이미 시트에 기록된 permalink -> { 한국(ko), 대만(zh) } 맵.
   * 한국어 제목주제 칸이 차 있으면 그 글은 '분석 완료'로 간주해 VLM 재분석을 건너뛴다.
   * (재분석 스킵 시 대만/한국 기존값을 그대로 되써서 보존하려고 둘 다 읽어둔다.)
   */
  async getExistingTitles(): Promise<
    Map<string, { ko: string | null; zh: string | null }>
  > {
    const start = this.startRow;
    const res = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: this.spreadsheetId,
      ranges: [
        `${this.tab}!${this.keyCol}${start}:${this.keyCol}`, // 키(permalink)
        `${this.tab}!${this.titleColKo}${start}:${this.titleColKo}`, // 한국
        `${this.tab}!${this.titleColZh}${start}:${this.titleColZh}`, // 대만
      ],
    });
    const keys = res.data.valueRanges?.[0]?.values ?? [];
    const kos = res.data.valueRanges?.[1]?.values ?? [];
    const zhs = res.data.valueRanges?.[2]?.values ?? [];
    const out = new Map<string, { ko: string | null; zh: string | null }>();
    keys.forEach((row, i) => {
      const link = row?.[0];
      const ko = kos[i]?.[0];
      if (link && ko && String(ko).trim()) {
        const zh = zhs[i]?.[0];
        out.set(String(link), {
          ko: String(ko).trim(),
          zh: zh && String(zh).trim() ? String(zh).trim() : null,
        });
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
        // 지표 동기화(skipTitle)는 제목주제(대만·한국) 칸을 건드리지 않는다 (VLM 결과 보존)
        if (opts.skipTitle && this.titleCols.includes(col)) continue;
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
      range: `${this.tab}!A${start}:AB`,
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
