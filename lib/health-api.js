// 공개 헬스체크 로직 (Express 로컬 서버와 Vercel 서버리스 공용).
//
// GitHub Actions 'Uptime check'(scripts/uptime-check.mjs)가 10분마다 호출한다.
// 로그인 없이 호출할 수 있지만 개인 데이터는 담지 않고, 저장소 연결 여부만 알린다.
//  - 운영: Firestore 문서 하나를 읽어 연결·권한을 확인한다(없는 문서 읽기도 권한 검증이 된다)
//  - 로컬(FIREBASE_SERVICE_ACCOUNT 없음): 파일 저장소 모드로 정상

import { getFirestoreDatabase, publicStorageErrorCode } from './firebase-admin.js';

export function createHealthApi(options = {}) {
  const env = options.env || process.env;
  const getDb = options.getFirestoreDatabase || getFirestoreDatabase;
  const now = options.now || (() => new Date());

  return async function handleHealth(req, res) {
    const method = String(req?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      try { res.setHeader('Allow', 'GET'); } catch {}
      return res.status(405).json({ ok: false, code: 'method_not_allowed' });
    }

    const started = Date.now();
    const time = now().toISOString();

    if (!String(env.FIREBASE_SERVICE_ACCOUNT || '').trim()) {
      if (env.VERCEL === '1' || env.VERCEL_ENV) {
        return res.status(503).json({ ok: false, storage: 'unconfigured', code: 'storage_not_configured', time, ms: Date.now() - started });
      }
      return res.status(200).json({ ok: true, storage: 'local', time, ms: Date.now() - started });
    }

    try {
      const db = getDb();
      await db.collection('_health').doc('global').get();
      return res.status(200).json({ ok: true, storage: 'firestore', time, ms: Date.now() - started });
    } catch (error) {
      const code = publicStorageErrorCode(error) || 'storage_unavailable';
      console.error('[Health]', code, error?.message || error);
      return res.status(503).json({ ok: false, storage: 'firestore', code, time, ms: Date.now() - started });
    }
  };
}
