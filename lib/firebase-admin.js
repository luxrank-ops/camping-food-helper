import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const ADMIN_APP_NAME = 'camping-food-helper-server';
let adminApp = null;

function configError(code, publicMessage) {
  const error = new Error(publicMessage);
  error.code = code;
  error.statusCode = 503;
  error.publicMessage = publicMessage;
  return error;
}

function readServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) {
    throw configError(
      'storage_not_configured',
      '서버 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase Firestore 설정을 요청해주세요.'
    );
  }

  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    throw configError(
      'firebase_credentials_invalid',
      'Firebase 서버 인증 설정을 읽을 수 없습니다. 운영자에게 설정 확인을 요청해주세요.'
    );
  }

  if (!account || typeof account !== 'object' || Array.isArray(account) ||
      !account.client_email || !account.private_key) {
    throw configError(
      'firebase_credentials_invalid',
      'Firebase 서버 인증 설정에 필수 항목이 없습니다. 운영자에게 설정 확인을 요청해주세요.'
    );
  }

  const projectId = String(process.env.FIREBASE_PROJECT_ID || account.project_id || '').trim();
  if (!projectId) {
    throw configError(
      'firebase_project_not_configured',
      'Firebase 프로젝트 ID가 설정되지 않았습니다. 운영자에게 설정 확인을 요청해주세요.'
    );
  }

  return {
    account: {
      ...account,
      project_id: account.project_id || projectId,
      private_key: String(account.private_key).replace(/\\n/g, '\n')
    },
    projectId
  };
}

export function getFirebaseAdminApp() {
  if (adminApp) return adminApp;

  const { account, projectId } = readServiceAccount();
  adminApp = getApps().find((app) => app.name === ADMIN_APP_NAME) || initializeApp({
    credential: cert(account),
    projectId,
    ...(process.env.FIREBASE_STORAGE_BUCKET
      ? { storageBucket: String(process.env.FIREBASE_STORAGE_BUCKET).trim() }
      : {})
  }, ADMIN_APP_NAME);
  return adminApp;
}

export function getFirestoreDatabase() {
  return getFirestore(getFirebaseAdminApp());
}

export function getFirebaseStorageBucket() {
  const bucketName = String(process.env.FIREBASE_STORAGE_BUCKET || '').trim();
  if (!bucketName) {
    throw configError(
      'storage_bucket_not_configured',
      '사진 저장소가 설정되지 않았습니다. 사진은 감성 프리셋 또는 이미지 URL을 사용해주세요.'
    );
  }
  return getStorage(getFirebaseAdminApp()).bucket(bucketName);
}
