import { Injectable, Logger } from '@nestjs/common';

// Instagram API with Instagram Login (graph.instagram.com) 기준.
// 본인 비즈니스/크리에이터 계정의 게시글 + 인사이트 조회.
// 필요 권한: instagram_business_basic, instagram_business_manage_insights

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type?: string; // FEED | REELS
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  media_url?: string; // 사진/캐러셀 첫 이미지, 영상은 mp4
  thumbnail_url?: string; // 영상/릴스 썸네일 이미지
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);
  private readonly base = 'https://graph.instagram.com/v23.0';

  private get token(): string {
    const t = process.env.INSTAGRAM_ACCESS_TOKEN;
    if (!t) {
      throw new Error(
        'INSTAGRAM_ACCESS_TOKEN is not set. .env 에 인스타 토큰을 넣어라.',
      );
    }
    return t;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const query = new URLSearchParams({ ...params, access_token: this.token });
    const url = `${this.base}/${path}?${query.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`IG API ${res.status}: ${body}`);
      throw new Error(`Instagram API error ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /**
   * 본인 계정 게시글 목록 (좋아요/댓글 수 포함).
   * limit 만큼 모일 때까지 페이지(최대 100개씩)를 따라가며 수집.
   * limit <= 0 이면 전체 글을 다 가져온다.
   */
  async getMedia(limit = 25): Promise<IgMedia[]> {
    const fields =
      'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count,media_url,thumbnail_url';
    const all = limit <= 0;
    const out: IgMedia[] = [];
    // 첫 페이지 URL
    let url: string | null =
      `${this.base}/me/media?` +
      new URLSearchParams({
        fields,
        limit: String(all ? 100 : Math.min(limit, 100)),
        access_token: this.token,
      }).toString();

    const MAX_PAGES = 100; // 안전장치 (최대 1만 글)
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`IG API ${res.status}: ${body}`);
        throw new Error(`Instagram API error ${res.status}`);
      }
      const json = (await res.json()) as {
        data?: IgMedia[];
        paging?: { next?: string };
      };
      out.push(...(json.data ?? []));
      if (!all && out.length >= limit) break;
      url = json.paging?.next ?? null;
    }

    const result = all ? out : out.slice(0, limit);
    this.logger.log(`me/media -> ${result.length} posts`);
    return result;
  }

  // 시트용 확장 메트릭(프로필방문/팔로우 포함) / 실패 시 폴백할 핵심 메트릭
  private static readonly EXTENDED_METRICS =
    'reach,views,likes,comments,saved,shares,total_interactions,profile_visits,follows';
  private static readonly CORE_METRICS =
    'reach,views,likes,comments,saved,shares,total_interactions';

  /** 게시글 1건의 인사이트 (조회수/도달/저장/공유 등) — 원본 배열 형태 */
  async getMediaInsights(
    mediaId: string,
    metric = InstagramService.CORE_METRICS,
  ): Promise<unknown> {
    const json = await this.get<{ data?: unknown[] }>(`${mediaId}/insights`, {
      metric,
    });
    return json.data ?? [];
  }

  /** 확장 메트릭 시도 -> 실패하면 핵심 메트릭으로 폴백, 평탄화해서 반환 */
  private async getInsightsResilient(
    mediaId: string,
  ): Promise<Record<string, number> | null> {
    const flatten = (raw: unknown) =>
      this.flattenInsights(
        raw as Array<{ name: string; values?: Array<{ value: number }> }>,
      );
    try {
      return flatten(
        await this.getMediaInsights(mediaId, InstagramService.EXTENDED_METRICS),
      );
    } catch {
      try {
        return flatten(
          await this.getMediaInsights(mediaId, InstagramService.CORE_METRICS),
        );
      } catch {
        this.logger.warn(`insights 실패: ${mediaId}`);
        return null;
      }
    }
  }

  /** 인사이트 배열 -> { reach: 0, views: 800, ... } 평탄화 */
  private flattenInsights(
    raw: Array<{ name: string; values?: Array<{ value: number }> }>,
  ): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of raw) out[m.name] = m.values?.[0]?.value ?? 0;
    return out;
  }

  /**
   * 게시글 목록 + 각 글 인사이트를 한 번에 합쳐서 반환.
   * 조회수(views) 높은 순으로 정렬. 인사이트 조회 실패한 글은 insights=null 로 둠.
   */
  async getMediaWithInsights(
    limit = 25,
  ): Promise<Array<IgMedia & { insights: Record<string, number> | null }>> {
    const media = await this.getMedia(limit);
    const merged = await Promise.all(
      media.map(async (m) => {
        try {
          const raw = (await this.getMediaInsights(m.id)) as Array<{
            name: string;
            values?: Array<{ value: number }>;
          }>;
          return { ...m, insights: this.flattenInsights(raw) };
        } catch {
          // 타입상 특정 metric 미지원 등으로 실패하면 그 글은 인사이트 없이 통과
          this.logger.warn(`insights 실패: ${m.id}`);
          return { ...m, insights: null };
        }
      }),
    );
    merged.sort((a, b) => (b.insights?.views ?? 0) - (a.insights?.views ?? 0));
    return merged;
  }

  /** 계정 단위 인사이트 (도달/프로필방문 등) */
  async getAccountInsights(): Promise<unknown> {
    const json = await this.get<{ data?: unknown[] }>('me/insights', {
      metric: 'reach,profile_views,follower_count',
      period: 'day',
      metric_type: 'total_value',
    });
    return json.data ?? [];
  }

  /** 계정 프로필 (팔로워 수, 글 수 등) */
  async getProfile(): Promise<Record<string, unknown>> {
    return this.get('me', {
      fields:
        'id,username,account_type,media_count,followers_count,follows_count',
    });
  }

  /** 게시글 1건의 댓글 (작성자/내용/좋아요) — 리드 발굴용 */
  async getComments(
    mediaId: string,
  ): Promise<Array<{ username?: string; text?: string; timestamp?: string; like_count?: number }>> {
    const json = await this.get<{ data?: any[] }>(`${mediaId}/comments`, {
      fields: 'text,username,timestamp,like_count',
    });
    return json.data ?? [];
  }

  /**
   * 통합 리포트: 계정 프로필 + 각 글(인사이트 + 댓글)을 한 번에.
   * 조회수 높은 순 정렬. 글별 인사이트/댓글은 실패해도 전체는 살린다.
   */
  async getFullReport(limit = 25): Promise<{
    profile: Record<string, unknown>;
    posts: Array<
      IgMedia & {
        insights: Record<string, number> | null;
        comments: Array<{ username?: string; text?: string; like_count?: number }>;
      }
    >;
  }> {
    const [profile, media] = await Promise.all([
      this.getProfile().catch(() => ({}) as Record<string, unknown>),
      this.getMedia(limit),
    ]);

    const posts = await Promise.all(
      media.map(async (m) => {
        const [insights, comments] = await Promise.all([
          this.getInsightsResilient(m.id),
          this.getComments(m.id).catch(() => {
            this.logger.warn(`comments 실패: ${m.id}`);
            return [];
          }),
        ]);
        return { ...m, insights, comments };
      }),
    );

    posts.sort((a, b) => (b.insights?.views ?? 0) - (a.insights?.views ?? 0));
    return { profile, posts };
  }

  /**
   * VLM 사이드카 호출: 사진 + 캡션 -> 한국어 제목.
   * 사이드카(VL_SERVICE_URL, 기본 localhost:8088)가 꺼져있거나 실패하면 null.
   */
  async analyzeTitle(imageUrl?: string | null, caption?: string): Promise<string | null> {
    if (!imageUrl) return null;
    const base = process.env.VL_SERVICE_URL || 'http://127.0.0.1:8088';
    try {
      const res = await fetch(`${base}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image_url: imageUrl, caption: caption ?? '' }),
      });
      if (!res.ok) {
        this.logger.warn(`VLM 사이드카 ${res.status}`);
        return null;
      }
      const j = (await res.json()) as { title_ko?: string };
      return j.title_ko?.trim() || null;
    } catch (e) {
      this.logger.warn(`VLM 사이드카 연결 실패: ${(e as Error).message}`);
      return null;
    }
  }

  /** 캡션 -> 짧은 제목 (첫 줄, 해시태그 줄 제외, 40자까지) */
  private toTitle(caption?: string): string | null {
    if (!caption) return null;
    const firstLine =
      caption
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#')) ?? caption.trim();
    return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
  }

  /** 대표 이미지 URL: 영상/릴스는 썸네일, 그 외(사진/캐러셀 첫장)는 media_url */
  imageUrlOf(m: IgMedia): string | null {
    if (m.media_type === 'VIDEO' || m.thumbnail_url) {
      return m.thumbnail_url ?? m.media_url ?? null;
    }
    return m.media_url ?? null;
  }

  /** 인스타 미디어 타입 -> 시트 드롭다운 값(피드 이미지/카드뉴스/릴스) */
  private toKoreanType(m: IgMedia): string {
    if (m.media_product_type === 'REELS' || m.media_type === 'VIDEO') return '릴스';
    if (m.media_type === 'CAROUSEL_ALBUM') return '카드뉴스';
    return '피드 이미지'; // IMAGE 및 그 외
  }

  /**
   * 시트 양식(컬럼 순서)에 맞춘 리포트 행 배열.
   * 게시일/담당자/콘텐츠유형/제목/도달/노출/좋아요/댓글/저장/공유/참여율/팔로워증감/프로필방문/링크클릭
   */
  /**
   * 게시물의 제목주제 결정.
   * 이미 분석된 글(existingTitles 에 값 있음)은 VLM 재호출 없이 기존 값 재사용.
   */
  private async resolveTitle(
    m: IgMedia,
    useVlm: boolean,
    existingTitles?: Map<string, string>,
  ): Promise<string | null> {
    const prev = m.permalink ? existingTitles?.get(m.permalink) : undefined;
    if (prev) return prev; // 이미 분석됨 → 재분석 스킵
    if (useVlm) {
      return (await this.analyzeTitle(this.imageUrlOf(m), m.caption)) ?? this.toTitle(m.caption);
    }
    return this.toTitle(m.caption);
  }

  async getSheetReport(
    limit = 25,
    useVlm = false,
    existingTitles?: Map<string, string>,
  ): Promise<{
    account: { username?: unknown; followers?: unknown; mediaCount?: unknown };
    rows: Array<Record<string, unknown>>;
  }> {
    const [profile, media] = await Promise.all([
      this.getProfile().catch(() => ({}) as Record<string, unknown>),
      this.getMedia(limit),
    ]);

    const rows = await Promise.all(
      media.map(async (m) => {
        const i = await this.getInsightsResilient(m.id);
        const reach = i?.reach ?? 0;
        const interactions =
          (m.like_count ?? 0) +
          (m.comments_count ?? 0) +
          (i?.saved ?? 0) +
          (i?.shares ?? 0);
        // 참여율 = 반응 / 도달 (도달 0이면 노출 기준, 둘 다 0이면 null)
        const denom = reach || i?.views || 0;
        const engagementRate = denom
          ? Number(((interactions / denom) * 100).toFixed(2))
          : null;
        return {
          게시일: m.timestamp,
          담당자: null, // API 제공 안 됨 — 수동 입력
          콘텐츠유형: this.toKoreanType(m),
          제목주제: await this.resolveTitle(m, useVlm, existingTitles),
          도달: i?.reach ?? null,
          노출: i?.views ?? null,
          좋아요: m.like_count ?? null,
          댓글: m.comments_count ?? null,
          저장: i?.saved ?? null,
          공유: i?.shares ?? null,
          참여율: engagementRate,
          팔로워증감: i?.follows ?? null, // 이 글로 생긴 팔로우
          프로필방문: i?.profile_visits ?? null,
          링크클릭: null, // 글별 링크클릭은 API 미제공 (계정 단위만)
          imageUrl: this.imageUrlOf(m),
          permalink: m.permalink,
        };
      }),
    );

    return {
      account: {
        username: profile.username,
        followers: profile.followers_count,
        mediaCount: profile.media_count,
      },
      rows,
    };
  }
}
