import { Injectable, Logger } from '@nestjs/common';

export interface ThreadsPost {
  id: string;
  text?: string;
  media_type?: 'TEXT' | 'IMAGE' | 'VIDEO' | string;
  permalink?: string;
  timestamp?: string;
  username?: string;
  has_replies?: boolean;
  is_quote_post?: boolean;
  is_reply?: boolean;
}

export interface SearchParams {
  q: string;
  searchType?: 'TOP' | 'RECENT';
  limit?: number;
  mediaType?: 'TEXT' | 'IMAGE' | 'VIDEO';
}

@Injectable()
export class ThreadsService {
  private readonly logger = new Logger(ThreadsService.name);
  private readonly baseUrl = 'https://graph.threads.net/v1.0/keyword_search';

  private get token(): string {
    const t = process.env.THREADS_ACCESS_TOKEN;
    if (!t) {
      throw new Error(
        'THREADS_ACCESS_TOKEN is not set. Copy .env.example to .env and fill it in.',
      );
    }
    return t;
  }

  async searchKeyword(params: SearchParams): Promise<ThreadsPost[]> {
    const query = new URLSearchParams({
      q: params.q,
      // RECENT = 최신 글 위주. 리드 발굴엔 보통 RECENT가 더 유용.
      search_type: params.searchType ?? 'RECENT',
      fields:
        'id,text,media_type,permalink,timestamp,username,has_replies,is_quote_post,is_reply',
      limit: String(params.limit ?? 25),
      access_token: this.token,
    });
    if (params.mediaType) query.set('media_type', params.mediaType);

    const url = `${this.baseUrl}?${query.toString()}`;
    const res = await fetch(url, { method: 'GET' });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`Threads API ${res.status}: ${body}`);
      throw new Error(`Threads API error ${res.status}`);
    }

    const json = (await res.json()) as { data?: ThreadsPost[] };
    const posts = json.data ?? [];
    this.logger.log(`"${params.q}" -> ${posts.length} posts`);
    return posts;
  }
}
