# VEASLY — Threads 키워드 검색 (NestJS)

리드 발굴 엔진의 데이터 입구. Threads 공식 키워드 검색 API를 호출해서
구매 의도 게시글 후보를 가져온다.

## 0. 미리 알아둘 점
- **대만 타겟은 키워드 언어로 한다.** 지역 파라미터가 없으므로 `q`에
  번체중문(예: `韓國代購`, `開團`, `求代購`)을 넣어 대만 사용자 글을 잡는다.
- **권한 승인 전에는 본인 글만 검색된다.** 모르는 사람들 글을 보려면
  `threads_keyword_search` 권한이 앱 리뷰로 승인돼야 한다. 승인 전에는
  Graph API Explorer에서 본인 계정 토큰으로 동작 확인만 가능.
- 이미지/영상 글은 캡션 텍스트만 온다. 좋아요·댓글 "개수"는 안 온다
  (`has_replies` 불리언만). 점수 로직은 본문 텍스트 기반으로 설계할 것.

## 1. 가장 빠른 확인 (코드 없이)
Graph API Explorer에서 토큰 발급 후:
```
GET https://graph.threads.net/v1.0/keyword_search
  ?q=韓國代購
  &search_type=RECENT
  &fields=id,text,media_type,permalink,timestamp,username
  &access_token=<TOKEN>
```

## 2. NestJS로 돌리기
```bash
# 새 프로젝트라면
npm i -g @nestjs/cli
nest new veasly-threads      # 이미 프로젝트 있으면 생략

# 설정 로더
npm i @nestjs/config

# 이 폴더의 src/threads/* 를 프로젝트 src/ 아래로 복사
# .env.example -> .env 로 복사하고 토큰 입력

npm run start:dev
```

`src/app.module.ts` 에 두 가지만 추가:
```ts
import { ConfigModule } from '@nestjs/config';
import { ThreadsModule } from './threads/threads.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // .env 로드
    ThreadsModule,
  ],
})
export class AppModule {}
```

## 3. 호출
```
http://localhost:3100/threads/search?q=韓國代購
http://localhost:3100/threads/search?q=開團&type=RECENT&limit=50
```

## 4. 다음 단계
가져온 `text`를 의도 분석 엔진에 넘겨 의도 점수 + 브랜드 분류 + 댓글 초안 생성.
