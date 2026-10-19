// 방문자 카운터(오늘 방문자 · 누적 방문자) 회귀 테스트 (node --test)
// 대상: lib/visitor-stats-store.js, lib/visitor-stats-api.js, api/visitor-stats.js,
//       server.js 라우트, index.html/camp-kitchen.html의 플로팅 위젯
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFileVisitorStatsStore,
  kstDateKey,
  normalizeStats,
  pruneDays,
  resetVisitorStatsStoreForTests
} from '../lib/visitor-stats-store.js';
import { createVisitorStatsApi } from '../lib/visitor-stats-api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const kitchen = fs.readFileSync(path.join(ROOT, 'camp-kitchen.html'), 'utf8');

function createMemoryStatsStore(initial = null) {
  const stats = normalizeStats(initial);
  return {
    kind: 'memory',
    async read() { return normalizeStats(stats); },
    async countVisit(dateKey) {
      stats.days[dateKey] = (stats.days[dateKey] || 0) + 1;
      stats.total += 1;
      return { date: dateKey, today: stats.days[dateKey], total: stats.total };
    }
  };
}

async function callApi(api, { method = 'GET', body = {}, headers = {} } = {}) {
  const response = {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
  await api({ method, body, headers, ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } }, response);
  return response;
}

test('KST 기준 날짜와 저장값 정리가 서버 타임존과 무관하게 동작한다', () => {
  // UTC 15:30은 한국 시간으로 다음 날 00:30이다
  assert.equal(kstDateKey(new Date('2026-10-19T15:30:00Z')), '2026-10-20');
  assert.equal(kstDateKey(new Date('2026-10-19T14:59:59Z')), '2026-10-19');

  const normalized = normalizeStats({ total: '12', days: { '2026-10-19': '3', 'bad-key': 9, '2026-10-18': 0 } });
  assert.deepEqual(normalized, { total: 12, days: { '2026-10-19': 3 } });
  assert.deepEqual(normalizeStats(null), { total: 0, days: {} });

  // 400일보다 오래된 일자별 카운트는 잘라 내고 누적값은 유지한다
  const pruned = pruneDays({ '2024-01-01': 5, '2026-10-19': 2 }, 400, '2026-10-19');
  assert.deepEqual(pruned, { '2026-10-19': 2 });
});

test('로컬 파일 저장소는 오늘 방문자와 누적 방문자를 함께 올린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visit-stats-'));
  const file = path.join(dir, 'visitor_stats.json');
  const store = createFileVisitorStatsStore(file);

  assert.deepEqual(await store.read(), { total: 0, days: {} });

  const first = await store.countVisit('2026-10-19');
  assert.deepEqual(first, { date: '2026-10-19', today: 1, total: 1 });

  const second = await store.countVisit('2026-10-19');
  assert.deepEqual(second, { date: '2026-10-19', today: 2, total: 2 });

  const nextDay = await store.countVisit('2026-10-20');
  assert.equal(nextDay.today, 1, '새 날은 오늘 방문자가 1부터 다시 센다');
  assert.equal(nextDay.total, 3, '누적 방문자는 계속 쌓인다');

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.days, { '2026-10-19': 2, '2026-10-20': 1 });
  assert.equal(saved.total, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GET은 숫자를 읽기만 하고 POST만 방문을 센다', async () => {
  const store = createMemoryStatsStore({ total: 41, days: { '2026-10-19': 7 } });
  const api = createVisitorStatsApi({ store, clock: () => new Date('2026-10-19T03:00:00Z') });

  const read = await callApi(api, { method: 'GET' });
  assert.equal(read.statusCode, 200);
  assert.deepEqual(
    { date: read.payload.date, today: read.payload.today, total: read.payload.total, counted: read.payload.counted },
    { date: '2026-10-19', today: 7, total: 41, counted: false }
  );

  const counted = await callApi(api, { method: 'POST', body: { visitorId: 'v-abc' } });
  assert.equal(counted.statusCode, 200);
  assert.equal(counted.payload.counted, true);
  assert.equal(counted.payload.today, 8);
  assert.equal(counted.payload.total, 42);
});

