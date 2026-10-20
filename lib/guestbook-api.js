import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDatabase, publicStorageErrorCode } from './firebase-admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POSTS_FILE = path.join(__dirname, '..', 'data', 'guestbook_posts.json');
const COLLECTION = 'guestbookPosts';
let sharedStore;
const createLimits = new Map();
const deleteLimits = new Map();

function httpError(status, code, message) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  error.publicMessage = message;
  return error;
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function normalizePost(post) {
  return {
    id: String(post.id || ''),
    nickname: String(post.nickname || '').slice(0, 16),
    message: String(post.message || '').slice(0, 300),
    createdAt: String(post.createdAt || new Date().toISOString()),
    passwordHash: String(post.passwordHash || '')
  };
}
function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { const value = JSON.parse(req.body); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  }
  if (req.body == null || req.body === '') return {};
  throw httpError(400, 'invalid_json', '요청 내용을 읽을 수 없습니다.');
}
function ipAddress(req) {
  return String(req?.headers?.['x-forwarded-for'] || req?.ip || req?.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
}
function checkRate(map, key, max, interval) {
  const now = Date.now();
  const recent = (map.get(key) || []).filter((time) => now - time < interval);
  if (recent.length >= max) throw httpError(429, 'rate_limited', '잠시 쉬었다가 다시 시도해주세요.');
  recent.push(now);
  map.set(key, recent);
  if (map.size > 5000) for (const [entry, times] of map) if (!times.some((time) => now - time < interval)) map.delete(entry);
}

export function createFileGuestbookStore(filePath = POSTS_FILE) {
  const read = () => {
    try {
      if (!fs.existsSync(filePath)) return [];
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(value)) throw new Error('Guestbook store must be an array');
      return value.map(normalizePost);
    } catch (error) {
      console.error('[Guestbook] read failed:', error?.message || error);
      throw httpError(500, 'storage_unavailable', '방명록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };
  const write = (posts) => {
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(posts, null, 2), 'utf8');
      fs.renameSync(temp, filePath);
    } catch (error) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      console.error('[Guestbook] write failed:', error?.message || error);
      throw httpError(500, 'storage_unavailable', '방명록을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };
  return {
    async list() { return read(); },
    async insert(post) { const posts = read(); posts.unshift(post); write(posts.slice(0, 500)); return post; },
    async remove(id) { const posts = read(); const index = posts.findIndex((post) => post.id === id); if (index < 0) return null; const [post] = posts.splice(index, 1); write(posts); return post; }
  };
}

export function createFirestoreGuestbookStore(db, collectionName = COLLECTION) {
  const collection = db.collection(collectionName);
  return {
    async list() {
      const snapshot = await collection.orderBy('createdAt', 'desc').limit(500).get();
      return snapshot.docs.map((doc) => normalizePost({ ...doc.data(), id: doc.id }));
    },
    async insert(post) { await collection.doc(post.id).create(post); return post; },
    async remove(id) { const ref = collection.doc(id); const snap = await ref.get(); if (!snap.exists) return null; const post = normalizePost({ ...snap.data(), id: snap.id }); await ref.delete(); return post; }
  };
}
function getStore() {
  if (sharedStore) return sharedStore;
  if (String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()) sharedStore = createFirestoreGuestbookStore(getFirestoreDatabase());
  else if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) {
    sharedStore = { async list() { throw httpError(503, 'storage_not_configured', '방명록 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase 설정을 요청해주세요.'); }, async insert() { return this.list(); }, async remove() { return this.list(); } };
  } else sharedStore = createFileGuestbookStore();
  return sharedStore;
}
function respond(res, status, payload) { return res.status(status).json(payload); }

export function createGuestbookApi(options = {}) {
  const store = options.store || { get: getStore };
  const resolveStore = () => typeof store.get === 'function' ? store.get() : store;
  return async function guestbookApi(req, res, pathParts = []) {
    try {
      const method = String(req?.method || 'GET').toUpperCase();
      const parts = Array.isArray(pathParts) ? pathParts : [];
      if (!parts.length && method === 'GET') {
        const posts = await resolveStore().list();
        return respond(res, 200, { success: true, posts: posts.map(({ passwordHash, ...post }) => post) });
      }
      if (!parts.length && method === 'POST') {
        checkRate(createLimits, ipAddress(req), 5, 10 * 60 * 1000);
        const body = parseBody(req);
        const nickname = String(body.nickname || '').trim();
        const message = String(body.message || '').trim();
        const password = String(body.password || '');
        if (!nickname || !message || !password) throw httpError(400, 'missing_fields', '닉네임, 한마디, 삭제 비밀번호를 모두 입력해주세요.');
        if (nickname.length > 16 || message.length > 300 || password.length < 4 || password.length > 64) throw httpError(400, 'invalid_length', '닉네임은 16자, 한마디는 300자 이내이며 비밀번호는 4자 이상이어야 합니다.');
        if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(nickname + message)) throw httpError(400, 'invalid_text', '특수 제어 문자는 입력할 수 없습니다.');
        const post = { id: `gb_${Date.now()}_${randomUUID().slice(0, 8)}`, nickname, message, createdAt: new Date().toISOString(), passwordHash: hashPassword(password) };
        const saved = await resolveStore().insert(post);
        const { passwordHash, ...publicPost } = saved;
        return respond(res, 201, { success: true, post: publicPost });
      }
      if (parts.length === 1 && method === 'DELETE') {
        const id = String(parts[0] || '').slice(0, 80);
        checkRate(deleteLimits, ipAddress(req), 12, 10 * 60 * 1000);
        const password = String(parseBody(req).password || '');
        if (!password) throw httpError(400, 'missing_password', '삭제 비밀번호를 입력해주세요.');
        const posts = await resolveStore().list();
        const post = posts.find((entry) => entry.id === id);
        if (!post) throw httpError(404, 'not_found', '이미 삭제되었거나 찾을 수 없는 글입니다.');
        if (!verifyPassword(password, post.passwordHash)) throw httpError(403, 'wrong_password', '비밀번호가 맞지 않습니다.');
        await resolveStore().remove(id);
        return respond(res, 200, { success: true });
      }
      res.setHeader?.('Allow', parts.length ? 'DELETE' : 'GET, POST');
      throw httpError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
    } catch (error) {
      const configCode = publicStorageErrorCode(error);
      const status = Number(error?.statusCode) || (configCode ? 503 : 500);
      const message = error?.publicMessage || (status >= 500 ? '방명록 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.' : error.message);
      if (status >= 500) console.error('[Guestbook API]', error?.code || configCode || 'server_error', error?.message || error);
      return respond(res, status, { success: false, code: error?.code || configCode || 'server_error', error: message });
    }
  };
}

export function resetGuestbookStoreForTests() { sharedStore = null; createLimits.clear(); deleteLimits.clear(); }
