// 인스타그램 게시물 사진 일괄 다운로드 (VLM 비교용 테스트셋 만들기)
//
//   node scripts/ig-images.mjs            # 최근 100개 게시물의 모든 사진 받기
//   node scripts/ig-images.mjs 50         # 최근 50개만
//   node scripts/ig-images.mjs 100 ./out  # 개수 + 저장 폴더 지정
//
// - 캐러셀(여러 장 글)은 children 까지 펼쳐서 전 장 다 받는다.
// - 영상/릴스는 표지 이미지(thumbnail)를 _thumb 로 받는다 (OCR 가능한 이미지라 비교에 씀).
// - media_url 은 며칠 뒤 만료되므로 "지금" 받아두는 게 핵심.
// 저장 파일명: <순번>_<타입>_<mediaId>[_<장번호|thumb>].jpg  +  index.json (캡션/permalink 매핑)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const BASE = 'https://graph.instagram.com/v23.0';

function getToken() {
  let raw = '';
  try {
    raw = readFileSync(ENV_PATH, 'utf8');
  } catch {
    console.error('.env 파일이 없다.');
    process.exit(1);
  }
  const m = raw.match(/^INSTAGRAM_ACCESS_TOKEN=(.*)$/m);
  const token = m ? m[1].trim() : '';
  if (!token) {
    console.error('INSTAGRAM_ACCESS_TOKEN 이 .env 에 없다.');
    process.exit(1);
  }
  return token;
}

async function call(url) {
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) {
    console.error('IG API 실패:', JSON.stringify(json.error ?? json, null, 2));
    process.exit(1);
  }
  return json;
}

// 최근 N개 게시물 수집 (페이지네이션, 100개씩)
async function fetchMedia(token, want) {
  const fields =
    'id,caption,media_type,media_product_type,permalink,timestamp,media_url,thumbnail_url,' +
    'children{media_type,media_url,thumbnail_url}';
  const out = [];
  let url =
    `${BASE}/me/media?` +
    new URLSearchParams({
      fields,
      limit: String(Math.min(want, 100)),
      access_token: token,
    }).toString();
  for (let page = 0; url && out.length < want && page < 50; page++) {
    const json = await call(url);
    out.push(...(json.data ?? []));
    url = json.paging?.next ?? null;
  }
  return out.slice(0, want);
}

// 게시물 1건에서 받을 (url, suffix) 목록 뽑기
function imagesOf(m) {
  const shots = [];
  const kids = m.children?.data;
  if (kids?.length) {
    // 캐러셀: 장마다
    kids.forEach((c, i) => {
      const isVideo = c.media_type === 'VIDEO';
      const url = isVideo ? c.thumbnail_url : c.media_url;
      if (url) shots.push({ url, suffix: isVideo ? `${i + 1}_thumb` : `${i + 1}` });
    });
  } else if (m.media_type === 'VIDEO') {
    if (m.thumbnail_url) shots.push({ url: m.thumbnail_url, suffix: 'thumb' });
  } else if (m.media_url) {
    shots.push({ url: m.media_url, suffix: '' });
  }
  return shots;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return true;
}

async function main() {
  const want = Number(process.argv[2] ?? 100) || 100;
  const outDir = process.argv[3] ?? join(ROOT, 'test-images');
  mkdirSync(outDir, { recursive: true });

  const token = getToken();
  console.log(`최근 ${want}개 게시물 조회 중...`);
  const media = await fetchMedia(token, want);
  console.log(`게시물 ${media.length}건. 사진 다운로드 시작 -> ${outDir}`);

  const index = [];
  let ok = 0,
    fail = 0;
  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const seq = String(i + 1).padStart(3, '0');
    const shots = imagesOf(m);
    for (const { url, suffix } of shots) {
      const tail = suffix ? `_${suffix}` : '';
      const name = `${seq}_${(m.media_type ?? 'NA').toLowerCase()}_${m.id}${tail}.jpg`;
      const done = await download(url, join(outDir, name));
      if (done) {
        ok++;
        index.push({ file: name, mediaId: m.id, type: m.media_type, permalink: m.permalink, timestamp: m.timestamp, caption: m.caption ?? '' });
      } else {
        fail++;
        console.warn(`  실패(만료?): ${name}`);
      }
    }
    process.stdout.write(`\r  진행 ${i + 1}/${media.length}  (받음 ${ok}, 실패 ${fail})   `);
  }

  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\n완료: 이미지 ${ok}장 저장, 실패 ${fail}장. 매핑 -> ${join(outDir, 'index.json')}`);
}

main();
