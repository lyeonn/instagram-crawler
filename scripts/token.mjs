// Threads 토큰 관리 스크립트
//
//   node scripts/token.mjs exchange   # 단기 토큰 -> 장기 토큰(60일) 교환
//   node scripts/token.mjs refresh    # 장기 토큰 만료 전 60일 연장
//   node scripts/token.mjs debug      # 현재 .env 토큰의 만료/scope 확인
//
// exchange/refresh 성공 시 .env의 THREADS_ACCESS_TOKEN 을 자동으로 새 토큰으로 교체한다.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');

function readEnv() {
  let raw = '';
  try {
    raw = readFileSync(ENV_PATH, 'utf8');
  } catch {
    console.error('.env 파일이 없다. .env.example 복사해서 만들어라.');
    process.exit(1);
  }
  const get = (key) => {
    const m = raw.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return { raw, token: get('THREADS_ACCESS_TOKEN'), secret: get('THREADS_APP_SECRET') };
}

function writeToken(raw, newToken) {
  const next = raw.match(/^THREADS_ACCESS_TOKEN=.*$/m)
    ? raw.replace(/^THREADS_ACCESS_TOKEN=.*$/m, `THREADS_ACCESS_TOKEN=${newToken}`)
    : `${raw.trimEnd()}\nTHREADS_ACCESS_TOKEN=${newToken}\n`;
  writeFileSync(ENV_PATH, next);
}

async function call(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) {
    console.error('실패:', JSON.stringify(json.error ?? json, null, 2));
    process.exit(1);
  }
  return json;
}

const cmd = process.argv[2] ?? 'debug';
const { raw, token, secret } = readEnv();

if (!token) {
  console.error('THREADS_ACCESS_TOKEN 이 .env 에 없다.');
  process.exit(1);
}

if (cmd === 'exchange') {
  if (!secret) {
    console.error('THREADS_APP_SECRET 이 .env 에 필요하다. (토큰 발급한 그 앱의 시크릿)');
    process.exit(1);
  }
  const json = await call(
    `https://graph.threads.net/access_token?grant_type=th_exchange_token` +
      `&client_secret=${encodeURIComponent(secret)}` +
      `&access_token=${encodeURIComponent(token)}`,
  );
  writeToken(raw, json.access_token);
  const days = Math.round((json.expires_in ?? 0) / 86400);
  console.log(`장기 토큰 발급 완료 (약 ${days}일). .env 에 반영했다.`);
} else if (cmd === 'refresh') {
  const json = await call(
    `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token` +
      `&access_token=${encodeURIComponent(token)}`,
  );
  writeToken(raw, json.access_token);
  const days = Math.round((json.expires_in ?? 0) / 86400);
  console.log(`장기 토큰 갱신 완료 (약 ${days}일 연장). .env 에 반영했다.`);
} else if (cmd === 'debug') {
  const json = await call(
    `https://graph.threads.net/v1.0/debug_token` +
      `?input_token=${encodeURIComponent(token)}` +
      `&access_token=${encodeURIComponent(token)}`,
  );
  const d = json.data ?? {};
  const expires = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : '?';
  console.log('앱       :', d.application);
  console.log('user_id  :', d.user_id);
  console.log('유효함   :', d.is_valid);
  console.log('만료      :', expires);
  console.log('scopes   :', (d.scopes ?? []).join(', '));
  console.log(
    'keyword_search 포함:',
    (d.scopes ?? []).includes('threads_keyword_search') ? 'O' : 'X  <- 이게 없으면 검색 안 됨',
  );
} else {
  console.error('사용법: node scripts/token.mjs [exchange|refresh|debug]');
  process.exit(1);
}
