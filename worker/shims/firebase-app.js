// 'firebase-admin/app' 대체 구현 (Cloudflare Workers).
//
// lib/firebase-admin.js 는 firebase-admin 의 app 모듈에서 cert·getApps·initializeApp 만 쓴다.
// Workers 에서는 실제 서비스 계정 자격을 그대로 들고 있다가
// Firestore/Storage 쪽 shim 이 REST 호출에 쓰도록 보관만 한다.

const apps = new Map();

export function cert(serviceAccount) {
  const account = serviceAccount || {};
  return {
    projectId: account.project_id || '',
    clientEmail: account.client_email || '',
    privateKey: String(account.private_key || '').replace(/\\n/g, '\n')
  };
}

export function initializeApp(options = {}, name = '[DEFAULT]') {
  const app = { name, options };
  apps.set(name, app);
  return app;
}

export function getApps() {
  return [...apps.values()];
}

export function getApp(name = '[DEFAULT]') {
  return apps.get(name) || initializeApp({}, name);
}

export function deleteApp(app) {
  if (!app) return Promise.resolve();
  apps.delete(app.name);
  return Promise.resolve();
}
