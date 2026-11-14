import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, probe, checkWithRetry, failureAnnotation, statusReason } from './uptime-check.mjs';

const check = { name: 'test', method: 'GET', url: 'https://example.test/', expectStatus: 200 };
const response = (status, body = '') => new Response(body, { status });

test('expected status passes; unexpected status and network failures fail', async () => {
  assert.equal((await probe(check, async () => response(200))).ok, true);
  assert.match((await probe(check, async () => response(503))).reason, /HTTP 503/);
  assert.equal((await probe(check, async () => { throw new Error('offline'); })).ok, false);
});

test('only failed checks retry, retaining the first failure', async () => {
  let calls = 0;
  const delays = [];
  const result = await checkWithRetry(check, async () => response(++calls === 1 ? 503 : 200), async (ms) => delays.push(ms));
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.match(result.firstReason, /503/);
  assert.equal(delays.length, 1);
  await checkWithRetry(check, async () => response(200), async () => assert.fail('must not sleep'));
});

test('health check is public, read-only and validates the storage state, not just HTTP 200', async () => {
  const health = CHECKS.find((c) => c.url.endsWith('/api/health'));
  assert.equal(health.method, 'GET');
  for (const body of ['<html>fallback</html>', '{}', '{"ok":false,"storage":"unconfigured"}']) {
    assert.equal((await probe(health, async () => response(200, body))).ok, false);
  }
  assert.equal((await probe(health, async () => response(200, '{"ok":true,"storage":"firestore"}'))).ok, true);
});

test('guest POST checks still send an empty body so no paid AI call is made', async () => {
  for (const entry of CHECKS.filter((c) => c.method === 'POST')) {
    assert.equal(entry.expectStatus, 400, `${entry.name}: 게스트도 호출할 수 있고 빈 요청은 400`);
    await probe(entry, async (_url, init) => {
      assert.equal(init.body, '{}');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.equal(init.headers.Authorization, undefined, '헬스체크는 토큰을 보내지 않는다');
      return response(400, '{"code":"invalid_json"}');
    });
  }
});

test('member API guard is checked without a token (401 auth_required)', async () => {
  const me = CHECKS.find((c) => c.url.endsWith('/api/auth/me'));
  assert.equal(me.method, 'GET');
  assert.equal((await probe(me, async () => response(401, '{"code":"auth_required"}'))).ok, true);
  assert.equal((await probe(me, async () => response(200, '{"success":true}'))).ok, false);
  assert.equal((await probe(me, async () => response(401, '{"code":"invalid_token"}'))).ok, false);
});

test('failure annotations escape workflow command control characters', () => {
  const line = failureAnnotation({ name: 'target', reason: 'bad%\r\n::warning::injection', elapsedMs: 10, retried: true, firstReason: 'HTTP 500' });
  assert.ok(line.startsWith('::error::target: '));
  assert.ok(line.includes('bad%25%0D%0A::warning::injection'));
  assert.ok(line.includes('HTTP 500'));
  assert.equal(line.split('\n').length, 1);
});

test('only allowlisted public configuration codes appear in HTTP diagnostics', () => {
  assert.match(statusReason(503, 200, '{"code":"storage_not_configured","error":"PRIVATE"}'), /FIREBASE_SERVICE_ACCOUNT/);
  assert.equal(statusReason(503, 200, '{"code":"unknown","error":"PRIVATE"}'), 'HTTP 503 (기대값 200)');
  assert.equal(statusReason(503, 200, '<html>PRIVATE</html>'), 'HTTP 503 (기대값 200)');
  assert.equal(statusReason(503, 200, '{"code":"__proto__"}'), 'HTTP 503 (기대값 200)');
});
