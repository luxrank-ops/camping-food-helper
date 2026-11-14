// 사용량(쿼터) 판정과 기록.
//
// 판정은 항상 서버가 사용자 문서를 다시 읽어 계산한다(클라이언트가 보낸 값은 쓰지 않는다).
// 무료/유료 한도는 lib/plans.js 의 plans 설정에서만 온다.

import { isAdmin, kstDayKey, limitFor, normalizeUsage, resolveAccess, usageFieldFor } from '../plans.js';

export function quotaState(user, feature, now = new Date()) {
  const field = usageFieldFor(feature);
  const access = resolveAccess(user, now);
  const usage = normalizeUsage(user?.usage, kstDayKey(now));
  if (!field) return { feature, field: null, used: 0, limit: null, remaining: null, plan: access.plan.id, unlimited: true };
  if (isAdmin(user)) return { feature, field, used: usage[field] || 0, limit: null, remaining: null, plan: access.plan.id, unlimited: true };
  const limit = limitFor(field, access.plan.id);
  const used = usage[field] || 0;
  const remaining = limit === null ? null : Math.max(0, limit - used);
  return { feature, field, used, limit, remaining, plan: access.plan.id, unlimited: limit === null };
}

/** 오늘 한도를 넘었으면 { ok:false, ... } 를 돌려준다. */
export function checkQuota(user, feature, now = new Date()) {
  const state = quotaState(user, feature, now);
  if (state.unlimited) return { ok: true, ...state };
  if (state.used >= state.limit) {
    return {
      ok: false,
      code: 'member_quota_exceeded',
      ...state,
      message: state.plan === 'free'
        ? `오늘 무료 한도(${state.limit}회)를 다 썼어요. PRO로 올리면 하루 ${limitFor(field(feature), 'pro')}회까지 쓸 수 있어요.`
        : `오늘 한도(${state.limit}회)를 다 썼어요. 내일 다시 쓸 수 있어요.`
    };
  }
  return { ok: true, ...state };
}

function field(feature) {
  return usageFieldFor(feature) || feature;
}

/** 실제로 AI/이미지를 만들었을 때 호출해 사용량을 +1 한다. 실패해도 요청 자체는 성공으로 둔다. */
export async function recordUsage(store, user, feature, now = new Date()) {
  const usageField = usageFieldFor(feature);
  if (!usageField || !store || typeof store.incrementUsage !== 'function') return null;
  if (isAdmin(user)) return null;
  try {
    return await store.incrementUsage(user.uid, usageField, kstDayKey(now));
  } catch (error) {
    console.error('[Quota] 사용량 기록 실패:', error?.code || error?.message || error);
    return null;
  }
}
