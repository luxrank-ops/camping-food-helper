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
// - Vercel 빌드: 기본값(vercel.app)
// - Cloudflare Workers 빌드: WORKERS_CI 가 잡혀 있으므로 workers.dev 주소를 기본값으로 쓴다
//   (SITE_URL 을 지정하면 그 값이 항상 우선한다).
const VERCEL_SITE_URL = 'https://camping-food-helper.vercel.app';
const WORKERS_SITE_URL = 'https://camping-food-helper.luxrank.workers.dev';
const SITE_URL = (
  process.env.SITE_URL
  || (process.env.WORKERS_CI || process.env.CF_PAGES ? WORKERS_SITE_URL : VERCEL_SITE_URL)
).replace(/\/+$/, '');

// 검색엔진(구글 서치콘솔·네이버 서치어드바이저) 소유확인 파일 — 발급된 이름·내용 그대로 두고,
// 파일이 없으면 소유확인이 실패하므로 다른 값으로 바꾸지 말고 서비스에서 새로 발급받아 교체한다.
const VERIFICATION_FILES = {
  'google968bd4b8f647180b.html': 'google-site-verification: google968bd4b8f647180b.html',
  'naver53529db3a5cfcbb80cd1a7045bf9d026.html': 'naver-site-verification: naver53529db3a5cfcbb80cd1a7045bf9d026.html',
  // 2026-11-14 Cloudflare Workers 도메인용으로 네이버 서치어드바이저가 새로 발급한 확인 파일
  'naver4e2fab7d5ef508f9e045df89a0f4b005.html': 'naver-site-verification: naver4e2fab7d5ef508f9e045df89a0f4b005.html'
};

// 2. HTML 엔트리 복사 (index.html, camp-kitchen.html 동기화 보장)
//    canonical·og:url 은 실제 배포 도메인(SITE_URL)으로 맞춘다. 원본 index.html 은 그대로 둔다.
function rewriteSiteUrls(html) {
  if (SITE_URL === VERCEL_SITE_URL) return html;
  return html.split(VERCEL_SITE_URL).join(SITE_URL);
}
const entryHtml = rewriteSiteUrls(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
fs.writeFileSync(path.join(DIST, 'index.html'), entryHtml, 'utf8');
fs.writeFileSync(path.join(DIST, 'camp-kitchen.html'), entryHtml, 'utf8');

// 2-1. 쿠팡 파트너스 장보기 블록 (index.html 이 불러 쓰는 클라이언트 자산)
const coupangSrc = path.join(ROOT, 'coupang-partners.js');
if (fs.existsSync(coupangSrc)) {
  fs.copyFileSync(coupangSrc, path.join(DIST, 'coupang-partners.js'));
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
  `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`, 'utf8');

// 해시 라우팅(#/rec 등)은 검색엔진이 따로 수집하지 않으므로 홈 하나만 알린다.
fs.writeFileSync(path.join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n</urlset>\n`, 'utf8');

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
