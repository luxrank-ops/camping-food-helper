// 비밀의 정원 API·저장소 회귀 테스트 (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecretGardensApi, sanitizePublicSecretGardens } from '../lib/secret-gardens-api.js';
import {
  createFileSecretGardenStore,
  createFirestoreSecretGardenStore,
  resetSecretGardenStoreForTests
} from '../lib/secret-gardens-store.js';
import { hashPassword, verifyGardenPassword } from '../lib/garden-password.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

/**
 * Firestore 시드 경로 전용 인메모리 대역.
 * 실제 Firestore 트랜잭션과 같은 규칙(create는 문서가 있으면 실패, get은 스냅샷 반환)만 흉내 낸다.
 * 이 대역이 없으면 시드 로직이 ReferenceError로 죽어도 잡아내지 못한다.
 */
function createFakeFirestore() {
  const collections = new Map();
  const operations = [];
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const bucket = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const snapshot = (data) => ({ exists: data !== undefined, data: () => clone(data) });

  function docRef(collectionName, id) {
    return {
      collectionName,
      id,
      async get() { return snapshot(bucket(collectionName).get(id)); }
    };
  }

  return {
    _operations: operations,
    _doc(collectionName, id) { return bucket(collectionName).get(id); },
    _docs(collectionName) { return [...bucket(collectionName).keys()]; },
    collection(name) {
      return {
        name,
        doc(id) { return docRef(name, id); },
        async get() {
          const docs = [...bucket(name).entries()].map(([id, data]) => ({ id, ...snapshot(data) }));
          return { docs, size: docs.length, empty: docs.length === 0 };
        }
      };
    },
    async runTransaction(handler) {
      const transaction = {
        async get(ref) {
          operations.push(['get', ref.collectionName, ref.id]);
          return snapshot(bucket(ref.collectionName).get(ref.id));
        },
        create(ref, data) {
          if (bucket(ref.collectionName).has(ref.id)) {
            throw new Error(`ALREADY_EXISTS: ${ref.collectionName}/${ref.id}`);
          }
          operations.push(['create', ref.collectionName, ref.id]);
          bucket(ref.collectionName).set(ref.id, clone(data));
        },
        set(ref, data) {
          operations.push(['set', ref.collectionName, ref.id]);
          bucket(ref.collectionName).set(ref.id, clone(data));
        },
        delete(ref) {
          operations.push(['delete', ref.collectionName, ref.id]);
          bucket(ref.collectionName).delete(ref.id);
        }
      };
      return handler(transaction);
    }
  };
}

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

test('Firestore 시드: 옛 평문 비밀번호를 해시로 바꿔 저장하고 완료 마커를 남긴다', async () => {
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'secret_gardens.json'), 'utf8'));
  const db = createFakeFirestore();
  const store = createFirestoreSecretGardenStore(db);

  const gardens = await store.list();
  assert.equal(gardens.length, seeds.length);
  assert.deepEqual(db._docs('secretGardens').sort(), seeds.map((seed) => seed.id).sort());

  const marker = db._doc('_secretGardenMeta', 'seed-v1');
  assert.ok(marker, '시드 완료 마커가 있어야 한다');
  assert.equal(marker.version, 1);

  for (const seed of seeds) {
    const saved = db._doc('secretGardens', seed.id);
    // 회귀: upgradeLegacyPassword import가 빠지면 여기까지 오지 못하고 ReferenceError로 실패한다.
    assert.equal(saved.password, undefined, `${seed.id}: 평문 비밀번호가 Firestore에 들어가면 안 된다`);
    assert.match(String(saved.passwordHash), /^scrypt1:/, `${seed.id}: 해시로 저장되어야 한다`);
    assert.equal(verifyGardenPassword(seed.password, saved), true, `${seed.id}: 시드 비밀번호로 계속 열려야 한다`);
    // 비밀번호 외 시드 데이터는 손실 없이 보존된다.
    assert.equal(saved.name, seed.name);
    assert.equal(saved.author, seed.author);
    assert.equal(saved.createdAt, seed.createdAt);
  }

  const createdAt = gardens.map((garden) => new Date(garden.createdAt).getTime());
  assert.deepEqual(createdAt, [...createdAt].sort((a, b) => b - a), '목록은 최신순이어야 한다');
});

test('Firestore 시드: 반복 호출·콜드 스타트에도 중복 생성하지 않고 기존 문서를 덮어쓰지 않는다', async () => {
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'secret_gardens.json'), 'utf8'));
  const db = createFakeFirestore();
  const edited = seeds[1];
  const editedDoc = {
    id: edited.id,
    name: '사용자가 수정한 정원',
    author: '기존작성자',
    passwordHash: hashPassword('my-pass-1234'),
    createdAt: edited.createdAt,
    isPrivate: false
  };
  await db.runTransaction(async (transaction) => {
    transaction.set(db.collection('secretGardens').doc(edited.id), editedDoc);
  });

  const store = createFirestoreSecretGardenStore(db);
  await store.list();

  const untouched = db._doc('secretGardens', edited.id);
  assert.equal(untouched.name, '사용자가 수정한 정원', '이미 있는 문서는 시드가 덮어쓰면 안 된다');
  assert.equal(verifyGardenPassword('my-pass-1234', untouched), true);
  assert.equal(db._docs('secretGardens').length, seeds.length, '중복 문서가 생기면 안 된다');

  const createCount = db._operations.filter(([operation]) => operation === 'create').length;
  assert.equal(createCount, seeds.length, '새 스팟 3건 + 완료 마커 1건만 생성되어야 한다');

  await store.list();
  assert.equal(
    db._operations.filter(([operation]) => operation === 'create').length,
    createCount,
    '같은 인스턴스는 시드를 다시 실행하지 않는다'
  );

  // 서버리스 콜드 스타트(새 인스턴스)에서도 마커가 있으면 쓰기 없이 기존 데이터를 그대로 읽는다.
  const before = db._operations.length;
  const coldStore = createFirestoreSecretGardenStore(db);
  const coldList = await coldStore.list();
  assert.equal(coldList.length, seeds.length);
  assert.equal(
    db._operations.slice(before).filter(([operation]) => operation === 'create').length,
    0,
    '마커가 있으면 시드 쓰기가 없어야 한다'
  );
});

test('Firestore 시드 데이터는 공개 목록 API에서 인증 정보 없이 마스킹되어 나온다', async () => {
  const db = createFakeFirestore();
  const api = createSecretGardensApi({ store: createFirestoreSecretGardenStore(db), masterKey: '' });

  const response = await callApi(api);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.authorized, false);
  assert.equal(response.payload.gardens.length, 4);

  for (const garden of response.payload.gardens) {
    assert.equal(garden.password, undefined, `${garden.id}: 평문 비밀번호가 응답에 없어야 한다`);
    assert.equal(garden.passwordHash, undefined, `${garden.id}: 해시가 응답에 없어야 한다`);
  }
  const privateGardens = response.payload.gardens.filter((garden) => garden.isPrivate);
  assert.ok(privateGardens.length > 0, '비공개 시드 스팟이 있어야 마스킹을 검증할 수 있다');
  for (const garden of privateGardens) {
    assert.equal(garden.address, undefined);
    assert.equal(garden.addressDetail, undefined);
    assert.equal(garden.lat, undefined);
    assert.equal(garden.lng, undefined);
    assert.ok(garden.addressMasked, `${garden.id}: 마스킹 주소가 있어야 한다`);
  }
});
