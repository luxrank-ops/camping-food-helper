// 회원(사용자) 저장소.
//
// 저장 위치
//  - 운영(Vercel): Firestore `users/{uid}` 문서 (firebase-admin)
//  - 로컬(npm run dev): data/users.local.json 파일
//  - 저장소 미설정: 503 (방문자 카운터와 같은 규칙)
//
// uid 는 이메일에서 유도한 값(u + sha256 24자)이라 같은 이메일로 두 번 가입할 수 없고,
// 가입 조회에 Firestore 쿼리(색인)가 필요 없다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDatabase, publicStorageErrorCode } from '../firebase-admin.js';
import { kstDayKey, normalizeUsage } from '../plans.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_USERS_FILE = path.join(__dirname, '..', '..', 'data', 'users.local.json');
const DEFAULT_COLLECTION = 'users';
let sharedStore = null;

function storeError(code, statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function uidForEmail(email) {
  return `u${createHash('sha256').update(`camping-food-helper:user:${normalizeEmail(email)}`).digest('hex').slice(0, 24)}`;
}

/** Firestore에 넣을 수 없는 값(undefined)을 정리한다. */
function cleanForStore(record) {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    ...raw,
    uid: String(raw.uid || ''),
    email: String(raw.email || ''),
    emailLower: normalizeEmail(raw.emailLower || raw.email),
    nickname: String(raw.nickname || ''),
    plan: String(raw.plan || 'free'),
    status: String(raw.status || 'active'),
    role: String(raw.role || 'user'),
    usage: normalizeUsage(raw.usage, raw?.usage?.date || kstDayKey())
  };
}

export function createFirestoreUsersStore(db, collectionName = DEFAULT_COLLECTION) {
  const collection = db.collection(collectionName);

  return {
    kind: 'firestore',

    async create(record) {
      const ref = collection.doc(record.uid);
      try {
        await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          if (snapshot.exists) {
            throw storeError('email_taken', 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
          }
          transaction.set(ref, cleanForStore(record));
        });
      } catch (error) {
        if (error?.code === 'email_taken') throw error;
        const code = publicStorageErrorCode(error);
        if (code) throw storeError(code, 503, '회원 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
        throw error;
      }
      return normalizeRecord({ ...record, uid: record.uid });
    },

    async get(uid) {
      const snapshot = await collection.doc(String(uid)).get();
      if (!snapshot.exists) return null;
      return normalizeRecord({ ...snapshot.data(), uid: snapshot.id });
    },

    async update(uid, patch) {
      const ref = collection.doc(String(uid));
      await ref.set({ ...cleanForStore(patch), updatedAt: new Date().toISOString() }, { merge: true });
      return this.get(uid);
    },

    async incrementUsage(uid, field, dayKey = kstDayKey()) {
      const ref = collection.doc(String(uid));
      return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const usage = normalizeUsage(snapshot.data().usage, dayKey);
        usage[field] = Math.max(0, Number(usage[field]) || 0) + 1;
        usage.updatedAt = new Date().toISOString();
        transaction.set(ref, { usage, updatedAt: usage.updatedAt }, { merge: true });
        return usage;
      });
    },

    async remove(uid) {
      await collection.doc(String(uid)).delete();
    }
  };
}

export function createFileUsersStore(filePath = DEFAULT_USERS_FILE) {
  function readAll() {
    try {
      if (!fs.existsSync(filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed.users === 'object' && parsed.users ? parsed.users : {};
    } catch (error) {
      console.error('[Users] Failed to read local store:', error?.message || error);
      throw storeError('local_store_unavailable', 500, '회원 저장 파일을 읽지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  function writeAll(users) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify({ users }, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      console.error('[Users] Failed to write local store:', error?.message || error);
      throw storeError('local_store_write_failed', 500, '회원 정보를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  return {
    kind: 'file',

    async create(record) {
      const users = readAll();
      if (users[record.uid]) throw storeError('email_taken', 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
      users[record.uid] = cleanForStore(record);
      writeAll(users);
      return normalizeRecord(users[record.uid]);
    },

    async get(uid) {
      const users = readAll();
      return users[uid] ? normalizeRecord(users[uid]) : null;
    },

    async update(uid, patch) {
      const users = readAll();
      if (!users[uid]) return null;
      users[uid] = { ...users[uid], ...cleanForStore(patch), updatedAt: new Date().toISOString() };
      writeAll(users);
      return normalizeRecord(users[uid]);
    },

    async incrementUsage(uid, field, dayKey = kstDayKey()) {
      const users = readAll();
      if (!users[uid]) return null;
      const usage = normalizeUsage(users[uid].usage, dayKey);
      usage[field] = Math.max(0, Number(usage[field]) || 0) + 1;
      usage.updatedAt = new Date().toISOString();
      users[uid].usage = usage;
      writeAll(users);
      return usage;
    },

    async remove(uid) {
      const users = readAll();
      if (users[uid]) {
        delete users[uid];
        writeAll(users);
      }
    }
  };
}

/** 테스트용 인메모리 저장소. */
export function createMemoryUsersStore(initial = {}) {
  const users = { ...initial };
  return {
    kind: 'memory',
    _users: users,
    async create(record) {
      if (users[record.uid]) throw storeError('email_taken', 409, '이미 가입된 이메일입니다. 로그인해 주세요.');
      users[record.uid] = cleanForStore(record);
      return normalizeRecord(users[record.uid]);
    },
    async get(uid) {
      return users[uid] ? normalizeRecord(users[uid]) : null;
    },
    async update(uid, patch) {
      if (!users[uid]) return null;
      users[uid] = { ...users[uid], ...cleanForStore(patch), updatedAt: new Date().toISOString() };
      return normalizeRecord(users[uid]);
    },
    async incrementUsage(uid, field, dayKey = kstDayKey()) {
      if (!users[uid]) return null;
      const usage = normalizeUsage(users[uid].usage, dayKey);
      usage[field] = Math.max(0, Number(usage[field]) || 0) + 1;
      users[uid].usage = usage;
      return usage;
    },
    async remove(uid) {
      delete users[uid];
    }
  };
}

function createUnavailableUsersStore() {
  const unavailable = async () => {
    throw storeError(
      'storage_not_configured',
      503,
      '회원 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase Firestore 설정을 요청해주세요.'
    );
  };
  return { kind: 'unavailable', create: unavailable, get: unavailable, update: unavailable, incrementUsage: unavailable, remove: unavailable };
}

export function getUsersStore() {
  if (sharedStore) return sharedStore;

  if (String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()) {
    sharedStore = createFirestoreUsersStore(getFirestoreDatabase());
    return sharedStore;
  }

  // Vercel 서버리스 파일 시스템은 요청이 끝나면 사라지므로 파일 저장을 쓰지 않는다.
  if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) {
    sharedStore = createUnavailableUsersStore();
    return sharedStore;
  }

  sharedStore = createFileUsersStore();
  return sharedStore;
}

export function resetUsersStoreForTests() {
  sharedStore = null;
}
