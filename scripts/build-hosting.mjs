// Firebase Hosting 배포용 정적 번들(dist/) 생성 스크립트.
// 서버 전용 파일(server.js, api/, .env 등)이나 민감 정보(비밀번호 평문 등)가
// 정적 호스팅에 노출되지 않도록 필요한 클라이언트 자산만 정제하여 dist/ 폴더로 복사한다.
//
// 비밀의 정원 정제는 API와 같은 sanitizePublicSecretGardens()를 사용한다.
// (예전에는 여기서 별도로 마스킹했는데, 비공개 스팟의 전체 주소(address)가 그대로 남아
//  정적 JSON을 직접 열면 상세 위치가 보이는 문제가 있었다.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizePublicSecretGardens } from '../lib/secret-gardens-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_DATA = path.join(DIST, 'data');

// 1. 기존 dist 초기화 및 생성
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST_DATA, { recursive: true });

// 검색 등록·분석용 루트 파일의 기준 주소. 배포 도메인이 바뀌면 여기만 고친다.
// - 운영 도메인은 Cloudflare Workers 주소 하나다(2026-11-14 이전). 옛 vercel.app 은 308 로 넘어오기만 한다.
// - 리다이렉트되는 주소를 캐노니컬·사이트맵에 두면 구글이 표준 URL 선택을 보류해 색인이 밀리므로,
//   기본값을 workers.dev 로 두고 SITE_URL 을 지정했을 때만 그 값을 우선한다.
const VERCEL_SITE_URL = 'https://camping-food-helper.vercel.app';
const WORKERS_SITE_URL = 'https://camping-food-helper.luxrank.workers.dev';
const SITE_URL = (process.env.SITE_URL || WORKERS_SITE_URL).replace(/\/+$/, '');

// 검색엔진(구글 서치콘솔·네이버 서치어드바이저) 소유확인 파일 — 발급된 이름·내용 그대로 두고,
// 파일이 없으면 소유확인이 실패하므로 다른 값으로 바꾸지 말고 서비스에서 새로 발급받아 교체한다.
const VERIFICATION_FILES = {
  'google968bd4b8f647180b.html': 'google-site-verification: google968bd4b8f647180b.html',
  'naver53529db3a5cfcbb80cd1a7045bf9d026.html': 'naver-site-verification: naver53529db3a5cfcbb80cd1a7045bf9d026.html',
  // 2026-11-14 Cloudflare Workers 도메인용으로 네이버 서치어드바이저가 새로 발급한 확인 파일
  'naver4e2fab7d5ef508f9e045df89a0f4b005.html': 'naver-site-verification: naver4e2fab7d5ef508f9e045df89a0f4b005.html'
};

// 2. HTML 엔트리 복사 (index.html 하나가 대표 주소)
//    canonical·og:url 은 실제 배포 도메인(SITE_URL)으로 맞춘다. 원본 index.html 은 그대로 둔다.
//    옛 주소(vercel.app·workers.dev 등)가 적혀 있으면 모두 SITE_URL 로 바꾼다.
function rewriteSiteUrls(html) {
  for (const origin of [VERCEL_SITE_URL, WORKERS_SITE_URL]) {
    if (origin !== SITE_URL) html = html.split(origin).join(SITE_URL);
  }
  return html;
}

