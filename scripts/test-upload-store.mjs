// 업로드 사진 저장소(lib/upload-store.js) 단위 테스트.
//
// 실제 Cloudflare 없이 바인딩 모양만 같은 가짜 R2/KV 로 본다:
//  - 바인딩 선택(R2 / KV / 없음)과 요청 사이 상태 초기화
//  - 저장·조회 왕복(내용·content-type)
//  - 공개 주소 만들기(SITE_URL / Host 대체)
//  - 서빙 경로 가드(접두사·메서드·없는 키)
//
// 실행: npm test (scripts/test-worker.mjs 는 워커 번들 쪽을 따로 본다)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getUploadStore,
  setUploadStore,
  serveUpload,
  uploadUrlFor,
  publicBaseUrl,
  UPLOAD_KEY_PREFIX
} from '../lib/upload-store.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function createFakeR2() {
  const objects = new Map();
  return {
    objects,
    async head(key) {
      const stored = objects.get(key);
      return stored ? { key, size: stored.bytes.byteLength } : null;
    },
    async put(key, value, options = {}) {
      objects.set(key, {
        bytes: value instanceof Uint8Array ? value : new Uint8Array(value),
        contentType: options?.httpMetadata?.contentType || 'application/octet-stream',
        cacheControl: options?.httpMetadata?.cacheControl || ''
      });
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

function createFakeKv() {
  const entries = new Map();
  return {
    entries,
    async put(key, value, options = {}) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      entries.set(key, { bytes, metadata: options?.metadata || null });
    },
    async getWithMetadata(key) {
      const stored = entries.get(key);
      if (!stored) return { value: null, metadata: null };
      // KV 는 ArrayBuffer 로 돌려준다
      const copy = stored.bytes.buffer.slice(stored.bytes.byteOffset, stored.bytes.byteOffset + stored.bytes.byteLength);
      return { value: copy, metadata: stored.metadata };
    },
    async delete(key) {
      entries.delete(key);
    }
  };
}

function uploadRequest(pathname, method = 'GET') {
  return new Request(`https://camping-food-helper.luxrank.workers.dev${pathname}`, { method });
}

test('upload-store: 바인딩이 없으면 꺼진 상태로 남는다', async () => {
  setUploadStore(null);
  assert.equal(getUploadStore(), null);

  const response = await serveUpload(
    uploadRequest(`${'/api/uploads/'}${UPLOAD_KEY_PREFIX}2026_x.png`),
    new URL(`https://camping-food-helper.luxrank.workers.dev/api/uploads/${UPLOAD_KEY_PREFIX}2026_x.png`)
  );
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, 'upload_storage_not_configured');
});

test('upload-store: R2 바인딩 저장·조회 왕복', async () => {
  const bucket = createFakeR2();
  const store = setUploadStore(bucket);
  assert.equal(store.kind, 'r2');

  const key = `${UPLOAD_KEY_PREFIX}1794647763_0123456789abcdef.png`;
  await store.put(key, PNG_BYTES, { contentType: 'image/png' });

  const stored = bucket.objects.get(key);
  assert.equal(stored.contentType, 'image/png');
  assert.equal(stored.cacheControl, 'public, max-age=31536000, immutable');

  const response = await serveUpload(
    uploadRequest(`/api/uploads/${key}`),
    new URL(`https://camping-food-helper.luxrank.workers.dev/api/uploads/${key}`)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(PNG_BYTES.byteLength));
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
});

test('upload-store: KV 바인딩도 같은 방식으로 저장·조회한다', async () => {
  const kv = createFakeKv();
  const store = setUploadStore(kv);
  assert.equal(store.kind, 'kv');

  const key = `${UPLOAD_KEY_PREFIX}1794647764_fedcba9876543210.png`;
  await store.put(key, PNG_BYTES, { contentType: 'image/png' });
  assert.equal(kv.entries.get(key).metadata.contentType, 'image/png');

  const response = await serveUpload(
    uploadRequest(`/api/uploads/${key}`),
    new URL(`https://camping-food-helper.luxrank.workers.dev/api/uploads/${key}`)
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_BYTES);
});

test('upload-store: 서빙 경로 가드', async (t) => {
  const store = setUploadStore(createFakeR2());
  const key = `${UPLOAD_KEY_PREFIX}1794647765_0000111122223333.png`;
  await store.put(key, PNG_BYTES, { contentType: 'image/png' });

  await t.test('HEAD → 200, 본문 없음', async () => {
    const response = await serveUpload(
      uploadRequest(`/api/uploads/${key}`, 'HEAD'),
      new URL(`https://camping-food-helper.luxrank.workers.dev/api/uploads/${key}`)
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });

  await t.test('GET·HEAD 외 메서드 → 405', async () => {
    const response = await serveUpload(
      uploadRequest(`/api/uploads/${key}`, 'POST'),
      new URL(`https://camping-food-helper.luxrank.workers.dev/api/uploads/${key}`)
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });

  await t.test('secret-gardens/ 밖의 키 → 404', async () => {
    const path = '/api/uploads/other/photo.png';
    const response = await serveUpload(uploadRequest(path), new URL(`https://camping-food-helper.luxrank.workers.dev${path}`));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'upload_not_found');
  });

  await t.test('없는 키 → 404', async () => {
    const path = `/api/uploads/${UPLOAD_KEY_PREFIX}0_none.png`;
    const response = await serveUpload(uploadRequest(path), new URL(`https://camping-food-helper.luxrank.workers.dev${path}`));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'upload_not_found');
  });

  await t.test('저장소 오류는 502 로 알린다', async () => {
    setUploadStore({
      async put() {},
      async get() { throw new Error('r2 down'); },
      async head() { return null; },
      createMultipartUpload() {}
    });
    const path = `/api/uploads/${UPLOAD_KEY_PREFIX}1_broken.png`;
    const response = await serveUpload(uploadRequest(path), new URL(`https://camping-food-helper.luxrank.workers.dev${path}`));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'upload_read_failed');
  });
});

test('upload-store: 공개 주소는 SITE_URL, 없으면 요청 Host', () => {
  const previous = process.env.SITE_URL;
  try {
    process.env.SITE_URL = 'https://camping-food-helper.luxrank.workers.dev/';
    assert.equal(publicBaseUrl({ headers: { host: 'ignored.example' } }), 'https://camping-food-helper.luxrank.workers.dev');
    assert.equal(
      uploadUrlFor('secret-gardens/1_ab.png', { headers: {} }),
      'https://camping-food-helper.luxrank.workers.dev/api/uploads/secret-gardens/1_ab.png'
    );

    delete process.env.SITE_URL;
    assert.equal(publicBaseUrl({ headers: { host: 'localhost:3000' } }), 'https://localhost:3000');
  } finally {
    if (previous === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previous;
    setUploadStore(null);
  }
});
