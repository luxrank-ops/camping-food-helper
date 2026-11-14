// 게스트(비로그인) 하루 사용 한도.
//
// 앱은 로그인 없이도 쓸 수 있으므로, AI 추천·이미지 생성처럼 실제 비용이 나가는 호출은
// 로그인 사용자와 별개로 **아이피 기준**으로 가볍게 제한한다.
//
// 한계(정직하게 남깁니다)
//  - 서버리스 인스턴스 메모리에만 기록한다. 인스턴스가 새로 뜨면 카운트가 0에서 시작하고,
//    여러 인스턴스에 요청이 나뉘면 실제로는 한도보다 조금 더 허용될 수 있다(베스트 에포트).
//  - 정확한 회계와 플랜 적용은 로그인 사용자(users/{uid}.usage)에서만 한다.
//  - 남용이 문제가 되면 Vercel KV/Upstash 같은 공유 저장소로 교체하면 된다(이 파일만 교체).

import { GUEST_LIMITS, kstDayKey } from '../plans.js';

const MAX_ENTRIES = 5000;
const entries = new Map();

function prune(dayKey) {
  if (entries.size <= MAX_ENTRIES) return;
  for (const [key, value] of entries) {
    if (value?.date !== dayKey) entries.delete(key);
  }
  // 그래도 넘치면 오래된 것부터 버린다
  if (entries.size > MAX_ENTRIES) {
    for (const key of [...entries.keys()].slice(0, Math.ceil(entries.size / 2))) entries.delete(key);
  }
}

function stateFor(ip, dayKey = kstDayKey()) {
  const key = String(ip || 'unknown');
  const current = entries.get(key);
  if (!current || current.date !== dayKey) {
    const fresh = { date: dayKey, ai: 0, image: 0 };
    entries.set(key, fresh);
    return { key, state: fresh };
  }
  return { key, state: current };
}

/** 한도 안이면 { ok:true }, 넘었으면 { ok:false, code:'guest_quota_exceeded', ... } */
export function checkGuestQuota(ip, feature, limits = GUEST_LIMITS, dayKey = kstDayKey()) {
  const field = feature === 'image' ? 'image' : 'ai';
  const limit = limits[`${field}PerDay`];
  const { state } = stateFor(ip, dayKey);
  const used = Number(state[field]) || 0;
  if (limit !== null && used >= limit) {
    return {
      ok: false,
      code: 'guest_quota_exceeded',
      guest: true,
      limit,
      used,
      message: field === 'image'
        ? `로그인 없이 쓸 수 있는 오늘의 요리 사진(${limit}장)을 다 썼어요. 로그인하면 더 만들 수 있어요.`
        : `로그인 없이 쓸 수 있는 오늘의 AI 추천(${limit}회)을 다 썼어요. 로그인하면 더 쓸 수 있어요.`
    };
  }
  return { ok: true, guest: true, limit, used };
}

/** 실제로 만들어 준 뒤 +1. */
export function recordGuestUsage(ip, feature, dayKey = kstDayKey()) {
  const field = feature === 'image' ? 'image' : 'ai';
  const { key, state } = stateFor(ip, dayKey);
  state[field] = (Number(state[field]) || 0) + 1;
  entries.set(key, state);
  prune(dayKey);
  return state;
}

export function resetGuestQuotaForTests() {
  entries.clear();
}

/** 진단용(테스트·운영 점검): 지금 추적 중인 게스트 수. */
export function guestQuotaSize() {
  return entries.size;
}
