// 회원가입·로그인·권한(플랜)·결제 연동 지점 회귀 테스트 (node --test)
//
// 대상
//  - lib/auth/token.js       서명 토큰 발급·검증(위조·만료 차단)
//  - lib/auth/service.js     가입·로그인·닉네임·비밀번호 변경, 로그인 실패 제한
//  - lib/auth/users-store.js 메모리·파일 저장소(중복 가입 차단)
//  - lib/auth/quota.js       무료 한도 초과 차단, 관리자 무제한
//  - lib/plans.js            플랜 권한 계산(만료·해지 후 무료로 내려감)
//  - lib/auth-api.js         /api/auth/* 응답 규격과 비로그인 차단
//  - lib/billing/*           결제 어댑터 준비 상태와 웹훅 → 사용자 문서 반영
//  - scripts/uptime-check.mjs 로그인 게이트가 헬스체크에서 정상(401)으로 판정되는지
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signToken, verifyToken, describeSecret } from '../lib/auth/token.js';
import { createAuthService, validateEmail, validatePassword, validateNickname } from '../lib/auth/service.js';
import { createMemoryUsersStore, createFileUsersStore, normalizeEmail, uidForEmail } from '../lib/auth/users-store.js';
import { checkQuota, quotaState } from '../lib/auth/quota.js';
import { requireUser, withUserAuth } from '../lib/auth/guard.js';
import { createAuthApi } from '../lib/auth-api.js';
import { createBillingApi } from '../lib/billing-api.js';
import { applySubscriptionEvent, subscriptionPatch } from '../lib/billing/apply-subscription.js';
import { billingAvailability } from '../lib/billing/provider.js';
import {
  buildEntitlements,
  kstDayKey,
  normalizeUsage,
  planCatalog,
  resolveAccess,
  PLANS
} from '../lib/plans.js';
import { CHECKS, probe } from './uptime-check.mjs';
import { catchAllSegments, secretGardenSegments } from '../lib/route-segments.js';

const ENV = { AUTH_SECRET: 'test-secret-key-for-camping-food-helper' };
const cn = (count, text) => Array.from({ length: count }, () => text);

function responseMock() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

function makeService() {
  const store = createMemoryUsersStore();
  const service = createAuthService({ store, signToken: (args) => signToken(args, ENV), verifyToken: (token) => verifyToken(token, { env: ENV }) });
  return { store, service };
}

async function api(handler, { method = 'GET', segments = [], body = {}, headers = {} } = {}) {
  const res = responseMock();
  await handler({ method, body, query: {}, headers }, res, segments);
  return res;
}

// ── 토큰 ────────────────────────────────────────────────
test('세션 토큰: 발급한 토큰만 통과하고 위조·만료 토큰은 거부한다', () => {
  const token = signToken({ uid: 'u123' }, ENV);
  const payload = verifyToken(token, { env: ENV });
  assert.equal(payload.sub, 'u123');

  const [header, body] = token.split('.');
  assert.equal(verifyToken(`${header}.${body}.forged-signature`, { env: ENV }), null);
  assert.equal(verifyToken(token, { env: { AUTH_SECRET: 'another-secret-key-1234' } }), null);
  assert.equal(verifyToken('not-a-token', { env: ENV }), null);

  const expired = signToken({ uid: 'u123', ttlMs: -1000 }, ENV);
  assert.equal(verifyToken(expired, { env: ENV }), null);
  assert.ok(['env', 'service-account', 'dev'].includes(describeSecret(ENV)));
});

// ── 입력 검증 ────────────────────────────────────────────
test('입력 검증: 이메일·비밀번호·닉네임 규칙이 친절한 한국어 오류를 돌려준다', () => {
  assert.equal(validateEmail('Camp@Example.com ').email, 'camp@example.com');
  assert.equal(validateEmail('no-at-sign').code, 'email_invalid');
  assert.equal(validateEmail('').code, 'email_required');

  assert.equal(validatePassword('abcd1234').ok, true);
  assert.equal(validatePassword('short1').code, 'password_too_short');
  assert.equal(validatePassword('onlyletters').code, 'password_weak');
  assert.equal(validatePassword('12345678').code, 'password_weak');

  assert.equal(validateNickname('  캠핑왕  ').nickname, '캠핑왕');
  assert.equal(validateNickname('a').code, 'nickname_invalid');
  assert.equal(validateNickname('<b>x</b>').code, 'nickname_invalid');
});

