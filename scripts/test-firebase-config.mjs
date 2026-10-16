// 실제 자격 증명이나 네트워크 없이 Firebase 배포 설정과 워크플로 연결을 검사한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFirebaseConfig } from './check-firebase-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 테스트 때만 생성하고 버리며, 실제 Google 계정에는 연결되지 않은 키다.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account',
  project_id: 'test-camping-project',
  client_email: 'test-deploy@test-camping-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const serviceAccount = JSON.stringify(account);
const options = { serviceAccount };

function runCheck(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firebase-config-test-'));
  const output = path.join(dir, 'output');
  const summary = path.join(dir, 'summary');
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-firebase-config.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
    });
    assert.ifError(run.error);
    return {
      ...run,
      output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
      summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertNoCredentials(text) {
  assert.ok(!text.includes(account.client_email), '서비스 계정 이메일을 출력하지 않아야 한다');
  assert.ok(!text.includes('BEGIN PRIVATE KEY'), '비공개 키를 출력하지 않아야 한다');
  assert.ok(!text.includes(account.private_key.split('\n')[1]), '키 본문을 출력하지 않아야 한다');
}

test('Firebase: FIREBASE_PROJECT_ID가 서비스 계정의 기본 프로젝트보다 우선한다', () => {
  const result = checkFirebaseConfig({ ...options, projectId: 'another-camping-app' });
  assert.equal(result.ready, true);
  assert.equal(result.projectId, 'another-camping-app');
  assert.equal(result.source, 'FIREBASE_PROJECT_ID');
});

test('Firebase: 명시한 프로젝트가 없으면 서비스 계정의 프로젝트를 사용한다', () => {
  const result = checkFirebaseConfig(options);
  assert.equal(result.projectId, 'test-camping-project');
  assert.equal(result.source, '서비스 계정 project_id');
  assert.deepEqual(result.warnings, []);
});

test('Firebase: 프로젝트 시크릿 앞뒤 공백은 제거한다', () => {
  assert.equal(checkFirebaseConfig({ ...options, projectId: '  test-camping-project\n' }).projectId, 'test-camping-project');
  assert.equal(checkFirebaseConfig({ ...options, projectId: ' \n' }).source, '서비스 계정 project_id');
});

test('Firebase: 자격 증명이 없는 PR은 배포를 명시적으로 건너뛴다', () => {
  const result = checkFirebaseConfig({ allowMissing: true });
  assert.equal(result.ready, false);
  assert.equal(result.projectId, '');
  assert.match(result.warnings[0], /배포는 건너뜁니다/);
});

test('Firebase: 프로덕션 배포에 필요한 자격 증명이 없으면 실패한다', () => {
  assert.throws(() => checkFirebaseConfig(), /FIREBASE_SERVICE_ACCOUNT가 없습니다/);
});

test('Firebase: 잘못된 JSON 오류에 자격 증명 원문을 포함하지 않는다', () => {
  const invalid = '{"private_key":"DO_NOT_PRINT_THIS';
  assert.throws(() => checkFirebaseConfig({ ...options, serviceAccount: invalid }), (error) => {
    assert.match(error.message, /올바른 JSON이 아닙니다/);
    assert.ok(!error.message.includes('DO_NOT_PRINT_THIS'));
    return true;
  });
});

test('Firebase: 서비스 계정이 아닌 JSON과 누락된 필수 필드를 거부한다', () => {
  for (const value of [null, [], 'key-file.json', { type: 'authorized_user' }]) {
    assert.throws(() => checkFirebaseConfig({ ...options, serviceAccount: JSON.stringify(value) }), /service_account/);
  }
  for (const field of ['project_id', 'client_email', 'private_key']) {
    const incomplete = { ...account };
    delete incomplete[field];
    assert.throws(() => checkFirebaseConfig({ ...options, serviceAccount: JSON.stringify(incomplete) }), new RegExp(`필수 필드 ${field}`));
  }
});

test('Firebase: 잘못된 서비스 계정 프로젝트·이메일 형식을 거부한다', () => {
  for (const fields of [{ project_id: '표시 이름' }, { client_email: 'not-an-email' }]) {
    assert.throws(() => checkFirebaseConfig({ ...options, serviceAccount: JSON.stringify({ ...account, ...fields }) }), /project_id 또는 client_email 형식/);
  }
});

test('Firebase: 손상된 PEM과 RSA가 아닌 키를 거부한다', () => {
  const ecKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  for (const key of ['INVALID_PRIVATE_KEY', account.private_key.replaceAll('\n', '\\n'), ecKey.export({ type: 'pkcs8', format: 'pem' })]) {
    assert.throws(() => checkFirebaseConfig({ ...options, serviceAccount: JSON.stringify({ ...account, private_key: key }) }), /유효한 RSA 비공개 키/);
  }
});

test('Firebase: 프로젝트 ID 오류와 Actions 출력 줄바꿈 주입을 거부한다', () => {
  for (const projectId of ['표시 이름', 'test/app', '123456789', 'test-camping-project\nready=true']) {
    assert.throws(() => checkFirebaseConfig({ ...options, projectId }), /프로젝트 ID가 올바르지 않습니다/);
  }
});

test('Firebase: 교차 프로젝트 서비스 계정은 허용하되 대상 권한을 경고한다', () => {
  const result = checkFirebaseConfig({ ...options, projectId: 'another-camping-app' });
  assert.equal(result.ready, true);
  assert.equal(result.projectId, 'another-camping-app');
  assert.match(result.warnings[0], /소속 프로젝트가 다릅니다/);
  assertNoCredentials(JSON.stringify(result));
});

test('Firebase CLI: 검증한 프로젝트만 배포 액션에 전달하고 자격 증명을 출력하지 않는다', () => {
  const run = runCheck({ FIREBASE_SERVICE_ACCOUNT: serviceAccount, FIREBASE_PROJECT_ID: 'another-camping-app' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output, 'ready=true\nproject_id=another-camping-app\n');
  assert.match(run.summary, /FIREBASE_PROJECT_ID/);
  assert.match(run.stderr, /::warning::/);
  assertNoCredentials(run.stdout + run.stderr + run.output + run.summary);
});

test('Firebase CLI: .firebaserc의 예시 값 대신 서비스 계정의 실제 프로젝트를 사용한다', () => {
  const run = runCheck({ FIREBASE_SERVICE_ACCOUNT: serviceAccount });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
  assert.notEqual(account.project_id, config.projects.default, '회귀 검사를 위해 서로 다른 값을 사용한다');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output, `ready=true\nproject_id=${account.project_id}\n`);
  assert.match(run.summary, /서비스 계정 project_id/);
  assert.equal(run.stderr, '', '명시적 프로젝트 설정이 없으면 불일치 경고가 없어야 한다');
});

test('Firebase CLI: 시크릿 없는 PR은 성공과 배포 생략을 구분한다', () => {
  const run = runCheck({ FIREBASE_ALLOW_MISSING: 'true' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output, 'ready=false\nproject_id=\n');
  assert.match(run.summary, /배포 성공을 의미하지 않습니다/);
});

test('Firebase CLI: 누락·손상된 시크릿은 오류 annotation과 실패 종료 코드를 남긴다', () => {
  for (const env of [{}, { FIREBASE_ALLOW_MISSING: 'false' }, { FIREBASE_SERVICE_ACCOUNT: '{"private_key":"DO_NOT_PRINT_THIS', FIREBASE_ALLOW_MISSING: 'true' }]) {
    const run = runCheck(env);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /::error::/);
    assert.match(run.summary, /배포를 중단합니다/);
    assert.ok(!run.output.includes('ready=true'));
    assert.ok(!(run.stdout + run.stderr + run.summary).includes('DO_NOT_PRINT_THIS'));
  }
});

test('Firebase 워크플로: live·PR 양쪽 액션에 검증한 프로젝트 ID를 연결한다', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8');
  assert.match(workflow, /FIREBASE_PROJECT_ID: \$\{\{ secrets\.FIREBASE_PROJECT_ID \}\}/);
  assert.match(workflow, /run: npm run check:firebase/);
  assert.equal((workflow.match(/projectId: \$\{\{ steps\.firebase_config\.outputs\.project_id \}\}/g) || []).length, 2);
  assert.equal((workflow.match(/if: steps\.firebase_config\.outputs\.ready == 'true'/g) || []).length, 2);
});

test('Firebase 워크플로: main 외 live 배포와 fork·Dependabot 프리뷰 배포를 차단한다', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8');
  const live = workflow.slice(workflow.indexOf('id: deploy_live'), workflow.indexOf('id: deploy_preview'));
  assert.match(live, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  const preflight = workflow.slice(workflow.indexOf('id: firebase_config'), workflow.indexOf('run: npm run check:firebase'));
  assert.match(preflight, /github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.match(preflight, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(preflight, /github\.actor != 'dependabot\[bot\]'/);
  assert.match(preflight, /FIREBASE_ALLOW_MISSING: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.ok(!workflow.includes('pull_request_target'), '자격 증명 없는 PR에서 권한을 높이지 않아야 한다');
});
