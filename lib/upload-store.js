// 업로드 사진 저장소 — Cloudflare Workers 의 R2(또는 KV) 바인딩.
//
// 쓰는 곳
//  - api/upload-image.js : 바인딩이 있으면 여기로 저장한다(없으면 기존 Firebase Storage 경로).
//  - worker/index.js     : GET /api/uploads/<key> 서빙.
//
// 바인딩은 worker/index.js 가 요청마다 env.UPLOADS_BUCKET(R2) / env.UPLOADS_KV(KV) 로 넘겨 준다.
// Express(server.js) 로컬 실행에는 바인딩이 없으므로 이 모듈은 꺼진 상태로 남는다.

export const UPLOAD_KEY_PREFIX = 'secret-gardens/';
export const UPLOAD_PATH_PREFIX = '/api/uploads/';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

let currentStore = null;

function createR2Store(bucket) {
  return {
    kind: 'r2',
    async put(key, bytes, { contentType } = {}) {
      await bucket.put(key, bytes, {
        httpMetadata: {
          contentType: contentType || 'application/octet-stream',
          cacheControl: CACHE_CONTROL
        }
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        size: typeof object.size === 'number' ? object.size : null,
        contentType: object.httpMetadata?.contentType || 'application/octet-stream'
      };
    },
    async delete(key) {
      await bucket.delete(key);
    }
  };
}

function createKvStore(kv) {
  return {
    kind: 'kv',
    async put(key, bytes, { contentType } = {}) {
      await kv.put(key, bytes, { metadata: { contentType: contentType || 'application/octet-stream' } });
    },
    async get(key) {
      const result = await kv.getWithMetadata(key, 'arrayBuffer');
      const value = result?.value;
      if (!value) return null;
      return {
        body: value,
        size: value.byteLength,
        contentType: result?.metadata?.contentType || 'application/octet-stream'
      };
    },
    async delete(key) {
      await kv.delete(key);
    }
  };
}

/**
 * 요청마다 호출된다. 바인딩이 없으면 null 로 되돌려 이전 요청의 저장소가 남지 않게 한다.
 * (워커 전역 상태를 쓰므로 요청 사이에 새지 않도록 매번 같은 규칙으로 덮어쓴다.)
 */
export function setUploadStore(binding) {
  const canRead = binding && (typeof binding.get === 'function' || typeof binding.getWithMetadata === 'function');
  if (!binding || typeof binding.put !== 'function' || !canRead) {
    currentStore = null;
    return null;
  }
  const isR2 = typeof binding.createMultipartUpload === 'function' || typeof binding.head === 'function';
  currentStore = isR2 ? createR2Store(binding) : createKvStore(binding);
  return currentStore;
}

export function getUploadStore() {
  return currentStore;
}

/** 사진의 공개 주소. 설정된 사이트 주소가 없으면 요청 Host 를 쓴다(로컬 실행 대비). */
export function publicBaseUrl(req) {
  const configured = String(process.env.UPLOAD_PUBLIC_BASE_URL || process.env.SITE_URL || '').trim();
  const base = configured || (req?.headers?.host ? `https://${req.headers.host}` : '');
  return base.replace(/\/+$/, '');
}

export function uploadUrlFor(key, req) {
  return `${publicBaseUrl(req)}${UPLOAD_PATH_PREFIX}${key.split('/').map(encodeURIComponent).join('/')}`;
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}

/**
 * GET·HEAD /api/uploads/<key> — 저장된 사진을 그대로 내려 준다.
 * 키는 이 앱이 만든 접두사(secret-gardens/) 아래만 허용한다.
 */
export async function serveUpload(request, url) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse(405, { success: false, code: 'method_not_allowed', error: '지원하지 않는 요청 방식입니다.' }, { allow: 'GET, HEAD' });
  }

  let key = '';
  try {
    key = decodeURIComponent(url.pathname.slice(UPLOAD_PATH_PREFIX.length));
  } catch {
    return jsonResponse(400, { success: false, code: 'invalid_upload_path', error: '사진 경로가 올바르지 않습니다.' });
  }
  if (!key || key.includes('..') || !key.startsWith(UPLOAD_KEY_PREFIX)) {
    return jsonResponse(404, { success: false, code: 'upload_not_found', error: '요청한 사진을 찾을 수 없습니다.' });
  }

  const store = getUploadStore();
  if (!store) {
    return jsonResponse(404, { success: false, code: 'upload_storage_not_configured', error: '사진 저장소가 설정되지 않았습니다.' });
  }

  let object = null;
  try {
    object = await store.get(key);
  } catch (error) {
    console.error('[Upload] read failed:', error?.message || error);
    return jsonResponse(502, { success: false, code: 'upload_read_failed', error: '사진을 불러오지 못했습니다.' });
  }
  if (!object) {
    return jsonResponse(404, { success: false, code: 'upload_not_found', error: '요청한 사진을 찾을 수 없습니다.' });
  }

  const headers = {
    'content-type': object.contentType,
    'cache-control': CACHE_CONTROL,
    'x-content-type-options': 'nosniff'
  };
  if (object.size) headers['content-length'] = String(object.size);

  if (method === 'HEAD') {
    try { await object.body?.cancel?.(); } catch { /* 스트림 정리는 실패해도 응답에 영향 없음 */ }
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
