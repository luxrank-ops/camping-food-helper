#!/usr/bin/env node
// 무중단 헬스체크: 프런트엔드, 서버리스 함수 3개, 외부 날씨 API(Open-Meteo)를 점검한다.
//
// 판정 규칙
//  - 기대한 상태 코드가 아니거나, 응답이 5초(SLOW_MS)를 넘거나, 연결이 실패하면 장애.
//  - 장애로 보이면 3초 뒤 한 번 더 확인한다(일시적인 콜드 스타트 오탐 방지).
//  - 서버리스 POST 엔드포인트는 빈 요청({})을 보낸다. 서버는 프롬프트가 없다며 400을 돌려주므로
//    함수가 살아 있고 요청 처리까지 도달한다는 뜻이다. Gemini는 호출되지 않아 API 쿼터를 쓰지 않는다.
//
// 알림
//  - 장애가 있으면 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID로 텔레그램 메시지를 보낸다.
//  - 실패 시 종료 코드 1로 끝나므로 GitHub Actions 실패 메일도 함께 받는다.
//
// 환경변수 (모두 선택)
//  UPTIME_BASE_URL     기본 https://camping-food-helper.vercel.app
//  UPTIME_WEATHER_URL  기본 Open-Meteo 가평 좌표 예보 URL
//  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

import { appendFileSync } from 'node:fs';

const BASE_URL = (process.env.UPTIME_BASE_URL || 'https://camping-food-helper.vercel.app').replace(/\/+$/, '');
const WEATHER_URL = process.env.UPTIME_WEATHER_URL
  || 'https://api.open-meteo.com/v1/forecast?latitude=37.8311&longitude=127.5097&current=temperature_2m';

export const SLOW_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 3000;

export const CHECKS = [
  {
    name: '프론트엔드 (메인 페이지)',
    method: 'GET',
    url: `${BASE_URL}/`,
    expectStatus: 200,
  },
  {
    name: '서버리스 /api/sample',
    method: 'POST',
    url: `${BASE_URL}/api/sample`,
    body: {},
    expectStatus: 400, // 빈 요청 → 400이면 정상 (Gemini 미호출)
  },
  {
    name: '서버리스 /api/generate-image',
    method: 'POST',
    url: `${BASE_URL}/api/generate-image`,
    body: {},
    expectStatus: 400, // 빈 요청 → 400이면 정상 (이미지 생성 미호출)
  },
  {
    name: '서버리스 /api/secret-gardens (Firestore 읽기)',
    method: 'GET',
    url: `${BASE_URL}/api/secret-gardens`,
    expectStatus: 200,
    validateBody: (text) => {
      const json = JSON.parse(text);
      return json?.authorized === false && Array.isArray(json?.gardens)
        ? null
        : '공개 스팟 목록 응답이 올바르지 않음';
    },
  },
  {
    name: 'Open-Meteo 날씨 API',
    method: 'GET',
    url: WEATHER_URL,
    expectStatus: 200,
    validateBody: (text) => {
      const json = JSON.parse(text);
      return typeof json?.current?.temperature_2m === 'number' ? null : '응답에 current.temperature_2m이 없음';
    },
  },
];

/** 한 번 요청해서 결과 객체를 만든다. 예외를 던지지 않는다. */
export async function probe(check, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const init = {
      method: check.method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'User-Agent': 'camping-food-helper-uptime/1.0' },
    };
    if (check.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(check.body);
    }
    const res = await fetchImpl(check.url, init);
    const text = await res.text();
    const elapsedMs = Date.now() - started;

    if (res.status !== check.expectStatus) {
      return { ok: false, elapsedMs, reason: `HTTP ${res.status} (기대값 ${check.expectStatus})` };
    }
    if (check.validateBody) {
      let problem = null;
      try { problem = check.validateBody(text); } catch (e) { problem = `본문 파싱 실패: ${e.message}`; }
      if (problem) return { ok: false, elapsedMs, reason: problem };
    }
    if (elapsedMs > SLOW_MS) {
      return { ok: false, elapsedMs, reason: `응답 지연 ${elapsedMs}ms (기준 ${SLOW_MS}ms 초과)` };
    }
    return { ok: true, elapsedMs, reason: `HTTP ${res.status}` };
  } catch (e) {
    const elapsedMs = Date.now() - started;
    const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `연결 시간 초과 (${REQUEST_TIMEOUT_MS}ms)`
      : `요청 실패: ${e?.cause?.code || e?.message || e}`;
    return { ok: false, elapsedMs, reason };
  }
}

/** 실패하면 한 번 더 확인하고, 두 번째 결과를 최종 결과로 쓴다. */
export async function checkWithRetry(check, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const first = await probe(check, fetchImpl);
  if (first.ok) return { ...first, retried: false };
  await sleep(RETRY_DELAY_MS);
  const second = await probe(check, fetchImpl);
  return { ...second, retried: true, firstReason: first.reason };
}

export function buildAlertText(failures, when = new Date()) {
  const lines = failures.map((f) => `• ${f.name}: ${f.reason} (${f.elapsedMs}ms)`);
  return [
    `🚨 캠핑음식 도우미 장애 감지`,
    `시각: ${when.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)`,
    ...lines,
    `확인: ${BASE_URL}`,
  ].join('\n');
}

async function sendTelegram(text, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('::warning::TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID가 없어 텔레그램 알림을 보내지 않았습니다.');
    return false;
  }
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 토큰이 로그에 남지 않도록 응답 본문은 출력하지 않는다
    console.error(`텔레그램 전송 실패: HTTP ${res.status}`);
    return false;
  }
  return true;
}

function writeSummary(results) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = results.map((r) =>
    `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.reason}${r.retried ? ' (재확인)' : ''} | ${r.elapsedMs}ms |`);
  appendFileSync(file, [
    `### 헬스체크 ${new Date().toISOString()}`,
    '',
    '| 결과 | 대상 | 상세 | 응답 시간 |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n'));
}

async function main() {
  const results = [];
  for (const check of CHECKS) {
    const r = await checkWithRetry(check);
    results.push({ name: check.name, ...r });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${check.name} — ${r.reason} (${r.elapsedMs}ms)${r.retried ? ' [재확인 후 결과]' : ''}`);
  }
  writeSummary(results);

  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    console.log('✔ 모든 점검 통과');
    return;
  }

  try {
    await sendTelegram(buildAlertText(failures));
  } catch (e) {
    console.error(`텔레그램 전송 중 오류: ${e?.name || 'Error'}`);
  }
  console.error(`✖ 장애 ${failures.length}건`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('uptime-check.mjs')) {
  await main();
}
