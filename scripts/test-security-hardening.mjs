// 보안 강화 회귀 테스트 (2026-10-19 점검 대응)
// 대상: 비밀번호 해시 저장, 응답에서 인증 정보 제거, 마스터 키 헤더 전용/환경변수 전용,
//       비공개 스팟 주소 누출(정적 dist), 비밀번호 무차별 대입 제한, 업로드 시그니처 검증,
//       Gemini 공용 로직, Express 정적 파일 허용 목록.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSecretGardensApi } from '../lib/secret-gardens-api.js';
import {
  hashPassword,
  isMasterKey,
  upgradeLegacyPassword,
  verifyGardenPassword
} from '../lib/garden-password.js';
import { parseImageDataUrl } from '../lib/image-upload.js';
import { publicStorageErrorCode } from '../lib/firebase-admin.js';
import { generateSampleJson, parseJsonResponse } from '../lib/sample.js';
import { CHECKS, probe } from './uptime-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMemoryStore(initial = []) {
  const gardens = initial.map((garden) => ({ ...garden }));
  return {
    _gardens: gardens,
    async list() { return gardens.map((garden) => ({ ...garden })); },
    async get(id) { return gardens.find((garden) => garden.id === id) || null; },
    async insert(garden) { gardens.unshift(garden); return garden; },
    async update(id, updater) {
      const index = gardens.findIndex((garden) => garden.id === id);
      if (index < 0) return null;
      gardens[index] = updater(gardens[index]);
      return gardens[index];
    },
    async remove(id, guard) {
      const index = gardens.findIndex((garden) => garden.id === id);
      if (index < 0) return null;
      if (guard) guard(gardens[index]);
      return gardens.splice(index, 1)[0];
    }
  };
}

