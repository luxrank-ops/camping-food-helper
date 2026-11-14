// Cloudflare Workers 진입점 — 기존 Vercel 서버리스 함수(api/*.js)를 그대로 재사용한다.
//
// 구조
//  - 정적 파일: Workers Static Assets(dist/) — wrangler.jsonc 의 assets.directory
//  - /api/*     : 이 Worker 가 실행되어 Vercel 핸들러(api/*.js)에 넘긴다.
//
// Vercel 핸들러는 (req, res) 모양의 객체를 받는다. 여기서 Request → req, res 메서드 체인 →
// Response 로 옮겨 주므로, 비즈니스 로직(lib/*)은 한 줄도 고치지 않는다.
// (firebase-admin·@google/genai 는 wrangler.jsonc 의 alias 로 Workers 호환 구현을 쓴다.)

import healthHandler from '../api/health.js';
import authHandler from '../api/auth/[...route].js';
import billingHandler from '../api/billing/[...route].js';
import sampleHandler from '../api/sample.js';
import generateImageHandler from '../api/generate-image.js';
import uploadImageHandler from '../api/upload-image.js';
import guestbookHandler from '../api/guestbook.js';
import guestbookItemHandler from '../api/guestbook/[id].js';
import secretGardensHandler from '../api/secret-gardens.js';
import secretGardensPathHandler from '../api/secret-gardens/[...path].js';
import visitorStatsHandler from '../api/visitor-stats.js';
import { serveUpload, setUploadStore } from '../lib/upload-store.js';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN'
};

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Workers 의 바인딩(변수·시크릿)을 process.env 로 옮긴다.
 * lib/* 코드는 process.env 만 읽으므로, 런타임이 nodejs_compat 로 process.env 를 채우지 못하는
 * 경우에도 동작하도록 요청마다 한 번 채워 둔다(이미 같은 값이면 건드리지 않는다).
 */
function syncProcessEnv(env) {
  try {
    if (typeof process === 'undefined' || !process.env) return;
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value !== 'string') continue;
      try {
        if (process.env[key] !== value) process.env[key] = value;
      } catch { /* 읽기 전용이면 런타임이 이미 채워 둔 값을 그대로 쓴다 */ }
    }
  } catch { /* process 미지원 런타임은 무시 */ }
}

async function readRequestBody(request) {
  if (!BODY_METHODS.has(request.method)) return undefined;
  const text = await request.text();
  if (!text) return undefined;
  const contentType = String(request.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('json') || /^[\s]*[[{]/.test(text)) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function createResponseCollector() {
  const headers = new Headers();
  let statusCode = 200;
  let body = null;
  let finished = false;

  const res = {
    get statusCode() { return statusCode; },
    set statusCode(value) { statusCode = Number(value) || 200; },
    setHeader(name, value) { headers.set(String(name), String(value)); return res; },
    getHeader(name) { return headers.get(String(name)); },
    removeHeader(name) { headers.delete(String(name)); },
    writeHead(status, extra) {
      statusCode = Number(status) || statusCode;
      if (extra && typeof extra === 'object') {
        for (const [key, value] of Object.entries(extra)) headers.set(String(key), String(value));
      }
      return res;
    },
    status(code) { statusCode = Number(code) || 200; return res; },
    json(payload) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
      body = JSON.stringify(payload === undefined ? null : payload);
      finished = true;
      return res;
    },
    send(payload) {
      if (payload === undefined || payload === null) {
        body = '';
      } else if (typeof payload === 'object' && !(payload instanceof Uint8Array)) {
        if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
        body = JSON.stringify(payload);
      } else {
        body = payload;
      }
      finished = true;
      return res;
    },
    end(payload) {
      if (payload !== undefined) body = payload;
      finished = true;
      return res;
    },
    set(obj) {
      if (obj && typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj)) headers.set(String(key), String(value));
      }
      return res;
    }
  };

  return {
    res,
    toResponse() {
      if (!finished && body === null) headers.set('content-type', 'application/json; charset=utf-8');
      return new Response(body, { status: statusCode, headers });
    }
  };
}