// ── 가입·로그인 ─────────────────────────────────────────
test('회원가입: 무료 플랜 회원 문서를 만들고 바로 쓸 수 있는 토큰을 준다', async () => {
  const { store, service } = makeService();
  const result = await service.signup({ email: 'Camp@Test.com', password: 'abcd1234', nickname: '춘학' });

  assert.ok(result.token);
  assert.equal(result.user.email, 'camp@test.com');
  assert.equal(result.user.nickname, '춘학');
  assert.equal(result.user.plan, 'free');
  assert.equal(result.user.status, 'active');
  assert.equal(result.user.role, 'user');
  assert.equal(result.user.entitlements.planLabel, 'FREE');

  const doc = await store.get(uidForEmail('camp@test.com'));
  assert.equal(doc.emailLower, 'camp@test.com');
  assert.match(doc.passwordHash, /^scrypt1:/);
  assert.ok(!Object.hasOwn(doc, 'password'), '평문 비밀번호는 저장하지 않는다');
});

test('회원가입: 같은 이메일은 409 이고 대소문자·공백을 구분하지 않는다', async () => {
  const { service } = makeService();
  await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });
  await assert.rejects(
    () => service.signup({ email: ' CAMP@test.com ', password: 'abcd1234', nickname: '다른이름' }),
    (err) => err.statusCode === 409 && err.code === 'email_taken'
  );
});

test('로그인: 비밀번호가 틀리면 401, 맞으면 새 토큰을 주고 마지막 로그인 시각을 남긴다', async () => {
  const { store, service } = makeService();
  const signup = await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });

  await assert.rejects(
    () => service.login({ email: 'camp@test.com', password: 'wrong-password1' }),
    (err) => err.statusCode === 401 && err.code === 'login_failed'
  );
  // 가입하지 않은 이메일도 같은 오류(가입 여부 노출 방지)
  await assert.rejects(
    () => service.login({ email: 'nobody@test.com', password: 'abcd1234' }),
    (err) => err.code === 'login_failed'
  );

  const login = await service.login({ email: 'camp@test.com', password: 'abcd1234', ip: '1.2.3.4' });
  assert.ok(login.token);
  assert.equal(login.user.uid, signup.user.uid);
  const doc = await store.get(signup.user.uid);
  assert.ok(doc.lastLoginAt);
});

test('로그인: 같은 아이피에서 10번 틀리면 10분 동안 429로 막는다', async () => {
  const { service } = makeService();
  await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() => service.login({ email: 'camp@test.com', password: 'nope-nope1', ip: '9.9.9.9' }));
  }
  await assert.rejects(
    () => service.login({ email: 'camp@test.com', password: 'abcd1234', ip: '9.9.9.9' }),
    (err) => err.statusCode === 429 && err.code === 'too_many_attempts'
  );
});

test('세션 확인·닉네임·비밀번호 변경: 헤더 토큰으로 본인을 찾고 비밀번호를 교체한다', async () => {
  const { service } = makeService();
  const signup = await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });
  const req = { headers: { authorization: `Bearer ${signup.token}` } };

  const user = await service.authenticate(req);
  assert.equal(user.uid, signup.user.uid);

  const renamed = await service.updateProfile(user, { nickname: '불멍러' });
  assert.equal(renamed.user.nickname, '불멍러');

  await assert.rejects(
    () => service.changePassword(user, { currentPassword: 'wrong-one1', newPassword: 'newpass123' }),
    (err) => err.code === 'password_mismatch'
  );
  await service.changePassword(user, { currentPassword: 'abcd1234', newPassword: 'newpass123' });
  await assert.rejects(() => service.login({ email: 'camp@test.com', password: 'abcd1234' }), (err) => err.code === 'login_failed');
  const relogin = await service.login({ email: 'camp@test.com', password: 'newpass123' });
  assert.ok(relogin.token);

  await assert.rejects(
    () => service.authenticate({ headers: { authorization: 'Bearer broken.token.value' } }),
    (err) => err.statusCode === 401 && err.code === 'invalid_token'
  );
  await assert.rejects(
    () => service.authenticate({ headers: {} }),
    (err) => err.statusCode === 401 && err.code === 'auth_required'
  );
});

