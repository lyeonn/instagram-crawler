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
    const result = await this.sheets.upsertReport(report.rows);
    return { ok: true, ...result, total: report.rows.length };
  }

  /**
   * GET /instagram/analyze-titles?limit=30 — VLM(Gemma-26B)으로 제목주제 생성 후
   * 시트를 "전체 삭제 → 30개 새로 기록". 사진+캡션(해시태그) 기반.
   * ⚠️ 사이드카(vl_server.py)가 켜져 있어야 함. 수동 칸(담당자/메모)은 지워짐.
   */
  @Get('analyze-titles')
  async analyzeTitles(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 30;
    const report = await this.ig.getSheetReport(n, true);
    const result = await this.sheets.replaceReport(report.rows);
    return { ok: true, model: 'Gemma-26B (VLM)', ...result };
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
