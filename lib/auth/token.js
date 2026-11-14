// 로그인 세션 토큰(서명된 JWT, HS256) 발급·검증.
//
// - 외부 라이브러리 없이 node:crypto 만 쓴다(서버리스 번들 크기·취약점 표면 최소화).
// - 서명 키는 AUTH_SECRET 환경변수를 우선 쓰고, 없으면 Firebase 서비스 계정에서 유도한다.
//   (Vercel에 이미 등록된 FIREBASE_SERVICE_ACCOUNT 만으로 바로 동작하도록 하기 위함이며,
//    서비스 계정 키를 교체하면 기존 로그인 세션은 모두 만료된다 — 다시 로그인하면 된다.)
// - 토큰에는 uid(sub)·버전·발급시각·만료시각만 담는다. 플랜·권한은 담지 않고
//   요청마다 Firestore 사용자 문서를 다시 읽어 판단한다(플랜 변경이 즉시 반영되도록).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const TOKEN_VERSION = 1;
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;
const DEV_FALLBACK_LABEL = 'camping-food-helper-dev-only';

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function fromBase64url(value) {
  return Buffer.from(String(value), 'base64url');
}

export function authSecretSource(env = process.env) {
  const configured = String(env.AUTH_SECRET || '').trim();
  if (configured.length >= MIN_SECRET_LENGTH) return { source: 'env', value: configured };
  const serviceAccount = String(env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (serviceAccount) return { source: 'service-account', value: serviceAccount };
  return { source: 'dev', value: DEV_FALLBACK_LABEL };
}

function signingKey(env = process.env) {
  const { source, value } = authSecretSource(env);
  return createHash('sha256').update(`camping-food-helper:auth-token:v1:${source}:${value}`).digest();
}

function signature(data, env = process.env) {
  return createHmac('sha256', signingKey(env)).update(data).digest();
}

/**
 * 세션 토큰을 만든다.
 * @param {{uid: string, ttlMs?: number, now?: Date}} args
 */
export function signToken({ uid, ttlMs = DEFAULT_TTL_MS, now = new Date() }, env = process.env) {
  const id = String(uid || '').trim();
  if (!id) throw new Error('signToken: uid가 필요합니다.');
  const issuedAt = Math.floor((now instanceof Date ? now.getTime() : Date.now()) / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: id,
    v: TOKEN_VERSION,
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttlMs / 1000)
  }));
  const data = `${header}.${payload}`;
  return `${data}.${signature(data, env).toString('base64url')}`;
}

/**
 * 토큰을 검증하고 payload를 돌려준다. 형식·서명·만료 중 하나라도 어긋나면 null.
 */
export function verifyToken(token, { now = new Date(), env = process.env } = {}) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, payload, signaturePart] = parts;
    const expected = signature(`${header}.${payload}`, env);
    const actual = fromBase64url(signaturePart);
    if (actual.length !== expected.length) return null;
    if (!timingSafeEqual(actual, expected)) return null;

    const head = JSON.parse(fromBase64url(header).toString('utf8'));
    if (head?.alg !== 'HS256') return null;

    const body = JSON.parse(fromBase64url(payload).toString('utf8'));
    if (!body || body.v !== TOKEN_VERSION) return null;
    if (typeof body.sub !== 'string' || !body.sub) return null;
    const nowSec = Math.floor((now instanceof Date ? now.getTime() : Date.now()) / 1000);
    if (typeof body.exp !== 'number' || body.exp <= nowSec) return null;
    if (typeof body.iat !== 'number' || body.iat > nowSec + 300) return null;
    return body;
  } catch {
    return null;
  }
}

/** 테스트·진단용: 노출되어도 안전한 키 출처 라벨. */
export function describeSecret(env = process.env) {
  const { source } = authSecretSource(env);
  return source === 'dev' ? 'dev-fallback' : source;
}