test('같은 방문자의 짧은 시간 반복 요청과 아이피당 과도한 요청은 세지 않는다', async () => {
  const store = createMemoryStatsStore();
  let clockMs = Date.UTC(2026, 9, 19, 3, 0, 0);
  const api = createVisitorStatsApi({
    store,
    clock: () => new Date(clockMs),
    now: () => clockMs,
    minIntervalMs: 60_000,
    maxPerIpPerDay: 2
  });

  const first = await callApi(api, { method: 'POST', body: { visitorId: 'v-same' } });
  assert.equal(first.payload.counted, true);
  assert.equal(first.payload.total, 1);

  // 새로고침·탭 여러 개처럼 같은 방문자가 바로 다시 요청하면 중복으로 세지 않는다
  const duplicate = await callApi(api, { method: 'POST', body: { visitorId: 'v-same' } });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.payload.counted, false);
  assert.equal(duplicate.payload.reason, 'duplicate_visit');
  assert.equal(duplicate.payload.total, 1, '숫자는 그대로 읽을 수 있어야 한다');

  // 1분이 지나면 다시 센다
  clockMs += 61_000;
  const later = await callApi(api, { method: 'POST', body: { visitorId: 'v-same' } });
  assert.equal(later.payload.counted, true);
  assert.equal(later.payload.total, 2);

  // 같은 아이피의 하루 한도를 넘기면 더 세지 않는다
  clockMs += 61_000;
  const limited = await callApi(api, { method: 'POST', body: { visitorId: 'v-other' } });
  assert.equal(limited.payload.counted, false);
  assert.equal(limited.payload.reason, 'daily_ip_limit');
  assert.equal(limited.payload.total, 2);
});

test('다른 아이피의 방문자는 각각 센다', async () => {
  const store = createMemoryStatsStore();
  const api = createVisitorStatsApi({ store, clock: () => new Date('2026-10-19T03:00:00Z') });

  const callFrom = async (ip, visitorId) => {
    const res = {
      statusCode: 200, payload: null, headers: {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
      setHeader(name, value) { this.headers[name] = value; }
    };
    await api({ method: 'POST', body: { visitorId }, headers: { 'x-forwarded-for': ip } }, res);
    return res;
  };

  assert.equal((await callFrom('198.51.100.1', 'v-1')).payload.total, 1);
  assert.equal((await callFrom('198.51.100.2', 'v-2')).payload.total, 2);
  const stats = await store.read();
  assert.deepEqual(stats, { total: 2, days: { '2026-10-19': 2 } });
});

test('지원하지 않는 메서드는 405, 저장소 미설정은 503으로 실패를 알린다', async () => {
  const store = createMemoryStatsStore();
  const api = createVisitorStatsApi({ store, clock: () => new Date('2026-10-19T03:00:00Z') });
  const notAllowed = await callApi(api, { method: 'DELETE' });
  assert.equal(notAllowed.statusCode, 405);
  assert.equal(notAllowed.payload.code, 'method_not_allowed');
  assert.equal(notAllowed.headers.Allow, 'GET, POST');

  const unavailable = () => {
    const error = new Error('저장소 미설정');
    error.code = 'storage_not_configured';
    error.statusCode = 503;
    error.publicMessage = '방문자 카운터 저장소가 아직 설정되지 않았습니다.';
    throw error;
  };
  const failingApi = createVisitorStatsApi({ getStore: unavailable });
  const failed = await callApi(failingApi, { method: 'POST', body: { visitorId: 'v-1' } });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.payload.success, false);
  assert.equal(failed.payload.counted, false);
  assert.equal(failed.payload.code, 'storage_not_configured');
});

