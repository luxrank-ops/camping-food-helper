// 비밀의 정원 API·저장소 회귀 테스트 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretGardensApi, sanitizePublicSecretGardens } from '../lib/secret-gardens-api.js';
import { createFileSecretGardenStore, resetSecretGardenStoreForTests } from '../lib/secret-gardens-store.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function createMemoryStore(initial = []) {
  const gardens = initial.map((garden) => ({ ...garden }));
  return {
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

test('Vercel에는 비밀의 정원 CRUD 하위 경로가 모두 API 함수로 등록되어 있다', () => {
  const rootRoute=fs.readFileSync(path.join(ROOT,'api','secret-gardens.js'),'utf8');
  const verifyRoute=fs.readFileSync(path.join(ROOT,'api','secret-gardens','verify.js'),'utf8');
  const idRoute=fs.readFileSync(path.join(ROOT,'api','secret-gardens','[id].js'),'utf8');
  const likeRoute=fs.readFileSync(path.join(ROOT,'api','secret-gardens','[id]','like.js'),'utf8');
  const vercel=JSON.parse(fs.readFileSync(path.join(ROOT,'vercel.json'),'utf8'));
  for(const route of [rootRoute,verifyRoute,idRoute,likeRoute])assert.match(route,/createSecretGardensApi\(\)/);
  assert.match(rootRoute,/secretGardensApi\(req, res, \[\]\)/);
  assert.match(verifyRoute,/secretGardensApi\(req, res, \['verify'\]\)/);
  assert.match(idRoute,/req\.query\?\.id/);
  assert.match(likeRoute,/req\.query\?\.id, 'like'/);
  assert.equal(vercel.buildCommand,'npm run build');
  assert.equal(vercel.outputDirectory,'dist');
});

test('비공개 스팟은 공개 목록에서 비밀번호와 상세 위치를 감춘다', () => {
  const safe = sanitizePublicSecretGardens([
    { id: 'public', name: '공개', isPrivate: false, password: 'secret', address: '부산 해운대구 상세 주소' },
    { id: 'private', name: '비공개', isPrivate: true, password: 'secret', address: '부산 기장군 상세 주소', addressDetail: '진입로', lat: 35.1, lng: 129.1 }
  ]);

  assert.equal(safe[0].password, undefined);
  assert.equal(safe[0].address, '부산 해운대구 상세 주소');
  assert.equal(safe[1].password, undefined);
  assert.equal(safe[1].address, undefined);
  assert.equal(safe[1].addressDetail, undefined);
  assert.equal(safe[1].lat, undefined);
  assert.equal(safe[1].addressMasked, '부산 기장군 *** (비밀 노지)');
});

test('등록·비밀번호 확인·수정·좋아요·삭제가 동일한 API로 동작한다', async () => {
  const store = createMemoryStore();
  const api = createSecretGardensApi({
    store,
    masterKey: 'master-key',
    clock: () => new Date('2026-10-17T00:00:00.000Z')
  });
  const created = await callApi(api, {
    method: 'POST',
    body: {
      name: '비밀의 정원', author: '부산캠퍼', password: '1234', address: '부산 기장군',
      lat: '35.1234', lng: '129.1234', facilities: ['화장실', '', '불멍'], isPrivate: true
    }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.payload.success, true);
  const id = created.payload.garden.id;
  assert.equal(created.payload.garden.name, '비밀의 정원');
  assert.equal(created.payload.garden.lat, 35.1234);
  assert.deepEqual(created.payload.garden.facilities, ['화장실', '불멍']);

  const publicList = await callApi(api);
  assert.equal(publicList.payload.gardens[0].address, undefined);
  assert.equal(publicList.payload.gardens[0].password, undefined);

  const verified = await callApi(api, { method: 'POST', segments: ['verify'], body: { id, password: '1234' } });
  assert.equal(verified.payload.success, true);
  assert.equal(verified.payload.isAuthor, true);

  const updated = await callApi(api, {
    method: 'PUT', segments: [id],
    body: { password: '1234', name: '수정된 정원', tips: '물가에서 20m 떨어져 있어요.' }
  });
  assert.equal(updated.payload.garden.name, '수정된 정원');
  assert.equal(updated.payload.garden.tips, '물가에서 20m 떨어져 있어요.');

  const liked = await callApi(api, { method: 'POST', segments: [id, 'like'] });
  assert.equal(liked.payload.likes, 1);

  const removed = await callApi(api, { method: 'DELETE', segments: [id], body: { password: '1234' } });
  assert.equal(removed.payload.success, true);
  const missing = await callApi(api, { method: 'POST', segments: [id, 'like'] });
  assert.equal(missing.statusCode, 404);
});

test('필수 입력값과 잘못된 비밀번호를 안전하게 거부한다', async () => {
  const api = createSecretGardensApi({
    store: createMemoryStore([{ id: 'spot-1', name: '스팟', password: 'author-pass', isPrivate: true }]),
    masterKey: 'master-key'
  });
  const invalidCreate = await callApi(api, { method: 'POST', body: { name: '이름만' } });
  assert.equal(invalidCreate.statusCode, 400);
  assert.equal(invalidCreate.payload.code, 'missing_required_fields');

  const unuploadedPhoto = await callApi(api, {
    method: 'POST',
    body: { name: '사진 테스트', author: '캠퍼', password: '1234', photoUrl: 'data:image/jpeg;base64,AA==' }
  });
  assert.equal(unuploadedPhoto.statusCode, 400);
  assert.equal(unuploadedPhoto.payload.code, 'photo_not_uploaded');

  const denied = await callApi(api, {
    method: 'PUT', segments: ['spot-1'], body: { password: 'wrong', name: '바뀌면 안 됨' }
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.payload.code, 'edit_forbidden');
});

test('서버 저장소가 설정되지 않은 경우 실패 이유를 JSON으로 명확히 반환한다', async () => {
  const unavailable = async () => {
    const error = new Error('private credential details');
    error.statusCode = 503;
    error.code = 'storage_not_configured';
    error.publicMessage = '서버 저장소가 아직 설정되지 않았습니다.';
    throw error;
  };
  const api = createSecretGardensApi({
    store: { list: unavailable, get: unavailable, insert: unavailable, update: unavailable, remove: unavailable }
  });
  const response = await callApi(api);
  assert.equal(response.statusCode, 503);
  assert.equal(response.payload.code, 'storage_not_configured');
  assert.equal(response.payload.error, '서버 저장소가 아직 설정되지 않았습니다.');
  assert.ok(!JSON.stringify(response.payload).includes('private credential details'));
});

test('Vercel에서 Firestore 환경 변수가 없으면 임시 파일 대신 명확한 503을 반환한다', async () => {
  const previous = {
    vercel: process.env.VERCEL,
    vercelEnv: process.env.VERCEL_ENV,
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT
  };
  try {
    process.env.VERCEL = '1';
    delete process.env.VERCEL_ENV;
    delete process.env.FIREBASE_SERVICE_ACCOUNT;
    resetSecretGardenStoreForTests();
    const response = await callApi(createSecretGardensApi());
    assert.equal(response.statusCode, 503);
    assert.equal(response.payload.code, 'storage_not_configured');
  } finally {
    if (previous.vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous.vercel;
    if (previous.vercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previous.vercelEnv;
    if (previous.serviceAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
    else process.env.FIREBASE_SERVICE_ACCOUNT = previous.serviceAccount;
    resetSecretGardenStoreForTests();
  }
});

test('로컬 JSON 저장소는 등록 내용을 디스크에 안전하게 저장하고 다시 읽는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-garden-store-'));
  const file = path.join(dir, 'secret_gardens.json');
  fs.writeFileSync(file, '[]', 'utf8');
  try {
    const store = createFileSecretGardenStore(file);
    const garden = { id: 'sg_local_test', name: '로컬 정원', password: '1234' };
    await store.insert(garden);
    assert.equal((await store.get(garden.id)).name, '로컬 정원');

    const updated = await store.update(garden.id, (current) => ({ ...current, name: '저장된 정원' }));
    assert.equal(updated.name, '저장된 정원');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].name, '저장된 정원');

    const removed = await store.remove(garden.id, (current) => assert.equal(current.password, '1234'));
    assert.equal(removed.id, garden.id);
    assert.deepEqual(await store.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
