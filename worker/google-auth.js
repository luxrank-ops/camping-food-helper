// Google 서비스 계정 → OAuth2 액세스 토큰 (Cloudflare Workers 용).
//
// firebase-admin 의 google-auth-library 는 Node 전용 의존성(gRPC·스트림·파일 시스템)이
// 많아 Workers 번들에서 안전하지 않다. 그래서 여기서는 표준 Web Crypto 로
// RS256 JWT(서비스 계정 assertion)를 만들어 Google OAuth2 토큰 엔드포인트에 교환한다.
//
// - 서명 키: Web Crypto(SubtleCrypto)의 RSASSA-PKCS1-v1_5 / SHA-256
// - 토큰은 모듈 메모리에 캐시한다(아이솔레이트가 살아 있는 동안 재사용, 만료 5분 전 갱신)

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** @type {Map<string, {token: string, expiresAt: number}>} */
const tokenCache = new Map();
/** @type {Map<string, CryptoKey>} */
const keyCache = new Map();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toBase64UrlText(text) {
  return toBase64Url(new TextEncoder().encode(text));
}

/** PEM(-----BEGIN PRIVATE KEY-----) → PKCS8 바이너리 */
function pemToPkcs8(pem) {
  const body = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('private_key is empty');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function signingKey(clientEmail, privateKey) {
  const cacheKey = `${clientEmail}:${privateKey.length}:${privateKey.slice(-24)}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  ).catch((error) => {
    keyCache.delete(cacheKey);
    throw error;
  });
  keyCache.set(cacheKey, promise);
  return promise;
}

/**
 * 서비스 계정 자격으로 액세스 토큰을 얻는다.
 * @param {{clientEmail: string, privateKey: string}} credentials
 * @param {string} scope 공백으로 구분한 OAuth2 스코프
 */
export async function getAccessToken(credentials, scope) {
  const clientEmail = String(credentials?.clientEmail || '').trim();
  const privateKey = String(credentials?.privateKey || '');
  if (!clientEmail || !privateKey) throw new Error('service account credentials are missing');

  const cacheKey = `${clientEmail}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return cached.token;

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = toBase64UrlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toBase64UrlText(JSON.stringify({
    iss: clientEmail,
    scope,
    aud: TOKEN_URL,
    iat: issuedAt,
    exp: issuedAt + 3600
  }));
  const data = `${header}.${payload}`;
  const key = await signingKey(clientEmail, privateKey);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data));
  const assertion = `${data}.${toBase64Url(new Uint8Array(signature))}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: JWT_GRANT, assertion }).toString()
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }

  if (!response.ok || !body?.access_token) {
    const reason = body?.error_description || body?.error || text.slice(0, 200);
    const error = new Error(`google token exchange failed: ${response.status} ${reason}`);
    error.code = response.status === 400 || response.status === 401 ? 'invalid_grant' : 'token_exchange_failed';
    throw error;
  }

  const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 3600;
  tokenCache.set(cacheKey, { token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  return body.access_token;
}

/** 테스트용: 캐시를 비운다. */
export function resetGoogleAuthCache() {
  tokenCache.clear();
  keyCache.clear();
}
