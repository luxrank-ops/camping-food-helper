import { getVisitorStatsStore, kstDateKey, normalizeStats } from './visitor-stats-store.js';

// 방문자 카운터 API (Express 로컬 서버와 Vercel 서버리스 함수가 같은 로직을 쓴다)
//
//   GET  /api/visitor-stats  → 오늘 방문자·누적 방문자를 읽기만 한다 (카운트 증가 없음)
//   POST /api/visitor-stats  → 이번 방문을 센 뒤 오늘·누적 값을 돌려준다
//
// 세는 기준
//  - '오늘'은 한국 시간(KST) 기준 날짜다. 서버 타임존이 UTC여도 기준이 같다.
//  - 클라이언트는 브라우저당 하루에 한 번만 POST한다(localStorage).
//  - 서버는 같은 방문자(아이피+방문자 아이디)의 짧은 시간 반복 요청과
//    한 아이피의 과도한 요청을 세지 않는다(부풀리기 방지, 인메모리 베스트 에포트).

const DEFAULT_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_PER_IP_PER_DAY = 24;
const MAX_TRACKED_ENTRIES = 5000;

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.publicMessage = message;
  return error;
}

function parseBody(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw httpError(400, 'invalid_json', '요청 내용을 읽을 수 없습니다.');
    }
  }
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw httpError(400, 'invalid_json', '요청 내용이 올바르지 않습니다.');
  }
  return req.body;
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const ip = forwarded
    || String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  return ip ? ip.slice(0, 64) : 'unknown';
}

function normalizeVisitorId(value) {
  const id = String(value || '').trim();
  if (!id) return '';
  return id.slice(0, 64);
}

function pruneOldEntries(map, now, ttlMs) {
  if (map.size <= MAX_TRACKED_ENTRIES) return;
  for (const [key, value] of map) {
    const at = typeof value === 'number' ? value : Number(value?.at) || 0;
    if (now - at > ttlMs) map.delete(key);
  }
  if (map.size <= MAX_TRACKED_ENTRIES) return;
  // 그래도 많으면 가장 오래된 것부터 정리한다
  const keys = [...map.entries()]
    .sort((a, b) => {
      const at = (x) => (typeof x[1] === 'number' ? x[1] : Number(x[1]?.at) || 0);
      return at(a) - at(b);
    })
    .slice(0, Math.ceil(map.size / 2))
    .map(([key]) => key);
  keys.forEach((key) => map.delete(key));
}

function respond(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

export function createVisitorStatsApi(options = {}) {
  const store = options.store || null;
  const getStore = options.getStore || (() => store || getVisitorStatsStore());
  const clock = options.clock || (() => new Date());
  const minIntervalMs = options.minIntervalMs == null ? DEFAULT_MIN_INTERVAL_MS : Number(options.minIntervalMs);
  const maxPerIpPerDay = options.maxPerIpPerDay == null
    ? DEFAULT_MAX_PER_IP_PER_DAY
    : Number(options.maxPerIpPerDay);
  const now = options.now || (() => Date.now());

  const lastCounted = new Map(); // `${ip}|${visitorId}` → 마지막 카운트 시각
  const perIpDay = new Map();    // `${ip}|${dateKey}` → { count: 오늘 카운트 횟수, at: 마지막 시각 }

  async function statsPayload(dateKey, extra = {}) {
    const stats = normalizeStats(await getStore().read());
    return {
      success: true,
      date: dateKey,
      today: stats.days[dateKey] || 0,
      total: stats.total,
      source: getStore().kind || 'server',
      ...extra
    };
  }

  return async function visitorStatsApi(req, res) {
    const dateKey = kstDateKey(clock());
    try {
      const method = String(req?.method || 'GET').toUpperCase();
      const statsStore = getStore();

      if (method === 'GET') {
        return respond(res, 200, await statsPayload(dateKey, { counted: false }));
      }

      if (method === 'POST') {
        const body = parseBody(req);
        const ip = clientIp(req);
        const visitorId = normalizeVisitorId(body.visitorId);
        const visitKey = `${ip}|${visitorId}`;
        const ipDayKey = `${ip}|${dateKey}`;
        const timestamp = now();

        pruneOldEntries(lastCounted, timestamp, Math.max(minIntervalMs, 60 * 60 * 1000));
        pruneOldEntries(perIpDay, timestamp, 24 * 60 * 60 * 1000);

        const last = Number(lastCounted.get(visitKey)) || 0;
        const ipEntry = perIpDay.get(ipDayKey);
        const ipCount = Number(ipEntry?.count) || 0;
        const tooSoon = last && timestamp - last < minIntervalMs;
        const tooMany = ipCount >= maxPerIpPerDay;

        if (tooSoon || tooMany) {
          return respond(res, 200, await statsPayload(dateKey, {
            counted: false,
            reason: tooMany ? 'daily_ip_limit' : 'duplicate_visit'
          }));
        }

        const counted = await statsStore.countVisit(dateKey);
        lastCounted.set(visitKey, timestamp);
        perIpDay.set(ipDayKey, { count: ipCount + 1, at: timestamp });

        return respond(res, 200, {
          success: true,
          date: dateKey,
          today: counted.today,
          total: counted.total,
          counted: true,
          source: statsStore.kind || 'server'
        });
      }

      res.setHeader?.('Allow', 'GET, POST');
      throw httpError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      const message = error?.publicMessage || (statusCode >= 500
        ? '방문자 카운터 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'
        : error?.message || '요청을 처리하지 못했습니다.');
      if (statusCode >= 500) {
        console.error('[Visitor stats API]', error?.code || 'server_error');
      }
      return respond(res, statusCode, {
        success: false,
        date: dateKey,
        counted: false,
        code: error?.code || 'server_error',
        error: message
      });
    }
  };
}
