import { Controller, Get, Param, Query } from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { SheetsService } from '../sheets/sheets.service';

@Controller('instagram')
export class InstagramController {
  constructor(
    private readonly ig: InstagramService,
    private readonly sheets: SheetsService,
  ) {}

  /**
   * GET /instagram/sync-sheet?limit=25 — report 데이터를 구글시트에 upsert (덮어쓰기/최신값)
   * limit=0 이면 전체 글. 담당자 칸은 보존됨.
   */
  @Get('sync-sheet')
  async syncSheet(@Query('limit') limit?: string) {
    const report = await this.ig.getSheetReport(limit ? Number(limit) : 25);
    // 지표만 갱신, 제목주제(VLM 결과)는 보존
    const result = await this.sheets.upsertReport(report.rows, { skipTitle: true });
    return { ok: true, ...result, total: report.rows.length };
  }

  /**
   * GET /instagram/analyze-titles?limit=30 — VLM 으로 제목주제 생성 후 시트에 upsert.
   * 사진+캡션(해시태그) 기반. 사용 모델은 사이드카의 VL_MODEL 환경변수로 결정.
   * ⚠️ 사이드카(vl_server.py)가 켜져 있어야 함.
   *
   * 기본은 "이미 분석된 글(제목주제 칸이 차 있음)은 건너뛰고" 새 글만 VLM 실행.
   * force=1 이면 전부 다시 분석. upsert 라 수동 칸(담당자/메모)/줄 위치는 보존됨.
   */
  @Get('analyze-titles')
  async analyzeTitles(@Query('limit') limit?: string, @Query('force') force?: string) {
    const n = limit ? Number(limit) : 30;
    const existing = force === '1' ? new Map<string, string>() : await this.sheets.getExistingTitles();
    const report = await this.ig.getSheetReport(n, true, existing);
    const skipped = report.rows.filter((r) => existing.has(String(r.permalink))).length;
    const result = await this.sheets.upsertReport(report.rows);
    return {
      ok: true,
      model: process.env.VL_MODEL || 'lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit',
      analyzed: report.rows.length - skipped,
      skipped,
      ...result,
    };
  }

  /** GET /instagram/media?limit=25 — 본인 게시글 목록 (좋아요/댓글만) */
  @Get('media')
  async media(@Query('limit') limit?: string) {
    const posts = await this.ig.getMedia(limit ? Number(limit) : 25);
    return { count: posts.length, posts };
  }

  /**
   * GET /instagram/feed?limit=25 — 게시글 + 인사이트(조회수 등) 한 번에, 조회수 높은 순
   */
  @Get('feed')
  async feed(@Query('limit') limit?: string) {
    const posts = await this.ig.getMediaWithInsights(limit ? Number(limit) : 25);
    return {
      count: posts.length,
      posts: posts.map((p) => ({
        permalink: p.permalink,
        timestamp: p.timestamp,
        media_type: p.media_type,
        views: p.insights?.views ?? null,
        reach: p.insights?.reach ?? null,
        likes: p.like_count,
        comments: p.comments_count,
        saved: p.insights?.saved ?? null,
        shares: p.insights?.shares ?? null,
        caption: p.caption?.slice(0, 60),
      })),
    };
  }

  /**
   * GET /instagram/all?limit=25 — 전부 한 방에 (JSON)
   * 계정 프로필 + 각 글(조회수/도달/저장/공유 + 좋아요/댓글수 + 댓글 목록), 조회수순.
   */
  @Get('all')
  async all(@Query('limit') limit?: string) {
    const report = await this.ig.getFullReport(limit ? Number(limit) : 25);
    return {
      profile: report.profile,
      count: report.posts.length,
      posts: report.posts.map((p) => ({
        permalink: p.permalink,
        timestamp: p.timestamp,
        media_type: p.media_type,
        caption: p.caption,
        views: p.insights?.views ?? null,
        reach: p.insights?.reach ?? null,
        likes: p.like_count,
        comments_count: p.comments_count,
        saved: p.insights?.saved ?? null,
        shares: p.insights?.shares ?? null,
        comments: p.comments.map((c) => ({
          username: c.username,
          text: c.text,
          like_count: c.like_count,
        })),
      })),
    };
  }

  /**
   * GET /instagram/report?limit=25 — 시트 양식 그대로 JSON
   * 컬럼: 게시일/담당자/콘텐츠유형/제목주제/도달/노출/좋아요/댓글/저장/공유/참여율/팔로워증감/프로필방문/링크클릭
   */
  @Get('report')
  async report(@Query('limit') limit?: string) {
    return this.ig.getSheetReport(limit ? Number(limit) : 25);
  }

  /** GET /instagram/media/:id/insights — 게시글 1건 인사이트 */
  @Get('media/:id/insights')
  async mediaInsights(@Param('id') id: string) {
    return { mediaId: id, insights: await this.ig.getMediaInsights(id) };
  }

  /** GET /instagram/insights — 계정 단위 인사이트 */
  @Get('insights')
  async accountInsights() {
    return { insights: await this.ig.getAccountInsights() };
  }
}
