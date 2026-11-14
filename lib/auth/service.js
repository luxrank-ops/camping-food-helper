// 회원가입·로그인·내 정보·비밀번호 변경 로직 (Express 로컬 서버와 Vercel 서버리스가 공유).
//
// 비밀번호는 lib/garden-password.js 의 scrypt 해시(scrypt1:…)로만 저장한다(평문 저장 금지).
// 로그인에 성공하면 uid가 담긴 서명 토큰(lib/auth/token.js)을 발급하고,
// 클라이언트는 이후 모든 /api/* 요청에 `Authorization: Bearer <token>` 을 붙인다.

import { hashPassword, verifyPasswordHash } from '../garden-password.js';
import { buildEntitlements, kstDayKey, normalizeUsage } from '../plans.js';
import { DEFAULT_TTL_MS, signToken, verifyToken } from './token.js';
import { getUsersStore, normalizeEmail, uidForEmail } from './users-store.js';

export const EMAIL_MAX_LENGTH = 254;
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 20;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function httpError(statusCode, code, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.code = code;
  error.publicMessage = publicMessage;
  return error;
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, code: 'email_required', message: '이메일을 입력해 주세요.' };
  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    return { ok: false, code: 'email_invalid', message: '이메일 형식을 확인해 주세요. 예: camp@example.com' };
  }
  return { ok: true, email };
}

export function validateNickname(value) {
  const nickname = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  if (!nickname) return { ok: false, code: 'nickname_required', message: '닉네임을 입력해 주세요.' };
  if (nickname.length < NICKNAME_MIN_LENGTH || nickname.length > NICKNAME_MAX_LENGTH) {
    return { ok: false, code: 'nickname_invalid', message: `닉네임은 ${NICKNAME_MIN_LENGTH}~${NICKNAME_MAX_LENGTH}자로 입력해 주세요.` };
  }
  if (/[<>]/.test(nickname)) return { ok: false, code: 'nickname_invalid', message: '닉네임에 사용할 수 없는 문자가 있어요.' };
  return { ok: true, nickname };
}