// 옛 입구(camp-kitchen.html)로 들어온 사람을 대표 주소로 보내는 안내 페이지.
// 예전에는 index.html 사본을 그대로 내려보내 같은 내용이 두 주소에 존재했고, 그것이 구글 서치콘솔의
// '중복 페이지(사용자가 지정한 표준 URL과 다름)' 경고의 한 원인이었다.
function legacyEntryHtml(siteUrl) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>오늘 캠핑. 춘학아~ 뭐해먹지?</title>
<link rel="canonical" href="${siteUrl}/">
<meta http-equiv="refresh" content="0; url=${siteUrl}/">
<style>
body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;padding:24px;line-height:1.7}
</style>
</head>
<body>
<p>
주소가 <a href="${siteUrl}/">${siteUrl}/</a> 로 바뀌었습니다. 잠시 후 자동으로 이동합니다.
</p>
</body>
</html>
`;
}

const entryHtml = rewriteSiteUrls(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
fs.writeFileSync(path.join(DIST, 'index.html'), entryHtml, 'utf8');
fs.writeFileSync(path.join(DIST, 'camp-kitchen.html'), legacyEntryHtml(SITE_URL), 'utf8');

// 2-1. 쿠팡 파트너스 장보기 블록 (index.html 이 불러 쓰는 클라이언트 자산)
const coupangSrc = path.join(ROOT, 'coupang-partners.js');
if (fs.existsSync(coupangSrc)) {
  fs.copyFileSync(coupangSrc, path.join(DIST, 'coupang-partners.js'));
}

// 2-2. 앱 아이콘·웹 앱 매니페스트 — 파비콘·홈 화면 추가 아이콘은 dist/ 루트에서 서빙된다.
for (const file of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.png', 'favicon.ico', 'manifest.webmanifest']) {
  const from = path.join(ROOT, file);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DIST, file));
}

// 3. 캠핑장 데이터 복사
const campgroundsSrc = path.join(ROOT, 'data', 'campgrounds.js');
if (fs.existsSync(campgroundsSrc)) {
  fs.copyFileSync(campgroundsSrc, path.join(DIST_DATA, 'campgrounds.js'));
}

// 4. 비밀의 정원 초기 데이터 정제 복사 (비밀번호 및 비공개 상세 위치 제거 — API와 동일 규칙)
const gardensSrc = path.join(ROOT, 'data', 'secret_gardens.json');
if (fs.existsSync(gardensSrc)) {
  const raw = JSON.parse(fs.readFileSync(gardensSrc, 'utf8'));
  const sanitized = sanitizePublicSecretGardens(Array.isArray(raw) ? raw : []);
  fs.writeFileSync(path.join(DIST_DATA, 'secret_gardens.json'), JSON.stringify(sanitized, null, 2), 'utf8');
}

console.log('build-hosting: Firebase Hosting 정적 배포 번들(dist/) 생성 완료');

// 5. 검색 등록용 루트 파일 (robots.txt·sitemap.xml·소유확인) + GA4 측정 스크립트
//    dist/ 가 배포 루트라서 여기에 두어야 /robots.txt 로 내려간다.
fs.writeFileSync(path.join(DIST, 'robots.txt'),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'utf8');

// 해시 라우팅(#/rec 등)은 검색엔진이 따로 수집하지 않으므로 홈 하나만 알린다.
// (여러 주소가 같은 화면을 보여 주면 '중복 페이지'가 되므로 사본 주소는 넣지 않는다.)
fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n</urlset>\n`, 'utf8');

// 같은 화면을 내려 주던 사본 주소는 대표 주소로 301 한다(Workers 정적 자산이 dist/_redirects 를 읽는다).
//  주의: `/' 는 Worker 가 내부적으로 ASSETS 에 '/index.html' 로 넘기므로, 여기에 '/index.html / 301' 을 넣으면
//  '/' 요청이 '301 /' 로 튀어 무한 리다이렉트가 된다(2026-11-18 실제 발생).
//  그래서 '/index.html' 정리는 Worker 진입점에서 직접 처리한다(worker/index.js).
fs.writeFileSync(path.join(DIST, '_redirects'), [
  '/camp-kitchen.html / 301',
  ''
].join('\n'), 'utf8');

for (const [name, body] of Object.entries(VERIFICATION_FILES)) {
  fs.writeFileSync(path.join(DIST, name), body + '\n', 'utf8');
}

// GA4 측정 스크립트 (index.html 이 /analytics.js 로 부른다)
const analyticsSrc = path.join(ROOT, 'analytics.js');
if (fs.existsSync(analyticsSrc)) fs.copyFileSync(analyticsSrc, path.join(DIST, 'analytics.js'));

// 6. Cloudflare Workers 정적 자산용 헤더(_headers)
//    Vercel 의 vercel.json / Firebase 의 firebase.json 과 같은 보안·캐시 정책을 유지한다.
//    (Workers Static Assets 가 dist/_headers 를 읽어 응답 헤더로 붙인다)
fs.writeFileSync(path.join(DIST, '_headers'), [
  '/*',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  X-Frame-Options: SAMEORIGIN',
  '',
  '/*.html',
  '  Cache-Control: no-cache, no-store, must-revalidate',
  '',
  '/data/campgrounds.js',
  '  Cache-Control: public, max-age=86400, s-maxage=604800',
  '',
  '/data/secret_gardens.json',
  '  Cache-Control: public, max-age=300',
  ''
].join('\n'), 'utf8');

console.log(`build-hosting: 사이트 기준 주소 ${SITE_URL}`);
