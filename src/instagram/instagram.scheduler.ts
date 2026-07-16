import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InstagramService } from './instagram.service';
import { SheetsService } from '../sheets/sheets.service';

@Injectable()
export class InstagramScheduler {
  private readonly logger = new Logger(InstagramScheduler.name);

  constructor(
    private readonly ig: InstagramService,
    private readonly sheets: SheetsService,
  ) {}

  // 매일 자정(00:00, 서버 시간대 기준)에 시트 자동 동기화
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async syncDaily() {
    const limit = Number(process.env.GSHEET_SYNC_LIMIT || 100);
    this.logger.log(`[자정 동기화] 시작 (최근 ${limit}개)`);
    try {
      const report = await this.ig.getSheetReport(limit);
      // 지표만 갱신하고 제목주제(VLM 결과)는 건드리지 않는다
      const result = await this.sheets.upsertReport(report.rows, { skipTitle: true });
      this.logger.log(
        `[자정 동기화] 완료 — 갱신 ${result.updated} / 신규 ${result.added}`,
      );
    } catch (e) {
      this.logger.error(`[자정 동기화] 실패: ${(e as Error).message}`);
    }
  }
}
