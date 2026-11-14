// Cloudflare Workers 어댑터 검증 테스트.
//
//  1) 라우팅/어댑터: wrangler 가 만든 번들(.wrangler/dry/index.js)을 그대로 불러
//     Request → 핸들러 → Response 흐름이 Vercel 과 같게 동작하는지 본다.
//  2) Firestore REST shim: 네트워크 없이(가짜 fetch) 문서 읽기/쓰기/병합/정렬/트랜잭션을 검증한다.
//
// 실행: npm run test:worker
//   (먼저 `npm run build && npx wrangler deploy --dry-run --outdir=.wrangler/dry` 로 번들을 만든다)

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const entryPath = process.env.WORKER_ENTRY || path.join(root, '.wrangler', 'dry', 'index.js');

async function loadWorker() {
  const module = await import(pathToFileURL(entryPath).href);
  return module.default;
}

function makeEnv(extra = {}) {
  return {
    SITE_URL: 'https://camping-food-helper.luxrank.workers.dev',
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        return new Response(`asset:${url.pathname}`, {
          status: url.pathname === '/nope' ? 404 : 200,
          headers: { 'content-type': 'text/html' }
        });
      }
    },
    ...extra
  };
}

function requestTo(worker, env, pathname, init = {}) {
  return worker.fetch(new Request(`https://camping-food-helper.luxrank.workers.dev${pathname}`, init), env, {});
}

test('worker: /api 라우팅과 어댑터', async (t) => {
  const worker = await loadWorker();
  const env = makeEnv();

  await t.test('GET /api/health', async () => {
    const response = await requestTo(worker, env, '/api/health');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const body = await response.json();
    assert.equal(body.ok, true);
  });

  await t.test('GET /api/auth/plans (캐치올 라우터)', async () => {
    const response = await requestTo(worker, env, '/api/auth/plans');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.plans) && body.plans.length > 0);
  });

  await t.test('GET /api/auth/me 토큰 없음 → 401 auth_required', async () => {
    const response = await requestTo(worker, env, '/api/auth/me');
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.code, 'auth_required');
  });

  await t.test('GET /api/billing/status', async () => {
    const response = await requestTo(worker, env, '/api/billing/status');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.configured, 'boolean');
  });

  await t.test('POST /api/sample 본문 없음 → 400', async () => {
    const response = await requestTo(worker, env, '/api/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'invalid_json');
  });

  await t.test('POST /api/generate-image 잘못된 방식 → 405', async () => {
    const response = await requestTo(worker, env, '/api/generate-image');
    assert.equal(response.status, 405);
  });

  await t.test('없는 API 경로 → 404', async () => {
    const response = await requestTo(worker, env, '/api/does-not-exist');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, 'route_not_found');
  });

  await t.test('정적 경로는 ASSETS 로 넘긴다', async () => {
    const response = await requestTo(worker, env, '/robots.txt');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'asset:/robots.txt');
  });

  await t.test('OPTIONS /api/* → 204', async () => {
    const response = await requestTo(worker, env, '/api/health', { method: 'OPTIONS' });
    assert.equal(response.status, 204);
  });
});

// ── 업로드 사진 저장소(R2 바인딩) ─────────────────────────────────────────
// 워커는 env.UPLOADS_BUCKET(R2) 또는 env.UPLOADS_KV 바인딩이 있으면 사진을 그쪽에 두고
// GET /api/uploads/<key> 로 내려 준다. 실제 R2 없이 API 모양만 같은 가짜 버킷으로 검증한다.
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64');

function createFakeR2() {
  const objects = new Map();
  return {
    objects,
    async createMultipartUpload() { throw new Error('not used in tests'); },
    async head(key) {
      const stored = objects.get(key);
      return stored ? { key, size: stored.bytes.byteLength } : null;
    },
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
        cacheControl: options?.httpMetadata?.cacheControl || ''
      });
      return { key };
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: new Blob([stored.bytes]).stream(),
        size: stored.bytes.byteLength,
        httpMetadata: { contentType: stored.contentType, cacheControl: stored.cacheControl }
      };
    },
    async delete(key) {
      objects.delete(key);
    }
  };
}

