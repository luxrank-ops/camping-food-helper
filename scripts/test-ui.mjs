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
  assert.equal(html, kitchen, 'index.html과 camp-kitchen.html은 같은 내용이어야 한다');
});
