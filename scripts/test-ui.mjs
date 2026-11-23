// 첫 화면·추천 카드 개선 회귀 테스트 (node --test)
// 대상: index.html / camp-kitchen.html — 첫 화면 배치, 세부 조건 접이, CTA 문구,
//       추천 카드 라벨 통일, 모바일 제목 스타일이 사라지지 않는지 지킨다.
// 로컬 실행: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const kitchen = fs.readFileSync(path.join(ROOT, 'camp-kitchen.html'), 'utf8');

// 옛 입구 camp-kitchen.html 은 앱 화면을 복제하지 않는다(중복 페이지 방지 → 대표 주소 안내만).
function assertLegacyEntry() {
  assert.ok(kitchen.length < 2000, 'camp-kitchen.html 은 앱 사본이 아니라 안내 페이지여야 한다');
  assert.match(kitchen, /<link rel="canonical" href="https:\/\/camping-food-helper\.luxrank\.workers\.dev\/">/);
  assert.match(kitchen, /http-equiv="refresh"/, '대표 주소로 자동 이동해야 한다');
  assert.ok(!kitchen.includes('id="app"'), '앱 본문이 복제되면 중복 페이지가 된다');
}

test('첫 화면: 인원·장비·끼니 선택이 캠핑장 등 부가 기능보다 위에 배치된다', () => {
  const peopleIdx = html.indexOf('<h2>인원 · 조리 장비 설정</h2>');
  const condIdx = html.indexOf('<h2>오늘 캠핑 조건</h2>');
  const locIdx = html.indexOf('h+=locCard();');
  const introIdx = html.indexOf('h+=campIntroCard();');
  const wxIdx = html.indexOf('h+=wxCard();');
  const coolerIdx = html.indexOf('🧊 쿨러백 털기');
  assert.ok(peopleIdx > -1 && condIdx > -1 && locIdx > -1, '핵심 선택 카드가 모두 존재해야 한다');
  assert.ok(coolerIdx > -1, '쿨러백 털기 카드가 존재해야 한다');
  assert.ok(peopleIdx < locIdx, '인원·장비 설정이 캠핑지 찾기보다 위여야 한다');
  assert.ok(condIdx < locIdx, '끼니 선택이 캠핑지 찾기보다 위여야 한다');
  assert.ok(condIdx < introIdx, '끼니 선택이 캠핑장 소개보다 위여야 한다');
  assert.ok(condIdx < wxIdx, '끼니 선택이 캠핑지 날씨보다 위여야 한다');
  assert.ok(condIdx < coolerIdx, '끼니 선택이 쿨러백 털기보다 위여야 한다');
});

test('입력 간소화: 스타일·조리시간·분위기는 기본 접힌 세부 조건 설정에 들어간다', () => {
  assert.match(html, /condDetailsOpen:false/, '세부 조건 설정은 기본 접힘이어야 한다');
  assert.match(html, /data-a="cond-details-toggle"/, '세부 조건 설정 토글 버튼이 있어야 한다');
  const condIdx = html.indexOf('<h2>오늘 캠핑 조건</h2>');
  const btnIdx = html.indexOf('이 조건으로 메뉴 추천받기');
  assert.ok(condIdx > -1 && btnIdx > condIdx, '조건 카드 안에 메인 버튼이 있어야 한다');
  const block = html.slice(condIdx, btnIdx);
  const foldIdx = block.indexOf('data-a="cond-details-toggle"');
  assert.ok(foldIdx > -1, '세부 조건 설정 접이 영역이 조건 카드 안에 있어야 한다');
  const mealIdx = block.indexOf("chips('meal'");
  assert.ok(mealIdx > -1 && mealIdx < foldIdx, '끼니 선택은 접이 영역 밖에 바로 표시되어야 한다');
  assert.ok(block.indexOf("chips('style'") > foldIdx, '스타일은 세부 조건 설정 안에 접혀야 한다');
  assert.ok(block.indexOf("chips('time'") > foldIdx, '조리 시간은 세부 조건 설정 안에 접혀야 한다');
  assert.ok(block.indexOf("chips('mood'") > foldIdx, '분위기는 세부 조건 설정 안에 접혀야 한다');
});

test('추천 카드 비교 개선: 예상 조리시간·난이도·추천 이유가 통일된 라벨로 표시된다', () => {
  const fn = html.slice(html.indexOf('function recommendationCard'), html.indexOf('function recView'));
  assert.ok(fn.startsWith('function recommendationCard'), 'recommendationCard 함수를 찾을 수 있어야 한다');
  assert.ok(fn.includes('예상 조리시간'), '예상 조리시간 라벨이 있어야 한다');
  assert.ok(fn.includes('난이도'), '난이도 라벨이 있어야 한다');
  assert.ok(fn.includes('추천 이유'), '추천 이유 라벨이 있어야 한다');
  assert.match(fn, /rec-facts/, '비교용 사실 묶음(rec-facts)이 있어야 한다');
  assert.match(fn, /미정/, '값이 없어도 라벨을 유지하고 미정으로 표시해야 한다');
});