test('worker: 사진 업로드(R2) 와 /api/uploads 서빙', async (t) => {
  const worker = await loadWorker();
  const bucket = createFakeR2();
  const env = makeEnv({ UPLOADS_BUCKET: bucket });
  let uploadedUrl = '';
  let uploadedKey = '';

  await t.test('POST /api/upload-image → 200 + 워커 주소 URL', async () => {
    const response = await requestTo(worker, env, '/api/upload-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: PNG_DATA_URL })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.match(
      body.url,
      /^https:\/\/camping-food-helper\.luxrank\.workers\.dev\/api\/uploads\/secret-gardens\/\d+_[0-9a-f]{16}\.png$/
    );
    uploadedUrl = body.url;
    uploadedKey = new URL(body.url).pathname.slice('/api/uploads/'.length);

    assert.equal(bucket.objects.size, 1, 'R2 에 한 개만 저장된다');
    const stored = bucket.objects.get(uploadedKey);
    assert.ok(stored, 'R2 에 반환된 키로 저장됐다');
    assert.equal(stored.contentType, 'image/png');
    assert.equal(stored.bytes.byteLength, PNG_BYTES.byteLength);
  });

  await t.test('반환된 URL GET → 200 image/png', async () => {
    const response = await requestTo(worker, env, new URL(uploadedUrl).pathname);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, PNG_BYTES);
  });

  await t.test('HEAD /api/uploads/<key> → 200 (본문 없음)', async () => {
    const response = await requestTo(worker, env, new URL(uploadedUrl).pathname, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(await response.text(), '');
  });

  await t.test('없는 키 → 404 upload_not_found', async () => {
    const response = await requestTo(worker, env, '/api/uploads/secret-gardens/0_missing.png');
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.code, 'upload_not_found');
  });

  await t.test('secret-gardens/ 밖의 키 → 404', async () => {
    const response = await requestTo(worker, env, '/api/uploads/other/evil.png');
    assert.equal(response.status, 404);
  });

  await t.test('경로 탈출(..) → 404', async () => {
    const response = await requestTo(worker, env, '/api/uploads/secret-gardens/../secret.png');
    assert.equal(response.status, 404);
  });

  await t.test('POST 로 사진 경로 접근 → 405', async () => {
    const response = await requestTo(worker, env, new URL(uploadedUrl).pathname, { method: 'POST' });
    assert.equal(response.status, 405);
  });

  await t.test('잘못된 이미지 → 400 (저장하지 않는다)', async () => {
    const before = bucket.objects.size;
    const response = await requestTo(worker, env, '/api/upload-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'data:image/png;base64,aGVsbG8=' })
    });
    assert.equal(response.status, 400);
    assert.equal(bucket.objects.size, before);
  });

  await t.test('이미지 URL 은 저장소 없이 그대로 돌려준다', async () => {
    const response = await requestTo(worker, env, '/api/upload-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: 'https://example.com/photo.jpg' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, 'https://example.com/photo.jpg');
  });

  await t.test('바인딩이 없는 요청에서는 /api/uploads 가 404 (이전 바인딩이 남지 않는다)', async () => {
    const noBinding = await requestTo(worker, makeEnv(), new URL(uploadedUrl).pathname);
    assert.equal(noBinding.status, 404);
    const body = await noBinding.json();
    assert.equal(body.code, 'upload_storage_not_configured');
  });
});

