import { Controller, Get, Query } from '@nestjs/common';
import { ThreadsService } from './threads.service';

@Controller('threads')
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  /**
   * GET /threads/search?q=韓國代購&type=RECENT&limit=25
   * 예: http://localhost:3000/threads/search?q=韓國代購
   */
  @Get('search')
  async search(
    @Query('q') q: string,
    @Query('type') type?: 'TOP' | 'RECENT',
    @Query('limit') limit?: string,
  ) {
    const posts = await this.threads.searchKeyword({
      q,
      searchType: type ?? 'RECENT',
      limit: limit ? Number(limit) : 25,
    });

    // 리드 발굴에 핵심인 필드만 추려서 보기 좋게 반환
    return {
      keyword: q,
      count: posts.length,
      posts: posts.map((p) => ({
        username: p.username,
        text: p.text,
        media_type: p.media_type,
        permalink: p.permalink,
        timestamp: p.timestamp,
      })),
    };
  }
}