export function validatePassword(value) {
  const password = String(value == null ? '' : value);
  if (!password) return { ok: false, code: 'password_required', message: '비밀번호를 입력해 주세요.' };
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, code: 'password_too_short', message: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상으로 정해 주세요.` };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, code: 'password_too_long', message: `비밀번호는 ${PASSWORD_MAX_LENGTH}자까지 쓸 수 있어요.` };
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return { ok: false, code: 'password_weak', message: '영문과 숫자를 하나씩 섞어 주세요.' };
  }
  return { ok: true, password };
}

/** 로그인 실패 제한(같은 아이피+이메일 10분에 10회). 서버리스에서는 인스턴스 단위 베스트 에포트. */
function createLoginLimiter({ windowMs = LOGIN_WINDOW_MS, maxFailures = LOGIN_MAX_FAILURES } = {}) {
  const failures = new Map();

  function prune(nowMs) {
    if (failures.size < 5000) return;
    for (const [key, entry] of failures) {
      if (nowMs - entry.at > windowMs) failures.delete(key);
    }
  }

  return {
    isBlocked(key, nowMs) {
      const entry = failures.get(key);
      if (!entry) return false;
      if (nowMs - entry.at > windowMs) {
        failures.delete(key);
        return false;
      }
      return entry.count >= maxFailures;
    },
    fail(key, nowMs) {
      const entry = failures.get(key);
      if (!entry || nowMs - entry.at > windowMs) failures.set(key, { count: 1, at: nowMs });
      else failures.set(key, { count: entry.count + 1, at: nowMs });
      prune(nowMs);
    },
    reset(key) {
      failures.delete(key);
    }
  };
}

function publicUser(user, now) {
  const entitlements = buildEntitlements(user, now);
  return {
    uid: user.uid,
    email: user.email,
    nickname: user.nickname,
    plan: entitlements.plan,
    planLabel: entitlements.planLabel,
    planName: entitlements.planName,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    billingProvider: user.billingProvider || null,
    currentPeriodEnd: entitlements.currentPeriodEnd,
    cancelAtPeriodEnd: !!user.cancelAtPeriodEnd,
    entitlements
  };
}

let sharedService = null;

/** 서버리스 인스턴스 안에서 재사용하는 기본 서비스. */
export function getAuthService() {
  if (!sharedService) sharedService = createAuthService();
  return sharedService;
}

export function resetAuthServiceForTests() {
  sharedService = null;
}

export function createAuthService(options = {}) {
  const store = options.store || getUsersStore();
  const now = options.now || (() => new Date());
  const sign = options.signToken || signToken;
  const verify = options.verifyToken || verifyToken;
  const tokenTtlMs = options.tokenTtlMs || DEFAULT_TTL_MS;
  const limiter = options.limiter || createLoginLimiter();

  function requireStore() {
    if (store.kind === 'unavailable') {
      throw httpError(503, 'storage_not_configured', '회원 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase Firestore 설정을 요청해주세요.');
    }
    return store;
  }

  async function readUser(uid) {
    try {
      return await requireStore().get(uid);
    } catch (error) {
      if (error?.statusCode) throw error;
      throw httpError(503, 'storage_unavailable', '회원 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  return {
    store,

    async signup({ email, password, nickname, ip } = {}) {
      const emailCheck = validateEmail(email);
      if (!emailCheck.ok) throw httpError(400, emailCheck.code, emailCheck.message);
      const passwordCheck = validatePassword(password);
      if (!passwordCheck.ok) throw httpError(400, passwordCheck.code, passwordCheck.message);
      const nicknameCheck = validateNickname(nickname);
      if (!nicknameCheck.ok) throw httpError(400, nicknameCheck.code, nicknameCheck.message);

      const at = now();
      const iso = at.toISOString();
      const uid = uidForEmail(emailCheck.email);
      const record = {
        uid,
        email: emailCheck.email,
        emailLower: emailCheck.email,
        nickname: nicknameCheck.nickname,
        passwordHash: hashPassword(passwordCheck.password),
        plan: 'free',
        status: 'active',
        role: 'user',
        usage: normalizeUsage(null, kstDayKey(at)),
        billingProvider: null,
        customerId: null,
        subscriptionId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        trialEndsAt: null,
        signupIp: ip ? String(ip).slice(0, 64) : null,
        createdAt: iso,
        updatedAt: iso,
        lastLoginAt: iso
      };

      let created;
      try {
        created = await requireStore().create(record);
      } catch (error) {
        if (error?.code === 'email_taken') throw httpError(409, 'email_taken', '이미 가입된 이메일입니다. 로그인해 주세요.');
        if (error?.statusCode) throw httpError(error.statusCode, error.code || 'storage_unavailable', error.publicMessage || '회원 저장에 실패했습니다.');
        throw httpError(503, 'storage_unavailable', '회원 저장에 실패했습니다. 잠시 후 다시 시도해주세요.');
      }

      const token = sign({ uid, ttlMs: tokenTtlMs, now: at });
      return { token, user: publicUser(created || record, at) };
    },

    async login({ email, password, ip } = {}) {
      const emailCheck = validateEmail(email);
      if (!emailCheck.ok) throw httpError(400, emailCheck.code, emailCheck.message);
      if (!String(password || '')) throw httpError(400, 'password_required', '비밀번호를 입력해 주세요.');

      const key = `${ip || 'unknown'}:${emailCheck.email}`;
      const at = now();
      if (limiter.isBlocked(key, at.getTime())) {
        throw httpError(429, 'too_many_attempts', '로그인 시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.');
      }

      const uid = uidForEmail(emailCheck.email);
      const user = await readUser(uid);
      // 이메일이 없을 때와 비밀번호가 틀릴 때를 같은 메시지로 답한다(가입 여부 노출 방지).
      if (!user || !verifyPasswordHash(String(password), user.passwordHash)) {
        limiter.fail(key, at.getTime());
        throw httpError(401, 'login_failed', '이메일 또는 비밀번호가 맞지 않아요.');
      }
      limiter.reset(key);

      const updated = await requireStore().update(uid, { lastLoginAt: at.toISOString(), lastLoginIp: ip ? String(ip).slice(0, 64) : null });
      const token = sign({ uid, ttlMs: tokenTtlMs, now: at });
      return { token, user: publicUser(updated || user, at) };
    },

    /** 요청 헤더의 토큰으로 사용자를 확인한다. */
    async authenticate(req) {
      const header = String(req?.headers?.authorization || req?.headers?.Authorization || '');
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) throw httpError(401, 'auth_required', '로그인이 필요합니다. 이메일로 로그인해 주세요.');
      const payload = verify(match[1].trim());
      if (!payload) throw httpError(401, 'invalid_token', '로그인이 만료됐어요. 다시 로그인해 주세요.');
      const user = await readUser(payload.sub);
      if (!user) throw httpError(401, 'invalid_token', '로그인이 만료됐어요. 다시 로그인해 주세요.');
      return user;
    },

    async me(user) {
      return { user: publicUser(user, now()) };
    },

    async updateProfile(user, { nickname } = {}) {
      const check = validateNickname(nickname);
      if (!check.ok) throw httpError(400, check.code, check.message);
      const updated = await requireStore().update(user.uid, { nickname: check.nickname });
      return { user: publicUser(updated || { ...user, nickname: check.nickname }, now()) };
    },

    async changePassword(user, { currentPassword, newPassword } = {}) {
      if (!verifyPasswordHash(String(currentPassword || ''), user.passwordHash)) {
        throw httpError(400, 'password_mismatch', '지금 쓰는 비밀번호가 맞지 않아요.');
      }
      const check = validatePassword(newPassword);
      if (!check.ok) throw httpError(400, check.code, check.message);
      if (String(currentPassword) === String(newPassword)) {
        throw httpError(400, 'password_same', '지금 쓰는 비밀번호와 다른 비밀번호를 정해 주세요.');
      }
      await requireStore().update(user.uid, { passwordHash: hashPassword(check.password) });
      return { success: true };
    },

    /** 로그아웃은 토큰을 버리는 일이라 서버 상태가 없다(응답만 확인). */
    async logout() {
      return { success: true };
    },

    /** 회원 탈퇴(테스트 계정 정리·본인 요청용). */
    async deleteAccount(user) {
      await requireStore().remove(user.uid);
      return { success: true };
    },

    publicUser
  };
}