function createExpressRequest(request, url, body, query = {}) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  const search = {};
  for (const [key, value] of url.searchParams) search[key] = value;

  const ip = headers['cf-connecting-ip']
    || String(headers['x-forwarded-for'] || '').split(',').map((part) => part.trim()).filter(Boolean)[0]
    || 'unknown';

  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    originalUrl: `${url.pathname}${url.search}`,
    headers,
    query: { ...search, ...query },
    body,
    ip,
    socket: {},
    connection: {}
  };
}

async function runHandler(handler, request, url, query) {
  const body = await readRequestBody(request);
  const req = createExpressRequest(request, url, body, query);
  const { res, toResponse } = createResponseCollector();
  await handler(req, res);
  return toResponse();
}

function pathSegments(pathname, prefix) {
  const rest = pathname.slice(prefix.length);
  return rest.split('/').map((part) => {
    try { return decodeURIComponent(part.trim()); } catch { return part.trim(); }
  }).filter(Boolean);
}

function normalizePath(pathname) {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

function jsonError(status, code, message) {
  return new Response(JSON.stringify({ success: false, code, error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function routeApi(request, url) {
  const pathname = normalizePath(url.pathname);
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Allow': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Master-Key'
      }
    });
  }

  // ── 단일 경로 엔드포인트 ────────────────────────────────────────────────
  if (pathname === '/api/health') return runHandler(healthHandler, request, url);
  if (pathname === '/api/sample') return runHandler(sampleHandler, request, url);
  if (pathname === '/api/generate-image') return runHandler(generateImageHandler, request, url);
  if (pathname === '/api/upload-image') return runHandler(uploadImageHandler, request, url);
  if (pathname === '/api/visitor-stats') return runHandler(visitorStatsHandler, request, url);

  // ── 방명록 ─────────────────────────────────────────────────────────────
  if (pathname === '/api/guestbook') return runHandler(guestbookHandler, request, url);
  if (pathname.startsWith('/api/guestbook/')) {
    const id = pathSegments(pathname, '/api/guestbook')[0] || '';
    return runHandler(guestbookItemHandler, request, url, { id });
  }

  // ── 비밀의 정원 ────────────────────────────────────────────────────────
  if (pathname === '/api/secret-gardens') return runHandler(secretGardensHandler, request, url);
  if (pathname.startsWith('/api/secret-gardens/')) {
    return runHandler(secretGardensPathHandler, request, url);
  }

  // ── 캐치올 라우터 ──────────────────────────────────────────────────────
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return runHandler(authHandler, request, url);
  }
  if (pathname === '/api/billing' || pathname.startsWith('/api/billing/')) {
    return runHandler(billingHandler, request, url);
  }

  return jsonError(404, 'route_not_found', '요청한 API 경로를 찾을 수 없습니다.');
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    syncProcessEnv(env);
    // 업로드 사진 저장소 바인딩(R2 우선, 없으면 KV). 요청마다 갱신해 다른 요청의 바인딩이 남지 않게 한다.
    setUploadStore(env.UPLOADS_BUCKET || env.UPLOADS_KV || null);

    let response;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        response = url.pathname.startsWith('/api/uploads/')
          ? await serveUpload(request, url)
          : await routeApi(request, url);
      } catch (error) {
        console.error('[Worker] unhandled API error:', error?.stack || error?.message || error);
        response = jsonError(500, 'server_error', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
    } else if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      // 정적 자산은 html_handling:"none" 으로 확장자·index 치환 없이 그대로 서빙한다.
      // (google 소유확인 .html 처럼 파일 이름 그대로 내려가야 하는 경우 307 리다이렉트를 막기 위해)
      // 그래서 루트 "/" 만 index.html 로 직접 넘긴다.
      const assetUrl = url.pathname === '/' ? new URL('/index.html', url) : url;
      const assetRequest = assetUrl === url ? request : new Request(assetUrl, request);
      response = await env.ASSETS.fetch(assetRequest);
    } else {
      response = jsonError(404, 'not_found', '찾을 수 없는 경로입니다.');
    }

    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(key)) headers.set(key, value);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
    }
    if (response.status === 204 || response.body === null) {
      return new Response(null, { status: response.status, statusText: response.statusText, headers });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
