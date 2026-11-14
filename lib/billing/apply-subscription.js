// 결제 웹훅 이벤트를 사용자 문서에 반영한다.
//
// 결제 사업자를 연결하면 웹훅(구독 시작·갱신·해지·실패)만 이 함수로 넘기면
// users/{uid} 의 plan/status/currentPeriodEnd/billingProvider… 가 갱신되고,
// 앱의 모든 API 제한(lib/plans.js)이 즉시 새 플랜을 따른다.
// 코드 분기를 새로 만들 필요가 없도록 이벤트 → 문서 매핑을 여기 한 곳에 모은다.

import { getPlan, normalizeStatus } from '../plans.js';

export const SUBSCRIPTION_EVENT_TYPES = [
  'subscription.activated',
  'subscription.trial_started',
  'subscription.updated',
  'subscription.canceled',
  'subscription.expired',
  'payment.failed'
];

function badEvent(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'invalid_billing_event';
  error.publicMessage = message;
  return error;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 이벤트를 사용자 문서 패치로 바꾼다(저장은 하지 않는다 — 테스트·검토가 쉽도록).
 * @returns {null | object} 반영할 패치
 */
export function subscriptionPatch(event, now = new Date()) {
  const type = String(event?.type || '').trim();
  if (!SUBSCRIPTION_EVENT_TYPES.includes(type)) throw badEvent(`알 수 없는 결제 이벤트입니다: ${type || '(없음)'}`);
  if (!event?.userId) throw badEvent('결제 이벤트에 사용자(uid)가 없습니다.');

  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  const base = {
    updatedAt: iso,
    lastBillingEventId: event.id ? String(event.id) : null,
    lastBillingEventAt: iso
  };
  if (event.provider) base.billingProvider = String(event.provider).slice(0, 32);
  if (event.customerId) base.customerId = String(event.customerId).slice(0, 128);
  if (event.subscriptionId) base.subscriptionId = String(event.subscriptionId).slice(0, 128);

  const plan = getPlan(event.planId || 'pro');

  if (type === 'subscription.activated' || type === 'subscription.updated') {
    return {
      ...base,
      plan: plan.id,
      status: normalizeStatus(event.status || 'active'),
      currentPeriodEnd: isoOrNull(event.currentPeriodEnd),
      cancelAtPeriodEnd: !!event.cancelAtPeriodEnd,
      trialEndsAt: null
    };
  }
  if (type === 'subscription.trial_started') {
    return {
      ...base,
      plan: plan.id,
      status: 'trial',
      trialEndsAt: isoOrNull(event.currentPeriodEnd),
      currentPeriodEnd: isoOrNull(event.currentPeriodEnd),
      cancelAtPeriodEnd: false
    };
  }
  if (type === 'subscription.canceled') {
    return {
      ...base,
      // 해지해도 결제한 기간(currentPeriodEnd)까지는 그대로 쓴다.
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: isoOrNull(event.currentPeriodEnd)
    };
  }
  if (type === 'subscription.expired') {
    return {
      ...base,
      status: 'expired',
      cancelAtPeriodEnd: false
    };
  }
  // payment.failed
  return {
    ...base,
    status: 'past_due',
    currentPeriodEnd: isoOrNull(event.currentPeriodEnd)
  };
}

/**
 * 웹훅 이벤트를 저장소에 반영한다. 같은 이벤트를 두 번 받아도 결과가 같다(멱등).
 * @param {{ get: Function, update: Function }} store 사용자 저장소
 */
export async function applySubscriptionEvent(store, event, now = new Date()) {
  const patch = subscriptionPatch(event, now);
  if (!patch) return { applied: false, reason: 'nothing_to_apply' };

  const existing = await store.get(event.userId);
  if (!existing) {
    const error = new Error('결제 이벤트의 사용자를 찾을 수 없습니다.');
    error.statusCode = 404;
    error.code = 'user_not_found';
    error.publicMessage = '결제 이벤트의 사용자를 찾을 수 없습니다.';
    throw error;
  }
  if (event.id && existing.lastBillingEventId && String(existing.lastBillingEventId) === String(event.id)) {
    return { applied: false, reason: 'duplicate_event' };
  }

  const updated = await store.update(event.userId, patch);
  return { applied: true, user: updated };
}
