import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDatabase } from './firebase-admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 방문자 카운터 저장소 (오늘 방문자 · 누적 방문자)
// - 운영(Vercel): Firebase Firestore 문서 하나(_visitorStats/global)에 누적·일자별 카운트를 저장
// - 로컬(npm run dev): data/visitor_stats.json 파일에 저장
// - 저장소 미설정: 503으로 실패를 알린다 (클라이언트는 이 기기 기준 카운트로 폴백)
export const DEFAULT_STATS_FILE = path.join(__dirname, '..', 'data', 'visitor_stats.json');
const DEFAULT_COLLECTION = '_visitorStats';
const STATS_DOC_ID = 'global';
// 문서/파일 크기가 계속 커지지 않도록 최근 400일만 남긴다 (누적 값은 total에 따로 보관)
const KEEP_DAYS = 400;
let sharedStore = null;

function storageError(code, statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

/**
 * 한국 시간(KST, UTC+9) 기준 날짜 키(YYYY-MM-DD).
 * 서버 타임존이 UTC여도 '오늘 방문자' 기준이 어긋나지 않게 한다.
 */
export function kstDateKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const ms = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 저장된 값(혹은 손상된 값)을 안전한 형태 { total, days } 로 정리한다. */
export function normalizeStats(raw) {
  const total = Math.max(0, Math.floor(Number(raw?.total) || 0));
  const source = raw?.days && typeof raw.days === 'object' && !Array.isArray(raw.days) ? raw.days : {};
  const days = {};
  for (const [key, value] of Object.entries(source)) {
    const count = Math.floor(Number(value) || 0);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && count > 0) days[key] = count;
  }
  return { total, days };
}

/** 오늘 기준으로 keepDays일보다 오래된 일자별 카운트를 잘라 낸다. */
export function pruneDays(days, keepDays = KEEP_DAYS, todayKey = kstDateKey()) {
  const cutoffDate = new Date(`${todayKey}T00:00:00Z`);
  if (!Number.isFinite(cutoffDate.getTime())) return { ...days };
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - Math.max(1, keepDays));
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  const pruned = {};
  for (const [key, value] of Object.entries(days)) {
    if (key >= cutoff) pruned[key] = value;
  }
  return pruned;
}

function countInto(stats, dateKey) {
  const next = normalizeStats(stats);
  next.days[dateKey] = (next.days[dateKey] || 0) + 1;
  next.total += 1;
  next.days = pruneDays(next.days, KEEP_DAYS, dateKey);
  next.updatedAt = new Date().toISOString();
  return { stats: next, today: next.days[dateKey] || 0, total: next.total };
}

export function createFileVisitorStatsStore(filePath = DEFAULT_STATS_FILE) {
  function read() {
    try {
      if (!fs.existsSync(filePath)) return normalizeStats(null);
      return normalizeStats(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.error('[Visitor stats] Failed to read local store:', error?.message || error);
      throw storageError(
        'local_store_unavailable',
        500,
        '방문자 통계 파일을 읽지 못했습니다. 잠시 후 다시 시도해주세요.'
      );
    }
  }

  function write(stats) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(stats, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      console.error('[Visitor stats] Failed to write local store:', error?.message || error);
      throw storageError(
        'local_store_write_failed',
        500,
        '서버에서 방문자 수를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.'
      );
    }
  }

  return {
    kind: 'file',
    async read() {
      return read();
    },
    async countVisit(dateKey = kstDateKey()) {
      const result = countInto(read(), dateKey);
      write(result.stats);
      return { date: dateKey, today: result.today, total: result.total };
    }
  };
}

export function createFirestoreVisitorStatsStore(db, collectionName = DEFAULT_COLLECTION) {
  const ref = db.collection(collectionName).doc(STATS_DOC_ID);

  return {
    kind: 'firestore',
    async read() {
      const snapshot = await ref.get();
      return normalizeStats(snapshot.exists ? snapshot.data() : null);
    },
    async countVisit(dateKey = kstDateKey()) {
      // 동시에 들어오는 방문이 서로 덮어쓰지 않도록 트랜잭션으로 읽기 → +1 → 쓰기를 묶는다.
      const next = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        const result = countInto(snapshot.exists ? snapshot.data() : null, dateKey);
        transaction.set(ref, result.stats);
        return result;
      });
      return { date: dateKey, today: next.today, total: next.total };
    }
  };
}

function createUnavailableVisitorStatsStore() {
  const unavailable = async () => {
    throw storageError(
      'storage_not_configured',
      503,
      '방문자 카운터 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase Firestore 설정을 요청해주세요.'
    );
  };
  return { kind: 'unavailable', read: unavailable, countVisit: unavailable };
}

export function getVisitorStatsStore() {
  if (sharedStore) return sharedStore;

  if (String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()) {
    sharedStore = createFirestoreVisitorStatsStore(getFirestoreDatabase());
    return sharedStore;
  }

  // Vercel 서버리스의 파일 시스템은 요청이 끝나면 사라지므로 파일 저장을 쓰지 않는다.
  if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) {
    sharedStore = createUnavailableVisitorStatsStore();
    return sharedStore;
  }

  sharedStore = createFileVisitorStatsStore();
  return sharedStore;
}

export function resetVisitorStatsStoreForTests() {
  sharedStore = null;
}
