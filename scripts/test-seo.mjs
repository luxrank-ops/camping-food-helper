// 검색 등록·분석 배포물 점검 — dist/ 에 robots.txt·sitemap.xml·소유확인 파일·analytics.js 가
// 실제로 만들어지는지, index.html 이 GA4 스크립트를 부르는지 확인한다.
// (dist/ 는 배포 루트다. 여기에 없으면 구글·네이버가 파일을 못 찾아 소유확인이 실패한다.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-hosting.mjs')], {
  cwd: ROOT,
  env: { ...process.env, SITE_URL: 'https://camping-food-helper.luxrank.workers.dev' },
  encoding: 'utf8'
});

test('1. 배포 번들 빌드가 성공한다', () => {
  assert.equal(build.status, 0, build.stderr || build.stdout);
});

test('2. robots.txt 가 정식 도메인의 sitemap.xml 을 가리킨다', () => {
  const robots = fs.readFileSync(path.join(DIST, 'robots.txt'), 'utf8');
  assert.match(robots, /User-agent: \*/);
  assert.ok(robots.includes('Sitemap: https://camping-food-helper.luxrank.workers.dev/sitemap.xml'), robots);
  assert.match(robots, /Disallow: \/api\//);
});

test('3. sitemap.xml 이 홈 주소를 담은 올바른 XML 이다', () => {
  const sitemap = fs.readFileSync(path.join(DIST, 'sitemap.xml'), 'utf8');
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(sitemap.includes('<loc>https://camping-food-helper.luxrank.workers.dev/</loc>'));
  assert.ok(!sitemap.includes('vercel.app'), '리다이렉트되는 옛 주소를 사이트맵에 넣지 않는다');
});

test('3-1. 사본 주소(/index.html·/camp-kitchen.html)는 대표 주소로 301 한다', () => {
  const redirects = fs.readFileSync(path.join(DIST, '_redirects'), 'utf8');
  assert.match(redirects, /^\/camp-kitchen\.html \/ 301$/m);
  // '/' 는 Worker 가 내부적으로 '/index.html' 을 부르므로, _redirects 에 넣으면 '301 /' 무한 리다이렉트가 된다.
  assert.ok(!/^\/index\.html \/ 301$/m.test(redirects), '/index.html 규칙은 _redirects 가 아니라 Worker 에서 처리한다');
  const worker = fs.readFileSync(path.join(ROOT, 'worker', 'index.js'), 'utf8');
  assert.match(worker, /url\.pathname === '\/index\.html'/, 'Worker 가 /index.html 을 대표 주소로 넘겨야 한다');
  assert.match(worker, /status: 301/);
  const wrangler = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /run_worker_first": \["\/api\/\*", "\/", "\/index\.html"\]/, '/index.html 은 Worker 가 먼저 받아야 한다');
  assert.match(wrangler, /preview_urls": false/, '버전 프리뷰 주소는 중복 페이지가 되므로 꺼 둔다');
});

test('3-2. camp-kitchen.html 은 앱 사본이 아니라 대표 주소 안내 페이지다', () => {
  const legacy = fs.readFileSync(path.join(DIST, 'camp-kitchen.html'), 'utf8');
  assert.ok(legacy.length < 2000, '앱 본문 사본이 남아 있으면 중복 페이지가 된다');
  assert.ok(legacy.includes('rel="canonical" href="https://camping-food-helper.luxrank.workers.dev/"'));
  assert.ok(!legacy.includes('<script'), '앱 스크립트를 다시 싣지 않는다');
});

test('4. 구글·네이버 소유확인 파일이 배포 루트에 있다', () => {
  assert.equal(
    fs.readFileSync(path.join(DIST, 'google968bd4b8f647180b.html'), 'utf8').trim(),
    'google-site-verification: google968bd4b8f647180b.html'
  );
  assert.equal(
    fs.readFileSync(path.join(DIST, 'naver53529db3a5cfcbb80cd1a7045bf9d026.html'), 'utf8').trim(),
    'naver-site-verification: naver53529db3a5cfcbb80cd1a7045bf9d026.html'
  );
});

test('5. GA4 측정 스크립트가 배포되고 index.html 이 그것을 부른다', () => {
  const analytics = fs.readFileSync(path.join(DIST, 'analytics.js'), 'utf8');
  assert.match(analytics, /G-KWRL68QXR4/, '측정 ID가 스크립트에 있어야 함');
  assert.match(analytics, /recommend_request/, '핵심 전환 이벤트가 정의되어야 함');
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="/analytics.js" defer></script>'));
  assert.ok(html.includes('<link rel="canonical" href="https://camping-food-helper.luxrank.workers.dev/">'));
  assert.ok(!html.includes('camping-food-helper.vercel.app'), '캐노니컬·og:url 이 308 리다이렉트되는 옛 주소를 가리키면 색인이 보류된다');
});
