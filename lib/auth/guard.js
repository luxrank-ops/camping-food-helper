// 요청 인증 가드.
//
// 이 앱은 **게스트도 로그인 없이** 쓸 수 있다. 그래서 대부분의 API 는 `withOptionalUser` 로 감싸
// 토큰이 있으면 req.user(플랜·사용량·role)를 붙이고, 없으면 게스트로 그대로 통과시킨다.
// 회원 본인 정보(/api/auth/me·profile·password·account)와 결제 세션(checkout·portal)만
// `withUserAuth`/`requireUser` 로 로그인을 요구한다.
//
// 응답 규격(클라이언트가 구분해 쓰는 값)
//   401 auth_required  : 로그인 필요한 경로에 토큰이 없음
//   401 invalid_token  : 만료·위조 토큰
//   503 storage_*      : 회원 저장소 설정 문제(토큰을 보냈을 때만)

import { getAuthService } from './service.js';

function failBody(code, message) {
  return { success: false, code, error: message };
}

function bearer(req) {
  const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  return /^Bearer\s+(.+)$/i.test(header);
}

/** 요청 IP(프록시 헤더 우선). 게스트 하루 한도 판정에 쓴다. */
export function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const ip = forwarded || String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  return ip ? ip.slice(0, 64) : 'unknown';
}

/** 요청을 인증한다(필수). 예외를 던지지 않고 결과 객체를 돌려준다. */
export async function requireUser(req, options = {}) {
  const service = options.service || getAuthService();
  try {
    const user = await service.authenticate(req);
    return { ok: true, user };
  } catch (error) {
    const status = Number(error?.statusCode) || 401;
    return {
      ok: false,
      status,
      code: error?.code || 'auth_required',
      message: error?.publicMessage || '로그인이 필요합니다. 이메일로 로그인해 주세요.'
    };
  }
}

/**
 * 토큰이 있으면 사용자를 붙이고, 없으면 게스트로 통과시킨다.
 * 만료·위조 토큰은 게스트로 취급하되 `expired: true` 로 알려 클라이언트가 세션을 정리하게 한다.
 */
export async function optionalUser(req, options = {}) {
  const service = options.service || getAuthService();
  if (!bearer(req)) return { ok: true, user: null, guest: true };
  try {
    const user = await service.authenticate(req);
    return { ok: true, user, guest: false };
  } catch (error) {
    const status = Number(error?.statusCode) || 401;
    if (status === 401) return { ok: true, user: null, guest: true, expired: true };
    // 저장소 장애(503)는 게스트로 조용히 넘기지 않고 알린다(사용량·플랜을 잘못 적용하면 안 됨).
    return {
      ok: false,
      status,
      code: error?.code || 'storage_unavailable',
      message: error?.publicMessage || '회원 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'
    };
  }
}

/** Vercel 서버리스 핸들러를 '로그인 필수'로 만든다. */
export function withUserAuth(handler, options = {}) {
  return async function authenticatedHandler(req, res) {
    const auth = await requireUser(req, options);
    if (!auth.ok) {
      try { res.setHeader('WWW-Authenticate', 'Bearer'); } catch {}
      return res.status(auth.status).json(failBody(auth.code, auth.message));
    }
    req.user = auth.user;
    req.authUser = auth.user;
    return handler(req, res);
  };
}

/** Vercel 서버리스 핸들러를 '게스트 허용'으로 만든다(토큰이 있으면 req.user 채움). */
export function withOptionalUser(handler, options = {}) {
  return async function optionalHandler(req, res) {
    const auth = await optionalUser(req, options);
    if (!auth.ok) {
      return res.status(auth.status).json(failBody(auth.code, auth.message));
    }
    req.user = auth.user || null;
    req.authUser = req.user;
    req.authGuest = !!auth.guest;
    if (auth.expired) {
      try { res.setHeader('X-Auth-Expired', '1'); } catch {}
    }
    return handler(req, res);
  };
}

/** Express 미들웨어 형태(필수). */
export function expressUserAuth(options = {}) {
  return async function (req, res, next) {
    const auth = await requireUser(req, options);
    if (!auth.ok) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(auth.status).json(failBody(auth.code, auth.message));
    }
    req.user = auth.user;
    req.authUser = auth.user;
    return next();
  };
}

/** Express 미들웨어 형태(게스트 허용). */
export function expressOptionalUser(options = {}) {
  return async function (req, res, next) {
    const auth = await optionalUser(req, options);
    if (!auth.ok) {
      return res.status(auth.status).json(failBody(auth.code, auth.message));
    }
    req.user = auth.user || null;
    req.authUser = req.user;
    req.authGuest = !!auth.guest;
    if (auth.expired) res.set('X-Auth-Expired', '1');
    return next();
  };
}
