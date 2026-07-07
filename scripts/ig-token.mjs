// 인스타그램 토큰 관리 스크립트 (Instagram API with Instagram Login)
//
//   node scripts/ig-token.mjs exchange   # 단기 토큰 -> 장기 토큰(60일) 교환
//   node scripts/ig-token.mjs refresh    # 장기 토큰 60일 연장 (토큰이 24시간 이상 됐을 때)
//   node scripts/ig-token.mjs check       # 현재 토큰 유효성 + 계정 확인
//
// exchange/refresh 성공 시 .env의 INSTAGRAM_ACCESS_TOKEN 을 새 토큰으로 자동 교체한다.
// 주의: client_secret 은 "인스타그램 앱 시크릿"이다 (페이스북 앱 시크릿과 다를 수 있음).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const BASE = 'https://graph.instagram.com';

function readEnv() {
  let raw = '';
  try {
    raw = readFileSync(ENV_PATH, 'utf8');
  } catch {
    console.error('.env 파일이 없다.');
    process.exit(1);
  }
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return {
    raw,
    token: get('INSTAGRAM_ACCESS_TOKEN'),
    secret: get('INSTAGRAM_APP_SECRET'),
  };
}

function writeToken(raw, newToken) {
  const next = raw.match(/^INSTAGRAM_ACCESS_TOKEN=.*$/m)
    ? raw.replace(/^INSTAGRAM_ACCESS_TOKEN=.*$/m, `INSTAGRAM_ACCESS_TOKEN=${newToken}`)
    : `${raw.trimEnd()}\nINSTAGRAM_ACCESS_TOKEN=${newToken}\n`;
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

const cmd = process.argv[2] ?? 'check';
const { raw, token, secret } = readEnv();
if (!token) {
  console.error('INSTAGRAM_ACCESS_TOKEN 이 .env 에 없다.');
  process.exit(1);
}

if (cmd === 'exchange') {
  if (!secret) {
    console.error('INSTAGRAM_APP_SECRET 이 .env 에 필요하다. (인스타그램 앱 시크릿)');
    process.exit(1);
  }
  const json = await call(
    `${BASE}/access_token?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(secret)}` +
      `&access_token=${encodeURIComponent(token)}`,
  );
  writeToken(raw, json.access_token);
  console.log(`장기 토큰 발급 완료 (약 ${Math.round((json.expires_in ?? 0) / 86400)}일). .env 반영함.`);
} else if (cmd === 'refresh') {
  const json = await call(
    `${BASE}/refresh_access_token?grant_type=ig_refresh_token` +
      `&access_token=${encodeURIComponent(token)}`,
  );
  writeToken(raw, json.access_token);
  console.log(`장기 토큰 갱신 완료 (약 ${Math.round((json.expires_in ?? 0) / 86400)}일 연장). .env 반영함.`);
} else if (cmd === 'check') {
  const json = await call(
    `${BASE}/me?fields=id,username,account_type&access_token=${encodeURIComponent(token)}`,
  );
  console.log('유효함   : true');
  console.log('username :', json.username);
  console.log('계정유형 :', json.account_type);
  console.log('user_id  :', json.id);
} else {
  console.error('사용법: node scripts/ig-token.mjs [exchange|refresh|check]');
  process.exit(1);
}