test('Vercel·Express 양쪽에서 같은 방문자 카운터 API를 쓴다', () => {
  const vercelRoute = fs.readFileSync(path.join(ROOT, 'api', 'visitor-stats.js'), 'utf8');
  assert.match(vercelRoute, /createVisitorStatsApi\(\)/);
  assert.match(vercelRoute, /visitorStatsApi\(req, res\)/);

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /import \{ createVisitorStatsApi \} from '\.\/lib\/visitor-stats-api\.js'/);
  assert.match(server, /app\.all\('\/api\/visitor-stats', \(req, res\) => visitorStatsApi\(req, res\)\)/);
  // 정적 파일 폴백보다 먼저 등록되어야 API가 index.html을 돌려주지 않는다
  assert.ok(
    server.indexOf("app.all('/api/visitor-stats'") < server.indexOf('app.use(express.static(__dirname))'),
    '방문자 카운터 라우트는 정적 파일 처리보다 먼저 등록되어야 한다'
  );
});

test('플로팅 위젯: 오늘 방문자·누적 방문자가 #app 밖에 떠 있고 두 HTML이 같다', () => {
  for (const [name, doc] of [['index.html', html], ['camp-kitchen.html', kitchen]]) {
    // 마크업: 하단 탭바를 가리지 않는 고정 플로팅 + 오늘/누적 두 줄
    assert.match(doc, /<aside class="visit-fab" id="visit-fab"/, `${name}: 플로팅 위젯이 있어야 한다`);
    assert.match(doc, /id="visit-today"/, `${name}: 오늘 방문자 숫자 요소가 있어야 한다`);
    assert.match(doc, /id="visit-total"/, `${name}: 누적 방문자 숫자 요소가 있어야 한다`);
    assert.match(doc, /오늘 방문자/, `${name}: 오늘 방문자 라벨이 있어야 한다`);
    assert.match(doc, /누적 방문자/, `${name}: 누적 방문자 라벨이 있어야 한다`);
    assert.match(doc, /data-a="visit-fab-toggle"/, `${name}: 접기·펼치기 버튼이 있어야 한다`);
    assert.match(doc, /class="visit-chip"/, `${name}: 접었을 때 보이는 알약이 있어야 한다`);

    // 화면을 다시 그려도 사라지지 않게 #app 밖에 있어야 한다
    const appIdx = doc.indexOf('<div class="app" id="app"></div>');
    const fabIdx = doc.indexOf('<aside class="visit-fab"');
    assert.ok(appIdx > -1 && fabIdx > appIdx, `${name}: 위젯은 #app 밖에 있어야 한다`);

    // 스타일: 탭바 위에 떠 있고 드래그·접기 상태를 다룬다
    assert.match(doc, /\.visit-fab\{position:fixed;right:12px;bottom:calc\(92px \+ env\(safe-area-inset-bottom,0px\)\);z-index:60/, `${name}: 탭바 위에 고정되어야 한다`);
    assert.match(doc, /\.visit-fab\[data-open="false"\] \.visit-fab-card\{display:none\}/, `${name}: 접으면 카드를 숨긴다`);
    assert.match(doc, /\.visit-fab\[data-open="false"\] \.visit-chip\{display:inline-flex\}/, `${name}: 접으면 알약만 남는다`);

    // 로직: 서버 카운터 호출, KST 기준, 하루 1회, 실패 시 이 기기 폴백
    assert.match(doc, /var VISIT_API='\/api\/visitor-stats'/, `${name}: 방문자 카운터 API를 호출해야 한다`);
    assert.match(doc, /function kstToday\(\)\{return new Date\(Date\.now\(\)\+9\*3600\*1000\)/, `${name}: 오늘 기준은 KST여야 한다`);
    assert.match(doc, /cc\.visitLogged/, `${name}: 하루에 한 번만 세도록 기록해야 한다`);
    assert.match(doc, /function countVisitLocal\(\)/, `${name}: 서버가 없을 때 이 기기 기준 폴백이 있어야 한다`);
    assert.match(doc, /'이 기기'/, `${name}: 폴백 상태는 배지로 구분해야 한다`);
    assert.match(doc, /initVisitorCounter\(\);/, `${name}: 시작할 때 방문자 카운터를 초기화해야 한다`);
    assert.match(doc, /function initVisitFabDrag\(\)/, `${name}: 드래그로 위치를 옮길 수 있어야 한다`);
    assert.ok(
      doc.indexOf('initVisitorCounter();') < doc.indexOf('loadSecretGardens(false);\n  })();'),
      `${name}: 초기화는 앱 시작 흐름에서 호출되어야 한다`
    );
  }
  assert.equal(html, kitchen, 'index.html과 camp-kitchen.html은 같은 내용이어야 한다');
});

test('로컬 방문자 통계 파일은 저장소에 커밋되지 않는다', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /data\/visitor_stats\.json/, '실행 중 만들어지는 카운트 파일은 무시해야 한다');
  resetVisitorStatsStoreForTests();
});

