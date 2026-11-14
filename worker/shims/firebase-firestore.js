// 'firebase-admin/firestore' 대체 구현 (Cloudflare Workers).
//
// lib/firebase-admin.js 의 getFirestore(getFirebaseAdminApp()) 한 줄만 만족하면 되고,
// 실제 동작은 worker/firestore-rest.js 의 REST 클라이언트가 맡는다.

import { createRestFirestore } from '../firestore-rest.js';

const databases = new Map();

export function getFirestore(app) {
  const options = app?.options || {};
  const credential = options.credential || {};
  const projectId = String(
    credential.projectId || options.projectId || ''
  ).trim();

  const cacheKey = `${app?.name || '[DEFAULT]'}|${projectId}|${String(credential.clientEmail || '').length}`;
  const cached = databases.get(cacheKey);
  if (cached) return cached;

  const db = createRestFirestore({
    projectId,
    clientEmail: credential.clientEmail || '',
    privateKey: credential.privateKey || ''
  });
  databases.set(cacheKey, db);
  return db;
}

/** 테스트용 */
export function resetFirestoreShimForTests() {
  databases.clear();
}
