import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuestbookApi } from '../lib/guestbook-api.js';

function response() {
  return { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; }, setHeader() {} };
}
function memoryStore() {
  const posts = [];
  return {
    posts,
    async list() { return posts.slice(); },
    async insert(post) { posts.unshift(post); return post; },
    async remove(id) { const index = posts.findIndex((post) => post.id === id); return index < 0 ? null : posts.splice(index, 1)[0]; }
  };
}

test('guestbook creates public posts without exposing the deletion password hash', async () => {
  const store = memoryStore();
  const api = createGuestbookApi({ store });
  const res = response();
  await api({ method: 'POST', ip: 'test-create-a', body: { nickname: '솔캠러', message: '별이 정말 많았어요 ✨', password: 'camp1234' } }, res, []);
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.post.nickname, '솔캠러');
  assert.equal(res.payload.post.message, '별이 정말 많았어요 ✨');
  assert.equal('passwordHash' in res.payload.post, false);
  assert.match(store.posts[0].passwordHash, /^[a-f0-9]+:[a-f0-9]+$/);
});

test('guestbook validates required fields and message limits', async () => {
  const api = createGuestbookApi({ store: memoryStore() });
  const missing = response();
  await api({ method: 'POST', ip: 'test-create-b', body: { nickname: '캠퍼' } }, missing, []);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.payload.code, 'missing_fields');
  const tooLong = response();
  await api({ method: 'POST', ip: 'test-create-c', body: { nickname: '캠퍼', message: 'x'.repeat(301), password: '1234' } }, tooLong, []);
  assert.equal(tooLong.statusCode, 400);
});

test('guestbook requires the author password to delete a post', async () => {
  const store = memoryStore();
  const api = createGuestbookApi({ store });
  const created = response();
  await api({ method: 'POST', ip: 'test-create-d', body: { nickname: '바람', message: '다음에도 또 올게요', password: 'secret4' } }, created, []);
  const id = created.payload.post.id;
  const wrong = response();
  await api({ method: 'DELETE', ip: 'test-delete-a', body: { password: 'wrong' } }, wrong, [id]);
  assert.equal(wrong.statusCode, 403);
  assert.equal(store.posts.length, 1);
  const correct = response();
  await api({ method: 'DELETE', ip: 'test-delete-b', body: { password: 'secret4' } }, correct, [id]);
  assert.equal(correct.statusCode, 200);
  assert.equal(store.posts.length, 0);
});
