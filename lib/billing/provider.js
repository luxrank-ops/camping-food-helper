// 유료화(구독) 결제 어댑터 자리.
//
// 앱의 권한 판단은 lib/plans.js 와 사용자 문서(plan/status/currentPeriodEnd)만 본다.
// 결제 사업자(토스페이먼츠·Stripe 등)는 아래 계약만 구현해 연결하면 되고,
// 그때 이 파일의 PROVIDERS 에 어댑터를 등록하고 Vercel 환경변수에
// BILLING_PROVIDER=toss(또는 stripe) 와 사업자 키를 넣으면 유료화가 켜진다.
//
// 어댑터 계약 (BillingAdapter)
// {
//   id: 'toss' | 'stripe',
//   createCheckout({ user, plan, successUrl, cancelUrl }) → { checkoutUrl, sessionId },
//   createPortal({ user, returnUrl })                    → { portalUrl },
//   verifyWebhook({ headers, rawBody })                  → 이벤트 객체(서명 검증 실패 시 throw),
//   parseEvent(rawEvent)                                 → {
//        id, type, userId, planId, status, currentPeriodEnd, customerId, subscriptionId
//      }   // type 예: subscription.activated / subscription.updated / subscription.canceled /
//           //          subscription.expired / payment.failed / subscription.trial_started
// }
//
// parseEvent 결과는 lib/billing/apply-subscription.js 가 사용자 문서에 반영한다.

import { planCatalog } from '../plans.js';

export const BILLING_PROVIDER_IDS = ['none', 'toss', 'stripe'];

/** 실제 결제 사업자 어댑터를 여기에 등록한다(구현이 없으면 유료 결제는 꺼진 상태). */
export const PROVIDERS = {
  toss: null,
  stripe: null
};

export function configuredProviderId(env = process.env) {
  const id = String(env.BILLING_PROVIDER || '').trim().toLowerCase();
  return BILLING_PROVIDER_IDS.includes(id) && id !== 'none' ? id : null;
}

/**
 * 지금 결제가 가능한지 알려준다.
 * @returns {{ configured: boolean, provider: string|null, reason: string }}
 */
export function billingAvailability(env = process.env) {
  const providerId = configuredProviderId(env);
  if (!providerId) return { configured: false, provider: null, reason: 'billing_provider_not_set' };
  if (!PROVIDERS[providerId]) return { configured: false, provider: providerId, reason: 'billing_adapter_not_connected' };
  return { configured: true, provider: providerId, reason: 'ready' };
}

export function getBillingProvider(env = process.env) {
  const availability = billingAvailability(env);
  if (!availability.configured) return null;
  return PROVIDERS[availability.provider] || null;
}

/** 업그레이드 화면에 보여 줄 유료 플랜 목록. */
export function paidPlans() {
  return planCatalog().filter((plan) => plan.priceKRW > 0);
}

export function billingStatusPayload(env = process.env) {
  const availability = billingAvailability(env);
  return {
    configured: availability.configured,
    provider: availability.provider,
    reason: availability.reason,
    plans: paidPlans()
  };
}
