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

/**
 * Firestore/Admin SDK 런타임 오류를 공개해도 되는 설정 문제 코드로 분류한다.
 * (헬스체크 annotation에 이 코드가 그대로 표시되어 운영자가 바로 조치할 수 있다.
 *  원본 오류 메시지는 응답에 넣지 않고 서버 로그에만 남긴다.)
 */
export function publicStorageErrorCode(error) {
  if (!error) return null;
  const known = ['storage_not_configured', 'firebase_credentials_invalid', 'firebase_project_not_configured', 'storage_bucket_not_configured'];
  if (known.includes(error.code)) return error.code;

  const text = `${error.code || ''} ${error.message || ''}`.toLowerCase();
  if (/does not exist[^\n]*database|database \(default\) does not exist|failed-precondition|firestore.*not.*(?:created|enabled)/.test(text)) {
    return 'firestore_database_missing';
  }
  if (/permission-denied|permission_denied|insufficient permission|does not have permission|iam/.test(text)) {
    return 'firestore_permission_denied';
  }
  if (/unauthenticated|invalid_grant|invalid_client|access token|parse private key|bad decrypt|signing.*(?:failed|error)|credential/.test(text)) {
    return 'firebase_credentials_invalid';
  }
  return null;
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