// ── Firestore REST shim ────────────────────────────────────────────────────
function createFakeFirestore(projectId = 'demo-project') {
  const store = new Map();
  const prefix = `/v1/projects/${projectId}/databases/(default)/documents`;
  const fullName = (docPath) => `projects/${projectId}/databases/(default)/documents/${docPath}`;
  let transactionCounter = 0;
  const abortsLeft = { count: 0 };

  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  async function fetchImpl(input, init = {}) {
    const raw = String(input);
    if (raw.startsWith('https://oauth2.googleapis.com/token')) {
      return json({ access_token: 'fake-token', expires_in: 3600 });
    }
    const url = new URL(raw);
    const decodedPath = decodeURIComponent(url.pathname);
    const baseIndex = decodedPath.indexOf(prefix);
    assert.ok(baseIndex >= 0, `unexpected firestore path: ${raw}`);
    let relative = decodedPath.slice(baseIndex + prefix.length);

    if (relative === ':beginTransaction') {
      transactionCounter += 1;
      return json({ transaction: `tx-${transactionCounter}` });
    }
    if (relative === ':rollback') return json({});
    if (relative === ':commit') {
      if (abortsLeft.count > 0) {
        abortsLeft.count -= 1;
        return json({ error: { code: 409, message: 'Aborted due to contention', status: 'ABORTED' } }, 409);
      }
      const body = JSON.parse(init.body || '{}');
      for (const write of body.writes || []) {
        if (write.delete) {
          store.delete(write.delete.split('/documents/')[1]);
          continue;
        }
        const target = write.update;
        const docPath = target.name.split('/documents/')[1];
        const current = store.get(docPath);
        if (write.currentDocument?.exists === false && current) {
          return json({ error: { code: 409, message: 'Document already exists', status: 'ALREADY_EXISTS' } }, 409);
        }
        const fields = write.updateMask
          ? { ...(current || {}), ...target.fields }
          : { ...target.fields };
        store.set(docPath, fields);
      }
      return json({ commitTime: new Date().toISOString() });
    }

    if (relative === '' || relative === '/' || !relative.replace(/^\//, '').includes('/')) {
      // 컬렉션 나열
      const collectionPath = relative.replace(/^\//, '');
      const limit = Number(url.searchParams.get('pageSize') || 300);
      const orderBy = url.searchParams.get('orderBy') || '';
      let docs = [...store.entries()]
        .filter(([docPath]) => docPath.startsWith(`${collectionPath}/`) && !docPath.slice(collectionPath.length + 1).includes('/'))
        .map(([docPath, fields]) => ({ name: fullName(docPath), fields }));
      if (orderBy) {
        const [field, direction] = orderBy.split(' ');
        docs = docs.sort((a, b) => {
          const left = a.fields?.[field]?.stringValue ?? '';
          const right = b.fields?.[field]?.stringValue ?? '';
          const compared = left < right ? -1 : left > right ? 1 : 0;
          return direction === 'desc' ? -compared : compared;
        });
      }
      return json({ documents: docs.slice(0, limit) });
    }

    const docPath = relative.replace(/^\//, '');
    const fields = store.get(docPath);
    if (!fields) {
      return json({ error: { code: 404, message: 'Document not found', status: 'NOT_FOUND' } }, 404);
    }
    return json({ name: fullName(docPath), fields });
  }

  return { store, fetchImpl, abortsLeft, projectId };
}

test('firestore REST shim: 문서 CRUD·병합·정렬·트랜잭션', async (t) => {
  const fake = createFakeFirestore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => fake.fetchImpl(input, init);
  const { createRestFirestore } = await import(pathToFileURL(path.join(root, 'worker', 'firestore-rest.js')).href);
  const { resetGoogleAuthCache } = await import(pathToFileURL(path.join(root, 'worker', 'google-auth.js')).href);
  resetGoogleAuthCache();

  // 서명용 RSA 키를 즉석에서 만든다(토큰 교환은 가짜 fetch 가 처리).
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const db = createRestFirestore({
    projectId: fake.projectId,
    clientEmail: 'svc@demo.iam.gserviceaccount.com',
    privateKey: pem
  });

  t.after(() => { globalThis.fetch = originalFetch; });

  await t.test('set → get 왕복 (문자열·정수·실수·불리언·null·배열·중첩)', async () => {
    const doc = {
      id: 'g1',
      name: '숲속 스팟',
      rating: 4.5,
      likes: 3,
      open: true,
      note: null,
      tags: ['숲', '계곡'],
      usage: { ai: 2, image: 1, date: '2026-11-14' },
      createdAt: '2026-11-14T03:00:00.000Z'
    };
    await db.collection('gardens').doc('g1').set(doc);
    const snapshot = await db.collection('gardens').doc('g1').get();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.id, 'g1');
    assert.deepEqual(snapshot.data(), doc);
  });

  await t.test('없는 문서 get → exists false', async () => {
    const snapshot = await db.collection('gardens').doc('missing').get();
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.data(), undefined);
  });

  await t.test('set merge → 기존 필드 유지', async () => {
    await db.collection('gardens').doc('g1').set({ nickname: '춘학' }, { merge: true });
    const snapshot = await db.collection('gardens').doc('g1').get();
    const data = snapshot.data();
    assert.equal(data.nickname, '춘학');
    assert.equal(data.name, '숲속 스팟');
  });

  await t.test('create → 이미 있으면 실패', async () => {
    await db.collection('users').doc('u1').create({ uid: 'u1', email: 'a@b.c' });
    await assert.rejects(() => db.collection('users').doc('u1').create({ uid: 'u1' }), /already exists/i);
  });

  await t.test('컬렉션 나열 + orderBy desc + limit', async () => {
    await db.collection('guestbookPosts').doc('p1').set({ createdAt: '2026-11-13T00:00:00.000Z', nickname: 'a' });
    await db.collection('guestbookPosts').doc('p2').set({ createdAt: '2026-11-14T00:00:00.000Z', nickname: 'b' });
    const list = await db.collection('guestbookPosts').orderBy('createdAt', 'desc').limit(1).get();
    assert.equal(list.size, 1);
    assert.equal(list.docs[0].id, 'p2');
    assert.equal(list.docs[0].data().nickname, 'b');
  });

  await t.test('runTransaction: 읽고 쓰기 + 반환값', async () => {
    const result = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(db.collection('_visitorStats').doc('global'));
      const total = (snapshot.exists ? snapshot.data().total : 0) + 1;
      tx.set(db.collection('_visitorStats').doc('global'), { total, days: { '2026-11-14': 1 } });
      return total;
    });
    assert.equal(result, 1);
    const snapshot = await db.collection('_visitorStats').doc('global').get();
    assert.equal(snapshot.data().total, 1);
  });

  await t.test('runTransaction: 콜백 오류(중복 이메일)는 그대로 전달', async () => {
    await assert.rejects(() => db.runTransaction(async (tx) => {
      const snapshot = await tx.get(db.collection('users').doc('u1'));
      if (snapshot.exists) {
        const error = new Error('이미 가입된 이메일입니다.');
        error.code = 'email_taken';
        throw error;
      }
      tx.set(db.collection('users').doc('u1'), {});
    }), /이미 가입된 이메일/);
  });

  await t.test('runTransaction: ABORTED 는 재시도 후 성공', async () => {
    fake.abortsLeft.count = 1;
    const total = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(db.collection('_visitorStats').doc('global'));
      const next = (snapshot.exists ? snapshot.data().total : 0) + 1;
      tx.set(db.collection('_visitorStats').doc('global'), { total: next });
      return next;
    });
    assert.equal(total, 2);
  });

  await t.test('delete → 없어진다', async () => {
    await db.collection('gardens').doc('g1').delete();
    const snapshot = await db.collection('gardens').doc('g1').get();
    assert.equal(snapshot.exists, false);
  });
});