/* ---------- 클라이언트 플로팅 위젯 동작 테스트 (최소 DOM 스텁) ----------
   index.html에서 방문자 카운터 블록만 잘라 내어, 브라우저 스텁과 함께 실행한다.
   문자열 존재 검사가 아니라 "하루 한 번만 센다 / 서버가 없으면 이 기기 기준으로 센다"
   같은 실제 동작을 확인한다. */

function extractWidgetSource(doc) {
  const start = doc.indexOf("var VISIT_API='/api/visitor-stats';");
  const end = doc.indexOf('function executeDeleteGarden(id, password){', start);
  assert.ok(start > -1 && end > start, '방문자 카운터 클라이언트 블록을 찾을 수 있어야 한다');
  return doc.slice(start, end);
}

function createWidgetEnv({ fetchImpl, storage = {}, reducedMotion = true } = {}) {
  const elements = {};
  const makeEl = (id) => ({
    id,
    textContent: '',
    className: '',
    style: {},
    attributes: {},
    classList: { add() {}, remove() {} },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    getBoundingClientRect: () => ({ width: 196, height: 98, right: 402, bottom: 682 }),
    addEventListener() {}
  });
  const el = (id) => (elements[id] || (elements[id] = makeEl(id)));

  const store = {
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(storage, key) ? JSON.parse(storage[key]) : fallback;
    },
    set(key, value) { storage[key] = JSON.stringify(value); }
  };
  const timers = [];
  const browserWindow = {
    innerWidth: 414,
    innerHeight: 780,
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener() {}
  };
  const documentStub = { getElementById: (id) => (id === 'visit-fab' || id.startsWith('visit-') ? el(id) : null) };

  const factory = new Function(
    'store', 'str', 'document', 'window', 'fetch', 'setInterval', 'clearInterval',
    `${extractWidgetSource(html)}
     return {
       visit: visit, kstToday: kstToday, fmtVisit: fmtVisit,
       syncVisitCounter: syncVisitCounter, countVisitLocal: countVisitLocal,
       paintVisit: paintVisit, setVisitFabOpen: setVisitFabOpen
     };`
  );
  const api = factory(
    store,
    (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v)),
    documentStub,
    browserWindow,
    fetchImpl,
    (fn, ms) => (timers.push({ fn, ms }), timers.length),
    () => {}
  );
  return { api, el, storage, timers };
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

test('위젯: 서버 카운터가 있으면 첫 방문을 POST로 기록하고 오늘·누적 숫자를 그린다', async () => {
  const calls = [];
  const env = createWidgetEnv({
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return jsonResponse({ success: true, date: '2026-10-19', today: 3, total: 42, counted: true });
    }
  });

  await env.api.syncVisitCounter();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/visitor-stats');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body, /"visitorId":"v/, '방문자 아이디를 함께 보내 하루 한 번만 세야 한다');
  assert.equal(env.api.visit.mode, 'live');
  assert.equal(env.el('visit-today').textContent, '3');
  assert.equal(env.el('visit-total').textContent, '42');
  assert.equal(env.el('visit-badge').textContent, '전체');
  assert.equal(env.storage['cc.visitLogged'], JSON.stringify(env.api.kstToday()), '오늘 날짜를 기록해 다시 세지 않게 한다');
  assert.ok(env.api.fmtVisit(1234567) === '1,234,567', '누적 방문자는 자릿수 구분으로 표시한다');
});

