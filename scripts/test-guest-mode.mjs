// 게스트 우선(로그인 선택) 화면 회귀 테스트 (node --test)
//
// 확인 내용
//  - 비로그인 상태에서 앱이 바로 그려진다(강제 로그인 게이트 없음).
//  - 로그인/회원가입 폼은 '선택' 화면으로 열리고 닫을 수 있다([로그인 없이 계속 쓰기]).
//  - 로그인 상태에서만 Authorization 헤더가 붙고, 계정 데이터 동기화가 동작한다.
//  - 상단에 로그인 진입점(게스트)과 플랜 배지가 있다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const kitchen = fs.readFileSync(path.join(ROOT, 'camp-kitchen.html'), 'utf8');

// 옛 입구 camp-kitchen.html 은 앱 화면을 복제하지 않는다.
// (같은 내용이 두 주소에 있으면 구글 서치콘솔이 '중복 페이지'로 보고 색인을 미룬다)
// 대표 주소로 보내는 안내 페이지만 남기고, 앱 본문은 index.html 한 곳에만 둔다.
function assertLegacyEntry() {
  assert.ok(kitchen.length < 2000, 'camp-kitchen.html 은 앱 사본이 아니라 안내 페이지여야 한다');
  assert.match(kitchen, /<link rel="canonical" href="https:\/\/camping-food-helper\.luxrank\.workers\.dev\/">/);
  assert.match(kitchen, /http-equiv="refresh"/, '대표 주소로 자동 이동해야 한다');
  assert.ok(!kitchen.includes('id="app"'), '앱 본문이 복제되면 중복 페이지가 된다');
}

test('index.html 만 앱 본문을 갖고, camp-kitchen.html 은 대표 주소 안내 페이지다', () => {
  assert.ok(html.includes('id="app"'), 'index.html 이 앱 본문을 가져야 한다');
  assertLegacyEntry();
});

test('비로그인 상태에서도 앱이 바로 시작된다(강제 로그인 게이트 없음)', () => {
  // 첫 진입: 토큰이 없으면 곧바로 startApp()
  assert.match(html, /if\(!AUTH\.token\)\{startApp\(\);return\}/);
  // 앱을 잠그는 함수(lockApp)는 없어야 한다.
  assert.equal(html.includes('lockApp('), false, '강제 로그인 게이트(lockApp)가 남아 있으면 안 된다');
  // 로그인 화면은 사용자가 열 때만 나온다.
  assert.match(html, /function showAuth\(view\)/);
  assert.match(html, /data-auth-a="open-login"/);
  assert.match(html, /data-auth-a="open-signup"/);
  // 로그인 화면에서 게스트로 돌아가는 버튼
  assert.match(html, /data-auth-a="close"[^>]*>로그인 없이 계속 쓰기/);
});

test('세션이 만료되면 게스트로 계속 쓰고 안내만 남긴다', () => {
  assert.match(html, /function handleAuthLost\(\)/);
  assert.match(html, /로그인이 만료돼 게스트로 전환됐어요/);
  assert.match(html, /if\(res\.status===401&&AUTH\.token\)handleAuthLost\(\)/);
});

test('로그인 상태에서만 Authorization 헤더가 붙고 계정 데이터가 동기화된다', () => {
  assert.match(html, /if\(AUTH\.token&&!h\.Authorization\)h\.Authorization='Bearer '\+AUTH\.token/);
  assert.match(html, /function apiFetch\(url,opts\)/);
  assert.match(html, /function syncAccountData\(\)/);
  assert.match(html, /function scheduleDataSync\(\)/);
  assert.match(html, /apiFetch\('\/api\/auth\/data'/);
  assert.ok(html.includes("k.indexOf('cc.')===0") && html.includes('scheduleDataSync();'), '내 정보 변경 시 계정 저장이 예약되어야 한다');
});

test('상단 헤더에 게스트용 로그인 칩과 플랜 배지가 있다', () => {
  assert.match(html, /function authTopHtml\(\)/);
  assert.match(html, /function planBadgeHtml\(\)/);
  assert.match(html, /plan-pill guest">GUEST/);
  assert.match(html, /'<span class="hero-badges">'\+s\+authTopHtml\(\)\+'<\/span>'/);
});

test('내 정보 탭에 게스트 안내와 로그인/회원가입 버튼, 회원용 플랜 카드가 함께 있다', () => {
  const start = html.indexOf('function planSection(){');
  const end = html.indexOf('/* 로그인 확인 뒤에만 앱을 그린다', start) > -1
    ? html.indexOf('/* 로그인 확인 뒤에만 앱을 그린다', start)
    : html.indexOf('var APP_STARTED', start);
  assert.ok(start > -1, 'planSection 함수가 있어야 한다');
  const section = html.slice(start, end > start ? end : start + 6000);

  // 게스트: 로그인/회원가입 버튼과 이 기기 저장 안내
  assert.match(section, /지금은 <b>게스트<\/b>로 쓰고 있어요/);
  assert.match(section, /data-auth-a="open-login"/);
  assert.match(section, /data-auth-a="open-signup"/);
  // 회원: 사용량·구독 관리·계정 설정
  assert.match(section, /today|오늘 AI 메뉴 추천/);
  assert.match(section, /data-auth-a="logout"/);
  assert.match(section, /data-auth-a="upgrade"/);
  assert.match(section, /계정 설정/);
});

test('로그인·회원가입 폼은 실제 인증 API 로 제출된다', () => {
  assert.match(html, /fetch\('\/api\/auth\/'\+kind,\{method:'POST'/);
  assert.match(html, /setAuthToken\(r\.data\.token\)/);
  assert.match(html, /cacheAuthUser\(r\.data\.user\)/);
  assert.match(html, /data-auth-form="'\+\(signup\?'signup':'login'\)\+'"/);
});

test('게스트 무료 체험 한도 초과 메시지가 있다', () => {
  assert.match(html, /guest_quota_exceeded:'로그인 없이 쓸 수 있는 오늘의 무료 횟수를 다 썼어요/);
});
