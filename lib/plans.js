// 요금제(플랜) · 권한(entitlement) 중앙 설정.
//
// 이 파일 하나만 고치면 무료/유료 정책이 앱 전체(서버 API 제한, 클라이언트 배지·업그레이드 화면)에 반영된다.
// 결제 연동(토스페이먼츠·Stripe 등)은 lib/billing/ 아래 어댑터만 붙이면 되고,
// 실제 권한은 여기 정의된 limits / features 로만 판단한다.
//
// 원칙
//  - 서버가 유일한 판단자다. 클라이언트에 내려주는 entitlements 는 화면 표시용이며,
//    API 는 매 요청마다 사용자 문서를 다시 읽어 plan/status/usage 를 확인한다.
//  - 한도 값이 null 이면 '무제한'이다.
//  - 플랜을 늘릴 때는 PLAN_IDS 와 PLANS 에만 추가한다(코드 분기 최소화).

export const PLAN_IDS = ['free', 'pro'];

/** 한도 없음 표시값. */
export const UNLIMITED = null;

export const PLANS = {
  free: {
    id: 'free',
    label: 'FREE',
    name: '무료',
    tagline: '캠핑 요리 추천의 기본 기능',
    priceKRW: 0,
    billingPeriod: 'month',
    trialDays: 0,
    // 하루(KST) 사용 한도
    limits: { aiPerDay: 10, imagePerDay: 5 },
    features: {
      aiRecommendation: true,
      imageGeneration: true,
      mealPlan: true,
      secretGardens: true,
      privateGardens: true,
      guestbook: true,
      dataExport: true,
      premiumCampgrounds: false,
      prioritySupport: false
    },
    highlights: ['AI 메뉴 추천 · 준비물 · 식단표', '캠핑장 찾기 · 비밀의 정원 등록', '하루 AI 추천 10회 · 요리 사진 5회']
  },
  pro: {
    id: 'pro',
    label: 'PRO',
    name: '프로',
    tagline: '하루 종일 쓰는 캠핑 비서',
    priceKRW: 4900,
    billingPeriod: 'month',
    trialDays: 7,
    limits: { aiPerDay: 100, imagePerDay: 30 },
    features: {
      aiRecommendation: true,
      imageGeneration: true,
      mealPlan: true,
      secretGardens: true,
      privateGardens: true,
      guestbook: true,
      dataExport: true,
      premiumCampgrounds: true,
      prioritySupport: true
    },
    highlights: ['하루 AI 추천 100회 · 요리 사진 30회', '프리미엄 캠핑장 · 오지 스팟 우선 안내', '먼저 받는 새 기능 · 우선 지원']
  }
};

export const DEFAULT_PLAN_ID = 'free';

// 구독 상태값. status 는 결제 연동이 붙었을 때 웹훅이 갱신한다.
//  active    : 정상 이용
//  trial     : 무료 체험(trialEndsAt 까지)
//  canceled  : 해지 예약(currentPeriodEnd 까지 이용)
//  expired   : 기간 만료 → 무료 권한으로 내려간다
//  past_due  : 결제 실패(유예) → 무료 권한으로 내려간다
export const SUBSCRIPTION_STATUSES = ['active', 'trial', 'canceled', 'expired', 'past_due'];

export const USAGE_KEYS = ['aiPerDay', 'imagePerDay'];
const USAGE_FIELD = { aiPerDay: 'ai', imagePerDay: 'image' };

export function normalizePlanId(value) {
  const id = String(value || '').trim().toLowerCase();
  return PLAN_IDS.includes(id) ? id : DEFAULT_PLAN_ID;
}

export function getPlan(value) {
  return PLANS[normalizePlanId(value)];
}

export function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return SUBSCRIPTION_STATUSES.includes(status) ? status : 'active';
}

