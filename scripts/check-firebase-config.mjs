// Firebase 배포 전에 설정 형식과 배포 대상 선택을 확인한다.
// 네트워크 인증·IAM 권한·Hosting 활성화 여부는 실제 Firebase 배포에서 확인한다.
// 서비스 계정 원문, 이메일, 비공개 키는 로그나 Actions 출력에 기록하지 않는다.
import { createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const MISSING_ACCOUNT = 'FIREBASE_SERVICE_ACCOUNT가 없습니다. 저장소 Settings → Secrets and variables → Actions에 서비스 계정 JSON 전체를 등록하세요.';

class FirebaseConfigError extends Error {}

export function checkFirebaseConfig({
  serviceAccount = '',
  projectId = '',
  defaultProjectId = '',
  allowMissing = false,
} = {}) {
  if (!serviceAccount.trim()) {
    if (!allowMissing) throw new FirebaseConfigError(MISSING_ACCOUNT);
    return { ready: false, projectId: '', source: '', warnings: [MISSING_ACCOUNT + ' 이번 PR은 검증만 수행하고 배포는 건너뜁니다.'] };
  }

  let account;
  try {
    account = JSON.parse(serviceAccount);
  } catch {
    // JSON.parse 오류에는 입력 일부가 포함될 수 있으므로 원래 오류를 출력하지 않는다.
    throw new FirebaseConfigError('FIREBASE_SERVICE_ACCOUNT가 올바른 JSON이 아닙니다. 키 파일의 경로나 일부 필드가 아닌 JSON 전체를 등록하세요.');
  }
  if (!account || Array.isArray(account) || account.type !== 'service_account') {
    throw new FirebaseConfigError('FIREBASE_SERVICE_ACCOUNT는 type이 service_account인 서비스 계정 키 JSON이어야 합니다.');
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof account[field] !== 'string' || !account[field].trim()) {
      throw new FirebaseConfigError(`FIREBASE_SERVICE_ACCOUNT에 필수 필드 ${field}가 없습니다.`);
    }
  }
  if (!PROJECT_ID.test(account.project_id) || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email)) {
    throw new FirebaseConfigError('서비스 계정의 project_id 또는 client_email 형식이 올바르지 않습니다. 발급받은 키 JSON 전체를 다시 확인하세요.');
  }
  try {
    if (createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') throw new Error();
  } catch {
    throw new FirebaseConfigError('서비스 계정 private_key가 유효한 RSA 비공개 키가 아닙니다. JSON의 줄바꿈과 키 전체가 보존되어 있는지 확인하세요.');
  }

  const explicitProjectId = projectId.trim();
  const selectedProjectId = explicitProjectId || defaultProjectId;
  if (typeof selectedProjectId !== 'string' || !PROJECT_ID.test(selectedProjectId)) {
    throw new FirebaseConfigError('배포 대상 프로젝트 ID가 올바르지 않습니다. FIREBASE_PROJECT_ID 또는 .firebaserc의 projects.default에 표시 이름이 아닌 프로젝트 ID를 설정하세요.');
  }

  const warnings = [];
  if (selectedProjectId !== account.project_id) {
    // 다른 프로젝트의 서비스 계정에 대상 프로젝트 권한을 준 구성도 유효하다.
    warnings.push('배포 대상과 서비스 계정의 소속 프로젝트가 다릅니다. FIREBASE_PROJECT_ID와 .firebaserc를 확인하고, 의도한 교차 프로젝트 배포라면 대상 프로젝트의 Hosting 권한을 확인하세요.');
  }
  return {
    ready: true,
    projectId: selectedProjectId,
    source: explicitProjectId ? 'FIREBASE_PROJECT_ID' : '.firebaserc',
    warnings,
  };
}

function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Firebase 배포 설정\n\n${text}\n\n`);
  }
}

function main() {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || '';
  let defaultProjectId = '';
  if (serviceAccount.trim() && !projectId.trim()) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
      defaultProjectId = config?.projects?.default;
    } catch {
      throw new FirebaseConfigError('.firebaserc를 읽을 수 없습니다. 유효한 projects.default를 지정하거나 FIREBASE_PROJECT_ID를 설정하세요.');
    }
  }
  const result = checkFirebaseConfig({
    serviceAccount,
    projectId,
    defaultProjectId,
    allowMissing: process.env.FIREBASE_ALLOW_MISSING === 'true',
  });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `ready=${result.ready}\nproject_id=${result.projectId}\n`);
  }
  for (const warning of result.warnings) console.warn(`::warning::${warning}`);
  const status = result.ready
    ? `설정 형식 검증 통과. 배포 대상 설정 출처: ${result.source}. 실제 인증·권한·Hosting 상태는 배포 단계에서 확인합니다.`
    : '검증만 수행: 서비스 계정이 없어 Firebase 배포를 건너뛰었습니다. 배포 성공을 의미하지 않습니다.';
  console.log(status);
  appendSummary([status, ...result.warnings.map((warning) => `- ${warning}`)].join('\n\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof FirebaseConfigError
      ? error.message
      : 'Firebase 배포 설정 검사 중 오류가 발생했습니다. 설정 파일과 Actions 출력 파일 접근 권한을 확인하세요.';
    console.error(`::error::${message}`);
    appendSummary(`설정 검사 실패. 배포를 중단합니다.\n\n${message}`);
    process.exitCode = 1;
  }
}
