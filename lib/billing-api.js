// /api/billing/* 라우터 — 유료화 연결 지점.
//
//   GET  /api/billing/status    현재 결제 연결 상태 + 유료 플랜 목록 (공개)
//   POST /api/billing/checkout  (Bearer) 로그인 사용자의 구독 결제 세션 만들기
//   POST /api/billing/portal    (Bearer) 구독 관리(카드 변경·해지) 화면 열기
//   POST /api/billing/webhook   결제 사업자 → 구독 상태 통지 (서명 검증)
//
// 지금은 결제 사업자 어댑터(lib/billing/provider.js)가 비어 있어 checkout/portal 은
// 503 billing_not_configured 로 답하고, 화면에는 '준비 중' 안내가 보인다.
// 어댑터를 등록하고 BILLING_PROVIDER 를 설정하면 이 파일은 고치지 않아도 된다.

import { getAuthService } from './auth/service.js';
import { applySubscriptionEvent } from './billing/apply-subscription.js';
import { billingStatusPayload, getBillingProvider } from './billing/provider.js';

function methodNotAllowed(res, allow) {
  try { res.setHeader('Allow', allow); } catch {}
  return res.status(405).json({ success: false, code: 'method_not_allowed', error: `허용되지 않은 요청 방식입니다. (${allow})` });
}

function errorResponse(res, error) {
  const status = Number(error?.statusCode) || 500;
  const code = error?.code || 'billing_error';
  const message = error?.publicMessage || (status >= 500 ? '잠시 후 다시 시도해 주세요.' : '요청을 처리하지 못했습니다.');
  if (status >= 500) console.error('[Billing API]', code, error?.message || error);
  return res.status(status).json({ success: false, code, error: message });
}

function notConfigured(res) {
  return res.status(503).json({
    success: false,
    code: 'billing_not_configured',
    error: '결제 연결을 준비하고 있어요. 곧 열립니다.'
  });
}

function readRawBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

export function createBillingApi(options = {}) {
  const service = options.service || null;
  const getService = () => service || getAuthService();
  const store = options.store || null;
  const env = options.env || process.env;

  return async function handleBilling(req, res, segments = []) {
    const route = String(segments[0] || '').trim().toLowerCase();
    const method = String(req.method || 'GET').toUpperCase();

    try {
      if (route === 'status') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return res.status(200).json({ success: true, ...billingStatusPayload(env) });
      }

      if (route === 'checkout') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const user = await getService().authenticate(req);
        const provider = getBillingProvider(env);
        if (!provider) return notConfigured(res);
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const session = await provider.createCheckout({
          user,
          plan: body.plan || 'pro',
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl
        });
        return res.status(200).json({ success: true, ...session });
      }

      if (route === 'portal') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const user = await getService().authenticate(req);
        const provider = getBillingProvider(env);
        if (!provider) return notConfigured(res);
        const body = (req.body && typeof req.body === 'object') ? req.body : {};
        const portal = await provider.createPortal({ user, returnUrl: body.returnUrl });
        return res.status(200).json({ success: true, ...portal });
      }

      if (route === 'webhook') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        const provider = getBillingProvider(env);
        if (!provider) return notConfigured(res);
        const rawBody = readRawBody(req);
        const verified = await provider.verifyWebhook({ headers: req.headers || {}, rawBody });
        const event = provider.parseEvent(verified);
        const target = store || getService().store;
        const result = await applySubscriptionEvent(target, {
          ...event,
          provider: provider.id
        });
        return res.status(200).json({ success: true, applied: result.applied, reason: result.reason || null });
      }

      return res.status(404).json({ success: false, code: 'route_not_found', error: '요청한 결제 경로를 찾을 수 없습니다.' });
    } catch (error) {
      return errorResponse(res, error);
    }
  };
}