async function callApi(api, { method = 'GET', segments = [], body = {}, query = {}, headers = {} } = {}) {
  const response = {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
  await api({ method, body, query, headers }, response, segments);
  return response;
}

function assertNoCredentials(payload, label) {
  const text = JSON.stringify(payload);
  assert.ok(!text.includes('passwordHash'), `${label}: 해시가 응답에 없어야 한다`);
  assert.ok(!/"password":/.test(text), `${label}: 비밀번호 필드가 응답에 없어야 한다`);
}

test('비밀번호 유틸: 해시 검증, 옛 평문 검증, 빈 마스터 키 불일치', () => {
  const garden = { passwordHash: hashPassword('camp-1234') };
  assert.equal(verifyGardenPassword('camp-1234', garden), true);
  assert.equal(verifyGardenPassword('wrong-pass', garden), false);
  assert.equal(verifyGardenPassword('', garden), false);

  assert.equal(verifyGardenPassword('123', { password: '123' }), true, '마이그레이션 전 평문은 검증만 허용');
  const upgraded = upgradeLegacyPassword({ id: 'x', password: '123' });
  assert.equal(upgraded.password, undefined);
  assert.equal(verifyGardenPassword('123', upgraded), true);

  assert.equal(isMasterKey('', ''), false, '마스터 키 미설정 시 빈 입력이 일치하면 안 된다');
  assert.equal(isMasterKey('anything', ''), false);
  assert.equal(isMasterKey('key-1', 'key-1'), true);
  assert.equal(isMasterKey('key-1', 'key-2'), false);
});

test('등록: 해시로만 저장되고 어떤 응답에도 인증 정보가 없다', async () => {
  const store = createMemoryStore();
  const api = createSecretGardensApi({ store, masterKey: 'master-key' });

  const created = await callApi(api, {
    method: 'POST',
    body: { name: '스팟', author: '캠퍼', password: 'pass-1234', address: '부산 기장군 상세 주소', isPrivate: true }
  });
  assert.equal(created.statusCode, 201);
  assertNoCredentials(created.payload, '등록 응답');

  const saved = store._gardens[0];
  assert.equal(saved.password, undefined, '평문이 저장되면 안 된다');
  assert.ok(String(saved.passwordHash).startsWith('scrypt1:'));

  const id = saved.id;
  const verified = await callApi(api, { method: 'POST', segments: ['verify'], body: { id, password: 'pass-1234' } });
  assert.equal(verified.payload.success, true);
  assertNoCredentials(verified.payload, '확인 응답');

  // 쿼리스트링 master_key는 더 이상 인정하지 않는다 (URL 로그 누출)
  const viaQuery = await callApi(api, { query: { master_key: 'master-key' } });
  assert.equal(viaQuery.payload.authorized, false);
  assert.equal(viaQuery.payload.gardens[0].address, undefined, '공개 목록에서는 비공개 주소가 없어야 한다');

  // 헤더 마스터 키는 상세 정보를 주되 인증 정보는 빼고 준다
  const viaHeader = await callApi(api, { headers: { 'x-master-key': 'master-key' } });
  assert.equal(viaHeader.payload.authorized, true);
  assert.equal(viaHeader.payload.gardens[0].address, '부산 기장군 상세 주소');
  assertNoCredentials(viaHeader.payload, '마스터 목록');
});

test('등록 검증: 짧은 비밀번호·위험한 사진 URL·범위 밖 좌표를 거부한다', async () => {
  const api = createSecretGardensApi({ store: createMemoryStore(), masterKey: '' });
  const base = { name: '스팟', author: '캠퍼', password: 'pass-1234' };

  const short = await callApi(api, { method: 'POST', body: { ...base, password: '123' } });
  assert.equal(short.statusCode, 400);
  assert.equal(short.payload.code, 'password_too_short');

  const badPhoto = await callApi(api, { method: 'POST', body: { ...base, photoUrl: 'javascript:alert(1)' } });
  assert.equal(badPhoto.statusCode, 400);
  assert.equal(badPhoto.payload.code, 'invalid_photo_url');

  const badCoord = await callApi(api, { method: 'POST', body: { ...base, lat: 999 } });
  assert.equal(badCoord.statusCode, 400);
  assert.equal(badCoord.payload.code, 'invalid_coordinates');
});

test('비밀번호 확인: 반복 실패 시 잠시 잠긴다', async () => {
  const store = createMemoryStore([{ id: 'spot-1', name: '스팟', password: 'author-pass', isPrivate: true }]);
  const api = createSecretGardensApi({ store, masterKey: '' });

  for (let i = 0; i < 10; i += 1) {
    const denied = await callApi(api, { method: 'POST', segments: ['verify'], body: { id: 'spot-1', password: 'wrong' } });
    assert.equal(denied.statusCode, 401);
  }
  const locked = await callApi(api, { method: 'POST', segments: ['verify'], body: { id: 'spot-1', password: 'author-pass' } });
  assert.equal(locked.statusCode, 429);
  assert.equal(locked.payload.code, 'too_many_attempts');
});

test('옛 평문 비밀번호: 작성자 확인에 성공하면 해시로 교체된다', async () => {
  const store = createMemoryStore([{ id: 'old-1', name: '옛 스팟', password: '7777', isPrivate: true }]);
  const api = createSecretGardensApi({ store, masterKey: '' });

  const verified = await callApi(api, { method: 'POST', segments: ['verify'], body: { id: 'old-1', password: '7777' } });
  assert.equal(verified.payload.success, true);
  assert.equal(store._gardens[0].password, undefined);
  assert.ok(String(store._gardens[0].passwordHash).startsWith('scrypt1:'));

  const again = await callApi(api, { method: 'POST', segments: ['verify'], body: { id: 'old-1', password: '7777' } });
  assert.equal(again.payload.success, true, '교체 뒤에도 같은 비밀번호로 열려야 한다');
});

test('소스 점검: 코드에 하드코딩된 기본 마스터 키가 없다', () => {
  const api = fs.readFileSync(path.join(ROOT, 'lib', 'secret-gardens-api.js'), 'utf8');
  assert.ok(!api.includes('DEFAULT_MASTER_KEY'), '기본 마스터 키 상수가 없어야 한다');
  assert.match(api, /process\.env\.MASTER_KEY/, '마스터 키는 환경변수에서만 읽어야 한다');
  assert.ok(!api.includes('master_key'), '쿼리스트링 master_key를 받으면 안 된다');
});

test('정적 빌드(dist): 비공개 스팟의 전체 주소가 새어 나가지 않는다', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-hosting.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const dist = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'data', 'secret_gardens.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'secret_gardens.json'), 'utf8'));
  assert.equal(dist.length, source.length);

  for (const spot of dist) {
    assert.equal(spot.password, undefined);
    assert.equal(spot.passwordHash, undefined);
    if (spot.isPrivate) {
      assert.equal(spot.address, undefined, `${spot.id}: 비공개 스팟 주소가 dist에 있으면 안 된다`);
      assert.equal(spot.addressDetail, undefined);
      assert.equal(spot.lat, undefined);
      assert.ok(spot.addressMasked, '대신 마스킹 주소가 있어야 한다');
    }
  }
});