test('위젯: 오늘 이미 기록했으면 다시 세지 않고 읽기만 한다', async () => {
  const calls = [];
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const env = createWidgetEnv({
    storage: { 'cc.visitLogged': JSON.stringify(today) },
    fetchImpl: async (url, opts) => {
      calls.push((opts && opts.method) || 'GET');
      return jsonResponse({ success: true, date: today, today: 8, total: 99, counted: false });
    }
  });

  await env.api.syncVisitCounter();

  assert.deepEqual(calls, ['GET'], '하루에 한 번만 POST해야 한다');
  assert.equal(env.el('visit-today').textContent, '8');
  assert.equal(env.el('visit-total').textContent, '99');
});

test('위젯: 서버 카운터가 없으면(정적 호스팅·오프라인) 이 기기 기준으로 세고 배지로 알린다', async () => {
  // Firebase Hosting처럼 API 경로가 index.html(HTML)로 rewrite되는 상황
  const htmlResponse = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const env = createWidgetEnv({ fetchImpl: async () => htmlResponse });

  await env.api.syncVisitCounter();

  assert.equal(env.api.visit.mode, 'local');
  assert.equal(env.api.visit.today, 1);
  assert.equal(env.api.visit.total, 1);
  assert.equal(env.el('visit-badge').textContent, '이 기기');
  assert.equal(env.el('visit-badge').className, 'visit-badge local');
  assert.equal(env.storage['cc.visitLogged'], undefined, '서버 카운트가 성공한 게 아니므로 다시 시도할 수 있어야 한다');

  // 같은 날 다시 열면 이 기기에서도 두 번 세지 않는다
  await env.api.syncVisitCounter();
  assert.equal(env.api.visit.total, 1);

  // 네트워크 오류도 같은 폴백을 쓴다
  const offline = createWidgetEnv({ fetchImpl: async () => { throw new Error('network'); } });
  await offline.api.syncVisitCounter();
  assert.equal(offline.api.visit.mode, 'local');
  assert.match(offline.el('visit-note').textContent, /이 기기 방문만/);
});

test('위젯: 오프라인이어도 오늘 받아 둔 서버 숫자를 캐시로 보여 준다', async () => {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const env = createWidgetEnv({
    storage: {
      'cc.visitLogged': JSON.stringify(today),
      'cc.visitCache': JSON.stringify({ date: today, today: 5, total: 77, at: Date.now() })
    },
    fetchImpl: async () => { throw new Error('offline'); }
  });

  await env.api.syncVisitCounter();

  assert.equal(env.api.visit.mode, 'live');
  assert.equal(env.el('visit-today').textContent, '5');
  assert.equal(env.el('visit-total').textContent, '77');
  assert.equal(env.storage['cc.visitLocal'], undefined, '서버 숫자를 알고 있으면 이 기기 카운트를 만들지 않는다');
});

test('위젯: 접으면 알약만 남고 상태는 기기에 저장된다', async () => {
  const env = createWidgetEnv({ fetchImpl: async () => jsonResponse({ success: true, today: 2, total: 15, counted: false }) });
  await env.api.syncVisitCounter();

  env.api.setVisitFabOpen(false);
  assert.equal(env.el('visit-fab').attributes['data-open'], 'false');
  assert.equal(env.el('visit-fab-toggle').attributes['aria-expanded'], 'false');
  assert.equal(env.el('visit-chip-today').textContent, '2');
  assert.equal(env.el('visit-chip-total').textContent, '15');
  assert.equal(env.storage['cc.visitFabOpen'], 'false');

  env.api.setVisitFabOpen(true);
  assert.equal(env.el('visit-fab').attributes['data-open'], 'true');
  assert.equal(env.storage['cc.visitFabOpen'], 'true');
});
