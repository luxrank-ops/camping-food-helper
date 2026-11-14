// 로그인 사용자만 통과시키는 인증 가드.
//
// - Vercel 서버리스: withUserAuth(handler) 로 감싼다.
// - Express(로컬): expressUserAuth() 미들웨어를 /api/* 앞에 붙인다.
// - 통과하면 req.user 에 사용자 문서(plan/status/usage/role 포함)가 들어간다.
//
// 응답 규격(클라이언트가 구분해 쓰는 값)
//   401 auth_required  : 토큰이 없음 → 로그인 화면
//   401 invalid_token  : 만료·위조 토큰 → 로그인 화면
//   503 storage_*      : 회원 저장소 설정 문제

import { getAuthService } from './service.js';

function failBody(code, message) {
  return { success: false, code, error: message };
}

/** 요청을 인증한다. 예외를 던지지 않고 결과 객체를 돌려준다. */
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

/** Vercel 서버리스 핸들러를 인증 필수로 만든다. */
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

/** Express 미들웨어 형태. */
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