/** 한국 시간(KST) 기준 날짜 키(YYYY-MM-DD). 사용량은 이 날짜가 바뀌면 0으로 리셋된다. */
export function kstDayKey(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const ms = Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoOrNull(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

/** Firestore·파일에서 읽은 사용량을 오늘 기준 숫자로 정리한다(날짜가 지났으면 0). */
export function normalizeUsage(usage, todayKey = kstDayKey()) {
  const source = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
  const day = String(source.date || '');
  const fresh = day !== todayKey;
  const num = (value) => Math.max(0, Math.floor(Number(value) || 0));
  return {
    date: todayKey,
    ai: fresh ? 0 : num(source.ai),
    image: fresh ? 0 : num(source.image),
    updatedAt: isoOrNull(source.updatedAt)
  };
}

/**
 * 사용자 문서의 plan/status/기간을 보고 '지금 실제로 적용되는 권한'을 계산한다.
 * 유료 기간이 끝났으면(만료·해지 후·결제 실패) 무료 권한으로 내려가되 로그인 자체는 유지한다.
 */
export function resolveAccess(user, now = new Date()) {
  const subscribed = getPlan(user?.plan);
  const status = normalizeStatus(user?.status);
  const currentPeriodEnd = isoOrNull(user?.currentPeriodEnd);
  const trialEndsAt = isoOrNull(user?.trialEndsAt);
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();

  if (subscribed.id === 'free') {
    return { plan: subscribed, subscribedPlanId: subscribed.id, status, reason: 'free' };
  }

  const endsAt = status === 'trial' ? (trialEndsAt || currentPeriodEnd) : currentPeriodEnd;
  const ended = endsAt ? new Date(endsAt).getTime() <= nowMs : false;

  if (status === 'trial') {
    return ended
      ? { plan: PLANS.free, subscribedPlanId: subscribed.id, status, reason: 'trial_ended' }
      : { plan: subscribed, subscribedPlanId: subscribed.id, status, reason: 'trial' };
  }
  if (status === 'canceled') {
    return ended
      ? { plan: PLANS.free, subscribedPlanId: subscribed.id, status, reason: 'subscription_ended' }
      : { plan: subscribed, subscribedPlanId: subscribed.id, status, reason: 'canceled_active' };
  }
  if (status === 'active') {
    return ended
      ? { plan: PLANS.free, subscribedPlanId: subscribed.id, status, reason: 'subscription_ended' }
      : { plan: subscribed, subscribedPlanId: subscribed.id, status, reason: 'active' };
  }
  // expired / past_due
  return { plan: PLANS.free, subscribedPlanId: subscribed.id, status, reason: status };
}

export function isAdmin(user) {
  return String(user?.role || '').trim().toLowerCase() === 'admin';
}

/** 플랜 카탈로그를 화면/결제 연동에서 쓰기 좋은 형태로 요약한다. */
export function planCatalog() {
  return PLAN_IDS.map((id) => {
    const plan = PLANS[id];
    return {
      id: plan.id,
      label: plan.label,
      name: plan.name,
      tagline: plan.tagline,
      priceKRW: plan.priceKRW,
      billingPeriod: plan.billingPeriod,
      trialDays: plan.trialDays,
      limits: { ...plan.limits },
      features: { ...plan.features },
      highlights: [...(plan.highlights || [])]
    };
  });
}

function remainingFor(limit, used) {
  if (limit === UNLIMITED) return UNLIMITED;
  return Math.max(0, Number(limit) - Number(used || 0));
}

/**
 * 클라이언트에 내려주는 권한 묶음. 화면 표시용이며 서버 판정은 이 값을 쓰지 않고
 * requireQuota() 처럼 사용자 문서를 다시 읽어 계산한다.
 */
export function buildEntitlements(user, now = new Date()) {
  const access = resolveAccess(user, now);
  const plan = access.plan;
  const usage = normalizeUsage(user?.usage, kstDayKey(now));
  const admin = isAdmin(user);

  const limits = {};
  const remaining = {};
  for (const key of USAGE_KEYS) {
    limits[key] = admin ? UNLIMITED : plan.limits[key];
    remaining[key] = admin ? UNLIMITED : remainingFor(plan.limits[key], usage[USAGE_FIELD[key]]);
  }

  return {
    plan: plan.id,
    planLabel: plan.label,
    planName: plan.name,
    subscribedPlanId: access.subscribedPlanId,
    status: access.status,
    reason: access.reason,
    pro: plan.id === 'pro',
    admin,
    limits,
    remaining,
    usage: { date: usage.date, ai: usage.ai, image: usage.image },
    features: { ...plan.features },
    trialEndsAt: isoOrNull(user?.trialEndsAt),
    currentPeriodEnd: access.subscribedPlanId === 'free' ? null : isoOrNull(user?.currentPeriodEnd),
    cancelAtPeriodEnd: !!user?.cancelAtPeriodEnd,
    billingProvider: user?.billingProvider || null,
    catalog: planCatalog()
  };
}

/** 사용량 필드 이름(ai/image)을 플랜 한도 키(aiPerDay/imagePerDay)로 바꾼다. */
export function usageFieldFor(feature) {
  const key = String(feature || '');
  if (key === 'ai' || key === 'aiPerDay') return 'ai';
  if (key === 'image' || key === 'imagePerDay') return 'image';
  return null;
}

export function limitFor(feature, planId) {
  const plan = getPlan(planId);
  const field = usageFieldFor(feature);
  if (!field) return UNLIMITED;
  return plan.limits[`${field}PerDay`];
}