// ── 저장소 ──────────────────────────────────────────────
test('파일 저장소(로컬 개발): 가입 정보를 파일에 남기고 다시 읽어 로그인할 수 있다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfs-users-'));
  const file = path.join(dir, 'users.local.json');
  const store = createFileUsersStore(file);
  const service = createAuthService({ store, signToken: (args) => signToken(args, ENV), verifyToken: (t) => verifyToken(t, { env: ENV }) });

  await service.signup({ email: 'local@test.com', password: 'abcd1234', nickname: '로컬' });
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(raw.users).length, 1);

  const login = await service.login({ email: 'local@test.com', password: 'abcd1234' });
  assert.equal(login.user.nickname, '로컬');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 플랜·권한 ───────────────────────────────────────────
test('플랜: 무료는 한도가 있고 PRO는 넉넉하며, 유료 기간이 끝나면 무료 권한으로 내려간다', () => {
  assert.equal(PLANS.free.limits.aiPerDay < PLANS.pro.limits.aiPerDay, true);
  assert.deepEqual(planCatalog().map((p) => p.id), ['free', 'pro']);

  const now = new Date('2026-11-14T03:00:00Z');
  const active = resolveAccess({ plan: 'pro', status: 'active', currentPeriodEnd: '2027-01-01T00:00:00Z' }, now);
  assert.equal(active.plan.id, 'pro');

  const ended = resolveAccess({ plan: 'pro', status: 'canceled', currentPeriodEnd: '2026-11-01T00:00:00Z' }, now);
  assert.equal(ended.plan.id, 'free');
  assert.equal(ended.reason, 'subscription_ended');

  const canceledActive = buildEntitlements(
    { uid: 'u', plan: 'pro', status: 'canceled', currentPeriodEnd: '2026-11-30T00:00:00Z' },
    now
  );
  assert.equal(canceledActive.pro, true);
  assert.equal(canceledActive.reason, 'canceled_active');

  const expired = buildEntitlements({ uid: 'u', plan: 'pro', status: 'expired' }, now);
  assert.equal(expired.plan, 'free');
  assert.equal(expired.reason, 'expired');
});

test('사용량: 날짜가 바뀌면 0으로 리셋되고, 무료 한도를 넘으면 quota_exceeded 로 막힌다', () => {
  const today = kstDayKey();
  const stale = normalizeUsage({ date: '2026-01-01', ai: 99, image: 4 }, today);
  assert.equal(stale.ai, 0);

  const user = { uid: 'u', plan: 'free', status: 'active', usage: { date: today, ai: PLANS.free.limits.aiPerDay, image: 0 } };
  const blocked = checkQuota(user, 'ai');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'member_quota_exceeded');
  assert.equal(blocked.limit, PLANS.free.limits.aiPerDay);

  const image = checkQuota(user, 'image');
  assert.equal(image.ok, true);

  const admin = checkQuota({ ...user, role: 'admin' }, 'ai');
  assert.equal(admin.ok, true);
  assert.equal(quotaState({ ...user, role: 'admin' }, 'ai').unlimited, true);
});

