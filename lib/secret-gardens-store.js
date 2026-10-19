import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import seedGardens from '../data/secret_gardens.json' with { type: 'json' };
import { getFirestoreDatabase } from './firebase-admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GARDENS_FILE = path.join(__dirname, '..', 'data', 'secret_gardens.json');
const DEFAULT_COLLECTION = 'secretGardens';
const SEED_MARKER_ID = 'seed-v1';
let sharedStore = null;

function storageError(code, statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.code = code;
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

export function createFileSecretGardenStore(filePath = DEFAULT_GARDENS_FILE) {
  function read() {
    try {
      if (!fs.existsSync(filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(parsed)) {
        throw new Error('secret_gardens.json must contain an array');
      }
      return parsed;
    } catch (error) {
      console.error('[Secret gardens] Failed to read local store:', error?.message || error);
      throw storageError(
        'local_store_unavailable',
        500,
        '비밀의 정원 데이터를 읽지 못했습니다. 잠시 후 다시 시도해주세요.'
      );
    }
  }

  function write(gardens) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(gardens, null, 2), 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      console.error('[Secret gardens] Failed to write local store:', error?.message || error);
      throw storageError(
        'local_store_write_failed',
        500,
        '서버에서 비밀의 정원을 저장하지 못했습니다. 입력 내용은 유지되니 잠시 후 다시 시도해주세요.'
      );
    }
  }

  return {
    async list() {
      return read();
    },
    async get(id) {
      return read().find((garden) => garden.id === id) || null;
    },
    async insert(garden) {
      const gardens = read();
      if (gardens.some((existing) => existing.id === garden.id)) {
        throw storageError('garden_id_conflict', 409, '같은 식별자의 스팟이 이미 있습니다. 다시 시도해주세요.');
      }
      gardens.unshift(garden);
      write(gardens);
      return garden;
    },
    async update(id, updater) {
      const gardens = read();
      const index = gardens.findIndex((garden) => garden.id === id);
      if (index < 0) return null;
      const updated = updater(gardens[index]);
      gardens[index] = updated;
      write(gardens);
      return updated;
    },
    async remove(id, guard) {
      const gardens = read();
      const index = gardens.findIndex((garden) => garden.id === id);
      if (index < 0) return null;
      if (guard) guard(gardens[index]);
      const [removed] = gardens.splice(index, 1);
      write(gardens);
      return removed;
    }
  };
}

export function createFirestoreSecretGardenStore(db, collectionName = DEFAULT_COLLECTION) {
  const gardensCollection = db.collection(collectionName);
  const metadataRef = db.collection('_secretGardenMeta').doc(SEED_MARKER_ID);
  let seedPromise = null;

  async function ensureSeeded() {
    if (!seedPromise) {
      seedPromise = db.runTransaction(async (transaction) => {
        const marker = await transaction.get(metadataRef);
        if (marker.exists) return;

        const seedRefs = seedGardens.map((garden) => gardensCollection.doc(garden.id));
        const seedSnapshots = [];
        for (const ref of seedRefs) {
          seedSnapshots.push(await transaction.get(ref));
        }

        seedSnapshots.forEach((snapshot, index) => {
          // 초기 데이터의 옛 평문 비밀번호는 Firestore에 넣기 전에 해시로 바꾼다.
          if (!snapshot.exists) transaction.create(seedRefs[index], upgradeLegacyPassword(seedGardens[index]));
        });
        transaction.create(metadataRef, {
          version: 1,
          initializedAt: new Date().toISOString()
        });
      }).catch((error) => {
        seedPromise = null;
        throw error;
      });
    }
    return seedPromise;
  }

  return {
    async list() {
      await ensureSeeded();
      const snapshot = await gardensCollection.get();
      return snapshot.docs
        .map((doc) => doc.data())
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    },
    async get(id) {
      await ensureSeeded();
      const snapshot = await gardensCollection.doc(id).get();
      return snapshot.exists ? snapshot.data() : null;
    },
    async insert(garden) {
      await ensureSeeded();
      await gardensCollection.doc(garden.id).create(garden);
      return garden;
    },
    async update(id, updater) {
      await ensureSeeded();
      return db.runTransaction(async (transaction) => {
        const ref = gardensCollection.doc(id);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const updated = updater(snapshot.data());
        transaction.set(ref, updated);
        return updated;
      });
    },
    async remove(id, guard) {
      await ensureSeeded();
      return db.runTransaction(async (transaction) => {
        const ref = gardensCollection.doc(id);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) return null;
        const garden = snapshot.data();
        if (guard) guard(garden);
        transaction.delete(ref);
        return garden;
      });
    }
  };
}

function createUnavailableSecretGardenStore() {
  const unavailable = async () => {
    throw storageError(
      'storage_not_configured',
      503,
      '서버 저장소가 아직 설정되지 않았습니다. 운영자에게 Firebase Firestore 설정을 요청해주세요.'
    );
  };
  return { list: unavailable, get: unavailable, insert: unavailable, update: unavailable, remove: unavailable };
}

export function getSecretGardenStore() {
  if (sharedStore) return sharedStore;

  if (String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim()) {
    sharedStore = createFirestoreSecretGardenStore(getFirestoreDatabase());
    return sharedStore;
  }

  if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) {
    sharedStore = createUnavailableSecretGardenStore();
    return sharedStore;
  }

  sharedStore = createFileSecretGardenStore();
  return sharedStore;
}

export function resetSecretGardenStoreForTests() {
  sharedStore = null;
}