test('이미지 검증: 시그니처가 맞지 않거나 SVG면 거부한다', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const ok = parseImageDataUrl(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(ok.mime, 'image/png');
  assert.equal(ok.ext, 'png');

  const fakePng = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  assert.throws(() => parseImageDataUrl(fakePng), /형식/);

  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`;
  assert.throws(() => parseImageDataUrl(svg), /JPEG, PNG 또는 WebP/);

  assert.deepEqual(parseImageDataUrl('https://example.com/a.jpg'), { externalUrl: 'https://example.com/a.jpg' });
});

test('Gemini 공용 로직: 펜스 JSON 파싱, 폴백, 프롬프트 길이 제한', async () => {
  assert.deepEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });

  const models = [];
  const parsed = await generateSampleJson('prompt', {
    models: ['broken', 'works'],
    createClient: () => ({
      models: {
        generateContent: async ({ model }) => {
          models.push(model);
          if (model === 'broken') throw new Error('boom');
          return { text: '{"ok":true}' };
        }
      }
    })
  });
  assert.deepEqual(parsed, { ok: true });
  assert.deepEqual(models, ['broken', 'works']);

  await assert.rejects(
    () => generateSampleJson('x'.repeat(20001), { createClient: () => ({}) }),
    (err) => err.code === 'prompt_too_long'
  );
});

test('Express: 정적 파일 허용 목록 가드와 /api JSON 404가 있다', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /PUBLIC_FILES/);
  assert.match(server, /dotfiles: 'deny'/);
  assert.match(server, /app\.all\('\/api\/\*'/);
  assert.match(server, /X-Content-Type-Options/);
});

test('헬스체크: 공개 목록에 비밀번호 필드가 있으면 장애로 판정한다', async () => {
  const gardens = CHECKS.find((c) => c.url.endsWith('/api/secret-gardens'));
  const leaked = JSON.stringify({ authorized: false, gardens: [{ id: '1', password: 'x' }] });
  assert.equal((await probe(gardens, async () => new Response(leaked, { status: 200 }))).ok, false);
  const clean = JSON.stringify({ authorized: false, gardens: [{ id: '1' }] });
  assert.equal((await probe(gardens, async () => new Response(clean, { status: 200 }))).ok, true);
});

test('저장소 오류 진단: Firestore 설정 문제는 공개 코드로 분류되고 원본은 노출되지 않는다', async () => {
  assert.equal(publicStorageErrorCode(new Error('5 NOT_FOUND: The database (default) does not exist')), 'firestore_database_missing');
  assert.equal(publicStorageErrorCode({ code: 'permission-denied', message: 'Missing or insufficient permissions' }), 'firestore_permission_denied');
  assert.equal(publicStorageErrorCode(new Error('error:1408: invalid_grant getting access token')), 'firebase_credentials_invalid');
  assert.equal(publicStorageErrorCode(new Error('socket hang up')), null);

  const unavailable = async () => {
    const error = new Error('7 PERMISSION_DENIED: service account ... PRIVATE_DETAIL');
    error.code = 'permission-denied';
    throw error;
  };
  const api = createSecretGardensApi({
    store: { list: unavailable, get: unavailable, insert: unavailable, update: unavailable, remove: unavailable }
  });
  const response = await callApi(api);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.code, 'firestore_permission_denied');
  assert.ok(!JSON.stringify(response.payload).includes('PRIVATE_DETAIL'));
});