// ── API 응답 ────────────────────────────────────────────
test('/api/auth: 가입·로그인·me·로그아웃 응답 규격과 비로그인 차단', async () => {
  const { service } = makeService();
  const handler = createAuthApi({ service });

  const signup = await api(handler, {
    method: 'POST',
    segments: ['signup'],
    body: { email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' }
  });
  assert.equal(signup.statusCode, 201);
  assert.equal(signup.payload.success, true);
  assert.ok(signup.payload.token);
  assert.equal(signup.payload.user.nickname, '춘학');

  const duplicate = await api(handler, {
    method: 'POST',
    segments: ['signup'],
    body: { email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' }
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.payload.code, 'email_taken');

  const login = await api(handler, { method: 'POST', segments: ['login'], body: { email: 'camp@test.com', password: 'abcd1234' } });
  assert.equal(login.statusCode, 200);

  const me = await api(handler, { segments: ['me'], headers: { authorization: `Bearer ${login.payload.token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.payload.user.plan, 'free');
  assert.equal(me.payload.user.entitlements.limits.aiPerDay, PLANS.free.limits.aiPerDay);

  const noToken = await api(handler, { segments: ['me'] });
  assert.equal(noToken.statusCode, 401);
  assert.equal(noToken.payload.code, 'auth_required');
  assert.equal(noToken.headers['WWW-Authenticate'], 'Bearer');

  const plans = await api(handler, { segments: ['plans'] });
  assert.equal(plans.statusCode, 200);
  assert.equal(plans.payload.plans.length, 2);

  const missing = await api(handler, { method: 'POST', segments: ['nope'], body: {} });
  assert.equal(missing.statusCode, 404);
});

test('모든 /api/* 보호: withUserAuth 가 비로그인 호출을 401로 막고 로그인 사용자만 통과시킨다', async () => {
  const { service } = makeService();
  const signup = await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });

  const guarded = withUserAuth(async (req, res) => res.status(200).json({ ok: true, uid: req.user.uid }), { service });

  const denied = await api(guarded);
  assert.equal(denied.statusCode, 401);
  assert.equal(denied.payload.code, 'auth_required');

  const allowed = await api(guarded, { headers: { authorization: `Bearer ${signup.token}` } });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.payload.uid, signup.user.uid);

  const direct = await requireUser({ headers: {} }, { service });
  assert.equal(direct.ok, false);
  assert.equal(direct.status, 401);
});

// ── 결제 연동 지점 ──────────────────────────────────────
test('결제: 어댑터가 없으면 checkout 은 503 billing_not_configured 로 답하고 상태 조회는 plans 를 준다', async () => {
  assert.equal(billingAvailability({}).configured, false);
  assert.equal(billingAvailability({ BILLING_PROVIDER: 'toss' }).reason, 'billing_adapter_not_connected');

  const { service } = makeService();
  const signup = await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });
  const billing = createBillingApi({ service, env: {} });

  const status = await api(billing, { segments: ['status'] });
  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.configured, false);
  assert.equal(status.payload.plans[0].id, 'pro');

  const checkout = await api(billing, { method: 'POST', segments: ['checkout'], body: { plan: 'pro' } });
  assert.equal(checkout.statusCode, 401, '결제 세션도 로그인한 사용자만 만들 수 있다');

  const loggedIn = await api(billing, {
    method: 'POST',
    segments: ['checkout'],
    body: { plan: 'pro' },
    headers: { authorization: `Bearer ${signup.token}` }
  });
  assert.equal(loggedIn.statusCode, 503);
  assert.equal(loggedIn.payload.code, 'billing_not_configured');
});

test('결제 웹훅 → 사용자 문서: 구독 시작·해지·실패가 플랜과 기간에 반영된다(중복 이벤트는 무시)', async () => {
  const { store, service } = makeService();
  const signup = await service.signup({ email: 'camp@test.com', password: 'abcd1234', nickname: '춘학' });
  const uid = signup.user.uid;

  const activated = subscriptionPatch({
    id: 'evt_1',
    type: 'subscription.activated',
    userId: uid,
    planId: 'pro',
    currentPeriodEnd: '2026-12-14T00:00:00Z',
    customerId: 'cus_1',
    subscriptionId: 'sub_1'
  });
  assert.equal(activated.plan, 'pro');
  assert.equal(activated.status, 'active');
  assert.equal(activated.currentPeriodEnd, '2026-12-14T00:00:00.000Z');

  const first = await applySubscriptionEvent(store, {
    id: 'evt_1',
    type: 'subscription.activated',
    userId: uid,
    planId: 'pro',
    currentPeriodEnd: '2026-12-14T00:00:00Z',
    customerId: 'cus_1',
    subscriptionId: 'sub_1'
  });
  assert.equal(first.applied, true);

  const user = await store.get(uid);
  assert.equal(user.plan, 'pro');
  assert.equal(user.status, 'active');
  assert.equal(user.customerId, 'cus_1');
  assert.equal(user.subscriptionId, 'sub_1');
  const entitlements = buildEntitlements(user, new Date('2026-11-14T03:00:00Z'));
  assert.equal(entitlements.pro, true);
  assert.equal(entitlements.limits.aiPerDay, PLANS.pro.limits.aiPerDay);

  const duplicate = await applySubscriptionEvent(store, { id: 'evt_1', type: 'subscription.activated', userId: uid });
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.reason, 'duplicate_event');

  await applySubscriptionEvent(store, { id: 'evt_2', type: 'payment.failed', userId: uid });
  assert.equal((await store.get(uid)).status, 'past_due');
  assert.equal(buildEntitlements(await store.get(uid), new Date('2026-11-14T03:00:00Z')).plan, 'free');

  await applySubscriptionEvent(store, {
    id: 'evt_3',
    type: 'subscription.canceled',
    userId: uid,
    currentPeriodEnd: '2026-12-14T00:00:00Z'
  });
  const canceled = await store.get(uid);
  assert.equal(canceled.status, 'canceled');
  assert.equal(buildEntitlements(canceled, new Date('2026-11-20T03:00:00Z')).pro, true);

  await assert.rejects(() => applySubscriptionEvent(store, { type: 'something.else', userId: uid }), (err) => err.code === 'invalid_billing_event');
  await assert.rejects(() => applySubscriptionEvent(store, { type: 'subscription.expired', userId: 'nobody' }), (err) => err.statusCode === 404);
});

// ── 헬스체크 ────────────────────────────────────────────
test('헬스체크: 로그인 게이트(401)와 헬스 API 응답을 장애로 오판하지 않는다', async () => {
  const health = CHECKS.find((c) => c.url.endsWith('/api/health'));
  assert.equal((await probe(health, async () => new Response('{"ok":true,"storage":"firestore"}', { status: 200 }))).ok, true);
  assert.equal((await probe(health, async () => new Response('{"ok":false,"storage":"unconfigured"}', { status: 200 }))).ok, false);
  assert.equal((await probe(health, async () => new Response('{}', { status: 200 }))).ok, false);

  const sample = CHECKS.find((c) => c.url.endsWith('/api/sample'));
  assert.equal(sample.expectStatus, 401);
  assert.equal((await probe(sample, async () => new Response('{"code":"auth_required"}', { status: 401 }))).ok, true);
  assert.equal((await probe(sample, async () => new Response('{"code":"invalid_json"}', { status: 200 }))).ok, false);

  const gardens = CHECKS.find((c) => c.url.endsWith('/api/secret-gardens'));
  assert.equal((await probe(gardens, async () => new Response('{"code":"auth_required"}', { status: 401 }))).ok, true);
  assert.equal((await probe(gardens, async () => new Response('{"code":"auth_required","gardens":[{"id":"1"}]}', { status: 401 }))).ok, false);
});

test('캐치올 경로: Vercel 함수 하나로 여러 경로를 처리해도 segments 가 정확하다', () => {
  // /api/auth/signup, /api/auth/me …
  assert.deepEqual(catchAllSegments(['signup']), ['signup']);
  assert.deepEqual(catchAllSegments('signup'), ['signup']);
  assert.deepEqual(catchAllSegments(undefined), []);
  assert.deepEqual(catchAllSegments(''), []);

  // /api/secret-gardens/{id} · /{id}/like · /verify
  assert.deepEqual(secretGardenSegments(['sg_1001']), ['sg_1001']);
  assert.deepEqual(secretGardenSegments('sg_1001'), ['sg_1001']);
  assert.deepEqual(secretGardenSegments(['sg_1001', 'like']), ['sg_1001', 'like']);
  assert.deepEqual(secretGardenSegments(['verify']), ['verify']);
  assert.deepEqual(secretGardenSegments([]), []);
});