test('비밀의 정원 등록: 유형·시설·사진 선택 후에도 입력한 초안을 복원한다', () => {
  assert.match(html, /gardenRegDraft:null/, '등록 초안 상태가 있어야 한다');
  assert.match(html, /function captureGardenRegistrationDraft\(\)/, '입력값을 상태로 보존하는 함수가 있어야 한다');
  const modalStart = html.indexOf('if(ui.gardenRegModal){');
  const modalEnd = html.indexOf('// 2. 상세 모달 (스팟 상세 보기)', modalStart);
  const modal = html.slice(modalStart, modalEnd);
  assert.ok(modalStart >= 0 && modalEnd > modalStart, '등록 모달 영역을 찾아야 한다');
  for (const field of ['name', 'address', 'lat', 'lng', 'addressDetail', 'navQuery', 'fee', 'toiletStatus', 'entryRoad', 'tips', 'author', 'password']) {
    assert.ok(modal.includes('regDraft.' + field), `등록 폼의 ${field} 값을 다시 그릴 때 복원해야 한다`);
  }
  const actionsStart = html.indexOf("if(a==='garden-set-cat'){");
  const actionsEnd = html.indexOf("if(a==='garden-gps-fill'){");
  const actions = html.slice(actionsStart, actionsEnd);
  assert.match(actions, /garden-set-cat'\)\{\s*captureGardenRegistrationDraft\(\)/, '유형 선택 전에 입력을 저장해야 한다');
  assert.match(actions, /garden-fac-toggle'\)\{\s*captureGardenRegistrationDraft\(\)/, '시설 선택 전에 입력을 저장해야 한다');
  assert.match(actions, /garden-preset-pick'\)\{\s*captureGardenRegistrationDraft\(\)/, '사진 선택 전에 입력을 저장해야 한다');
  assert.match(html, /ui\.gardenRegError=error&&error\.status[\s\S]{0,250}render\(\)/, '등록 실패 메시지를 모달에 표시하고 입력을 유지해야 한다');
});

test('모바일 제목 개선: 글자 크기·줄바꿈 조정과 배경 그림 간섭 완화가 있다', () => {
  const m = html.match(/@media\(max-width:480px\)\{\s*\.home h1\{([^}]*)\}[\s\S]{0,200}?\.hero \.scene\{([^}]*)\}/);
  assert.ok(m, '모바일 제목·배경 그림 미디어 쿼리가 있어야 한다');
  assert.match(m[1], /font-size:clamp/, '모바일 제목 글자 크기가 화면 폭에 맞게 줄어야 한다');
  assert.match(m[1], /word-break:keep-all/, '제목 줄바꿈이 단어 중간에서 깨지지 않아야 한다');
  assert.match(m[2], /opacity:/, '배경 그림 투명도를 낮춰야 한다');
  const opacity = parseFloat((m[2].match(/opacity:([0-9.]+)/) || [])[1]);
  assert.ok(opacity > 0 && opacity < 0.95, '배경 그림이 기본보다 흐려야 한다');
  assertLegacyEntry();
});

test('앱 홍보: 내 정보 탭의 [📢 홍보글 복사] 버튼이 홍보 문구와 workers.dev 주소를 복사한다', () => {
  // 버튼은 '내 정보·일지' 화면(meView)의 마지막 카드에 있다
  const meStart = html.indexOf('function meView(){');
  const meEnd = html.indexOf('function guestbookView(){', meStart);
  assert.ok(meStart > -1 && meEnd > meStart, '내 정보 화면을 찾아야 한다');
  const me = html.slice(meStart, meEnd);
  assert.match(me, /data-a="promo-copy"/, '홍보글 복사 버튼이 내 정보 화면에 있어야 한다');
  assert.match(me, /📢 홍보글 복사/, '버튼 라벨은 무엇을 복사하는지 분명해야 한다');
  // 복사 문구·주소
  assert.match(html, /var PROMO_URL='https:\/\/camping-food-helper\.luxrank\.workers\.dev'/, '복사할 주소는 새 Cloudflare Workers 주소여야 한다');
  assert.match(html, /캠핑 갈 때마다 "이번엔 뭐 해 먹지\? 뭐 챙겨야 하지\?" 고민되시죠\?/, '홍보 문구 첫 줄이 들어 있어야 한다');
  assert.match(html, /전국 4,018개 캠핑장 검색부터 숨은 스팟 공유\(비밀의 정원\)까지!/, '홍보 문구 본문이 들어 있어야 한다');
  // 복사 방식·피드백
  assert.match(html, /navigator\.clipboard&&navigator\.clipboard\.writeText/, 'Clipboard API를 써야 한다');
  assert.match(html, /document\.execCommand\('copy'\)/, 'Clipboard API가 막히는 환경을 위한 textarea fallback이 있어야 한다');
  assert.match(html, /홍보글이 복사됐어요!/, '복사 후 안내 문구가 있어야 한다');
  assertLegacyEntry();
});

test('비밀의 정원: 카드에 직선거리와 네이버/카카오 길찾기 바로가기가 있다', () => {
  // 거리 기준: 기본은 부산 명지(사업장), '내 위치'로 바꿀 수 있다
  assert.match(html, /var GARDEN_ORIGIN_HOME=\{[\s\S]{0,80}lat:35\.0866,lng:128\.9038,/, '기본 출발지는 부산 명지 좌표여야 한다');
  assert.match(html, /function haversineKm\(/, '직선거리 계산 함수가 있어야 한다');
  assert.match(html, /function spotDistanceKm\(/, '스팟 거리 계산 함수가 있어야 한다');
  // 실제 좌표가 없는 스팟(비공개 잠금)에는 거리를 지어내지 않는다
  assert.match(html, /if\(!isFinite\(la\)\|\|!isFinite\(ln\)\|\|!la\|\|!ln\) return null;/, '좌표가 없으면 거리를 만들지 않아야 한다');
  // 지도 앱 바로가기: 좌표가 있으면 출발지→도착지 길찾기, 없으면 장소 검색
  assert.match(html, /https:\/\/map\.naver\.com\/p\/directions\//, '네이버 지도 길찾기 주소가 있어야 한다');
  assert.match(html, /https:\/\/map\.kakao\.com\/link\/from\//, '카카오맵 출발지 지정 길찾기 주소가 있어야 한다');
  assert.match(html, /tmap:\/\/route\?/, '티맵 앱 길찾기 주소가 있어야 한다');
  // 카드 렌더링에 길찾기 줄이 붙는다
  assert.match(html, /r \+= gardenNavBarHtml\(g\);/, '비밀의 정원 카드에 길찾기 줄을 붙여야 한다');
  assert.match(html, /class="garden-nav-link kakao"/, '카카오 길찾기 버튼이 있어야 한다');
  assert.match(html, /class="garden-nav-link naver"/, '네이버 길찾기 버튼이 있어야 한다');
  // 출발지 전환 버튼
  assert.match(html, /data-a="garden-origin"/, '거리 기준 출발지를 바꾸는 버튼이 있어야 한다');
  assert.match(html, /gardenOriginMode/, '출발지 선택이 상태로 유지되어야 한다');
});

test('내비게이션 개편: 하단 탭 5개 + 전체메뉴 시트 + 상단 전환 탭 + 빠른 길잡이 4버튼', () => {
  // ① 하단 탭은 5개로 넓게 — 추천 · 캠핑지·노지 · 준비물 · 식단표 · 전체메뉴
  const navStart = html.indexOf('<nav class="tabs" id="tabs"');
  const navEnd = html.indexOf('</nav>', navStart);
  assert.ok(navStart > -1 && navEnd > navStart, '하단 탭바를 찾아야 한다');
  const nav = html.slice(navStart, navEnd);
  assert.equal((nav.match(/<button\b/g) || []).length, 5, '하단 탭 버튼은 5개여야 한다');
  assert.match(html, /\.pill\{[^}]*grid-template-columns:repeat\(5,1fr\)/, '하단 탭은 5칸 그리드여야 한다');
  for (const v of ['rec', 'camp', 'list', 'plan']) {
    assert.ok(nav.includes(`data-v="${v}"`), `하단 탭에 ${v} 화면이 있어야 한다`);
  }
  assert.match(nav, /data-v="camp" data-tabs="camp garden"/, '캠핑지·노지 탭은 두 화면을 묶어야 한다');
  assert.match(nav, /data-a="menu-open"[^>]*data-tabs="guestbook me"/, '전체메뉴 버튼은 방명록·내 정보에서 활성 표시돼야 한다');

  // ② 전체메뉴 바텀시트 — 7개 화면 모두, 각 항목에 한 줄 설명
  assert.match(html, /function menuSheetHtml\(\)/, '전체메뉴 시트 렌더러가 있어야 한다');
  assert.match(html, /if\(a==='menu-open'\)\{ui\.menuOpen=true;render\(\);return\}/, '전체메뉴 열기 액션이 있어야 한다');
  assert.match(html, /if\(a==='menu-close'\)\{if\(!closeFromBackdrop\(b,e\)\)return;ui\.menuOpen=false;render\(\);return\}/, '전체메뉴 닫기 액션이 있어야 한다');
  const listStart = html.indexOf('var ALL_MENU=[');
  const listEnd = html.indexOf('];', listStart);
  assert.ok(listStart > -1 && listEnd > listStart, '전체메뉴 항목 정의가 있어야 한다');
  const menuList = html.slice(listStart, listEnd);
  for (const v of ['rec', 'plan', 'camp', 'garden', 'list', 'guestbook', 'me']) {
    assert.ok(menuList.includes(`v:'${v}'`), `전체메뉴에 ${v} 화면이 있어야 한다`);
  }
  assert.equal((menuList.match(/desc:/g) || []).length, 7, '메뉴 7개 모두 한 줄 설명이 있어야 한다');
  // 탭으로 이동하면 열려 있던 시트는 닫힌다
  const tabAction = html.slice(html.indexOf("if(a==='tab'){"), html.indexOf("if(a==='menu-open'){"));
  assert.match(tabAction, /ui\.tab=v;[\s\S]{0,120}ui\.menuOpen=false;/, '탭 이동 시 전체메뉴 시트를 닫아야 한다');

  // ③ 상단 전환 탭 — 추천↔식단표, 캠핑장↔비밀의 정원
  assert.match(html, /function foodSwitch\(\)/, '먹거리 전환 탭이 있어야 한다');
  assert.match(html, /function placeSwitch\(\)/, '장소 전환 탭이 있어야 한다');
  const food = html.slice(html.indexOf('function foodSwitch(){'), html.indexOf('function placeSwitch(){'));
  assert.match(food, /data-v="rec"[^>]*aria-current[^>]*>[^<]*오늘 메뉴 추천/, '전환 탭에 오늘 메뉴 추천이 있어야 한다');
  assert.match(food, /data-v="plan"[^>]*aria-current[^>]*>[^<]*식단표/, '전환 탭에 식단표가 있어야 한다');
  const place = html.slice(html.indexOf('function placeSwitch(){'), html.indexOf('function menuSheetHtml(){'));
  assert.match(place, /data-v="camp"[^>]*aria-current[^>]*>[^<]*전국 캠핑장/, '전환 탭에 전국 캠핑장이 있어야 한다');
  assert.match(place, /data-v="garden"[^>]*aria-current[^>]*>[^<]*비밀의 정원/, '전환 탭에 비밀의 정원이 있어야 한다');
  // 각 화면 맨 위에 전환 탭이 붙는다
  const rec = html.slice(html.indexOf('function recView(){'), html.indexOf('function listView(){'));
  assert.match(rec, /var h='';[\s\S]{0,200}h\+=quickGuide\(\);[\s\S]{0,60}h\+=foodSwitch\(\);/, '첫 화면은 빠른 길잡이 → 전환 탭 순서여야 한다');
  assert.match(html, /var h=foodSwitch\(\)\+'<div class="plan-hero">/, '식단표 화면 위에도 전환 탭이 있어야 한다');
  assert.match(html, /h\+=placeSwitch\(\);[\s\S]{0,80}camp-browse-hero/, '캠핑장 화면 위에도 전환 탭이 있어야 한다');
  assert.match(html, /h \+= placeSwitch\(\);[\s\S]{0,120}garden-hero-bar/, '비밀의 정원 화면 위에도 전환 탭이 있어야 한다');

  // ④ 첫 화면 빠른 길잡이 4버튼
  const quickStart = html.indexOf('function quickGuide(){');
  const quickEnd = html.indexOf('function foodSwitch(){', quickStart);
  assert.ok(quickStart > -1 && quickEnd > quickStart, '빠른 길잡이 렌더러가 있어야 한다');
  const quick = html.slice(quickStart, quickEnd);
  for (const label of ['오늘 메뉴 추천', '주간 식단표', '노지·비밀정원', '장보기·준비물']) {
    assert.ok(quick.includes(label), `빠른 길잡이에 ${label} 버튼이 있어야 한다`);
  }
  assert.equal((quick.match(/class="quick-btn"/g) || []).length, 4, '빠른 길잡이 버튼은 4개여야 한다');
  assert.match(quick, /data-a="jump" data-v="rec-cta"/, '오늘 메뉴 추천은 추천 조건 카드로 이동해야 한다');
  assert.match(html, /id="rec-cta"/, '이동 목표(추천 조건 카드)가 있어야 한다');
  assert.match(html, /if\(a==='jump'\)\{[\s\S]{0,160}scrollIntoView/, 'jump 액션이 목표를 부드럽게 스크롤해야 한다');
  assertLegacyEntry();
});
