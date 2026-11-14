// /api/auth/* 라우터 (Express 로컬 서버와 Vercel 서버리스가 같은 로직을 쓴다).
//
//   POST   /api/auth/signup    { email, password, nickname }  → 201 { token, user }
//   POST   /api/auth/login     { email, password }            → 200 { token, user }
//   GET    /api/auth/me        (Bearer)                       → 200 { user }   플랜·권한·사용량 포함
//   PATCH  /api/auth/profile   (Bearer) { nickname }          → 200 { user }
//   POST   /api/auth/password  (Bearer) { currentPassword, newPassword }
//   POST   /api/auth/logout    (Bearer)                       → 200 { success }
//   DELETE /api/auth/account   (Bearer)                       → 200 { success }  (회원 탈퇴)
//   GET    /api/auth/plans                                    → 200 { plans }    (공개 요금제 목록)

import { createAuthService, getAuthService } from './auth/service.js';
import { planCatalog } from './plans.js';

function parseBody(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      const error = new Error('요청 내용을 읽을 수 없습니다.');
      error.statusCode = 400;
      error.code = 'invalid_json';
      error.publicMessage = '요청 내용을 읽을 수 없습니다. 다시 시도해 주세요.';
      throw error;
    }
  }
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    const error = new Error('요청 내용이 올바르지 않습니다.');
    error.statusCode = 400;
    error.code = 'invalid_json';
    error.publicMessage = '요청 내용이 올바르지 않습니다.';
    throw error;
  }
  return req.body;
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const ip = forwarded || String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  return ip ? ip.slice(0, 64) : 'unknown';
}

function methodNotAllowed(res, allow) {
  try { res.setHeader('Allow', allow); } catch {}
  return res.status(405).json({ success: false, code: 'method_not_allowed', error: `허용되지 않은 요청 방식입니다. (${allow})` });
}

function errorResponse(res, error) {
  const status = Number(error?.statusCode) || 500;
  const code = error?.code || 'auth_error';
  const message = error?.publicMessage
    || (status >= 500 ? '잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했습니다.');
  if (status === 401) {
    try { res.setHeader('WWW-Authenticate', 'Bearer'); } catch {}
  }
  if (status >= 500) console.error('[Auth API]', code, error?.message || error);
  return res.status(status).json({ success: false, code, error: message });
}

export function createAuthApi(options = {}) {
  const service = options.service || null;
  const getService = () => service || getAuthService();

  return async function handleAuth(req, res, segments = []) {
    const route = String(segments[0] || '').trim().toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();

    try {
      if (route === 'signup') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const body = parseBody(req);
        const result = await getService().signup({ email: body.email, password: body.password, nickname: body.nickname, ip: clientIp(req) });
        return res.status(201).json({ success: true, token: result.token, user: result.user });
      }

      if (route === 'login') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const body = parseBody(req);
        const result = await getService().login({ email: body.email, password: body.password, ip: clientIp(req) });
        return res.status(200).json({ success: true, token: result.token, user: result.user });
      }

      if (route === 'plans') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return res.status(200).json({ success: true, plans: planCatalog() });
      }

      if (route === 'me') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        const user = await getService().authenticate(req);
        const result = await getService().me(user);
        return res.status(200).json({ success: true, user: result.user });
      }

      if (route === 'profile') {
        if (method !== 'PATCH' && method !== 'POST') return methodNotAllowed(res, 'PATCH');
        const user = await getService().authenticate(req);
        const body = parseBody(req);
        const result = await getService().updateProfile(user, { nickname: body.nickname });
        return res.status(200).json({ success: true, user: result.user });
      }

      if (route === 'password') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const user = await getService().authenticate(req);
        const body = parseBody(req);
        await getService().changePassword(user, { currentPassword: body.currentPassword, newPassword: body.newPassword });
        return res.status(200).json({ success: true, code: 'password_changed', error: '비밀번호를 바꿨어요.' });
      }

      if (route === 'logout') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        await getService().logout();
        return res.status(200).json({ success: true });
      }

      if (route === 'account') {
        if (method !== 'DELETE' && method !== 'POST') return methodNotAllowed(res, 'DELETE');
        const user = await getService().authenticate(req);
        await getService().deleteAccount(user);
        return res.status(200).json({ success: true, code: 'account_deleted', error: '회원 정보를 지웠어요.' });
      }

      return res.status(404).json({ success: false, code: 'route_not_found', error: '요청한 인증 경로를 찾을 수 없습니다.' });
    } catch (error) {
      return errorResponse(res, error);
    }
  };
}

export { clientIp as authClientIp };
