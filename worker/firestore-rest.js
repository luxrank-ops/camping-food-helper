// Firestore REST(v1) 클라이언트 — firebase-admin 대체 (Cloudflare Workers 용).
//
// 앱 코드(lib/*-store.js)는 firebase-admin 의 Firestore 객체를 다음 API 만 쓴다.
//   db.collection(name).doc(id).get() / .set(data, {merge}) / .create(data) / .delete()
//   db.collection(name).get()                    (전체 목록)
//   db.collection(name).orderBy(f, 'desc').limit(n).get()
//   db.runTransaction(async (tx) => { tx.get / tx.set / tx.create / tx.delete })
// 이 파일은 같은 모양을 REST + OAuth2(서비스 계정 JWT)로 구현한다.
//
// 값을 주고받는 형식은 Firestore 의 Value 표현(stringValue·integerValue·mapValue…)을 그대로 쓴다.
// 앱이 저장하는 값은 문자열·숫자·불리언·null·배열·객체뿐이라 그 범위만 정확히 다룬다.

import { getAccessToken } from './google-auth.js';

const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const DEFAULT_PAGE_SIZE = 300;
const MAX_TRANSACTION_ATTEMPTS = 5;

function documentsBase(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function documentName(projectId, path) {
  return `projects/${projectId}/databases/(default)/documents/${path}`;
}

/** 문서 전체 이름에서 컬렉션 상대 경로만 뽑는다. */
function relativePath(name) {
  const marker = '/documents/';
  const index = String(name || '').indexOf(marker);
  return index >= 0 ? String(name).slice(index + marker.length) : String(name || '');
}

export function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { nullValue: null };
    if (Number.isInteger(value) && Math.abs(value) < 2 ** 53) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'bigint') return { integerValue: value.toString() };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  return { nullValue: null };
}

export function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    fields[key] = encodeValue(value);
  }
  return fields;
}

export function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return !!value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return new Date(value.timestampValue).toISOString();
  if ('arrayValue' in value) return (value.arrayValue?.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue?.fields || {});
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return { ...value.geoPointValue };
  if ('bytesValue' in value) return value.bytesValue;
  return null;
}

export function decodeFields(fields) {
  const data = {};
  for (const [key, value] of Object.entries(fields || {})) data[key] = decodeValue(value);
  return data;
}

function restError(response, body) {
  const status = response.status;
  const remoteCode = String(body?.error?.status || '').toUpperCase();
  const message = String(body?.error?.message || `firestore request failed (${status})`);
  const error = new Error(message);
  error.code = remoteCode || `http_${status}`;
  error.status = status;
  error.remoteCode = remoteCode;
  if (remoteCode === 'UNAUTHENTICATED' || remoteCode === 'PERMISSION_DENIED') {
    // lib/firebase-admin.js 의 publicStorageErrorCode() 가 이 낱말들을 설정 오류로 분류한다.
    error.message = `${remoteCode}: ${message}`;
  }
  return error;
}

function isRetryable(error) {
  const code = String(error?.remoteCode || error?.code || '').toUpperCase();
  if (code === 'ABORTED' || code === 'UNAVAILABLE' || code === 'DEADLINE_EXCEEDED') return true;
  if (Number(error?.status) === 503 || Number(error?.status) === 429) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Firestore REST 클라이언트를 만든다.
 * @param {{projectId: string, clientEmail: string, privateKey: string}} credentials
 */
export function createRestFirestore(credentials, options = {}) {
  const { projectId } = credentials;
  if (!projectId) {
    const error = new Error('Firebase 프로젝트 ID가 설정되지 않았습니다.');
    error.code = 'firebase_project_not_configured';
    throw error;
  }
  const base = documentsBase(projectId);
  const fetchImpl = options.fetch || ((...args) => fetch(...args));

  async function authHeaders(extra = {}) {
    const token = await getAccessToken(credentials, FIRESTORE_SCOPE);
    return { authorization: `Bearer ${token}`, ...extra };
  }

  async function request(url, init = {}) {
    const headers = await authHeaders(init.headers || {});
    const response = await fetchImpl(url, { ...init, headers });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) throw restError(response, body);
    return body || {};
  }

  function snapshotFromDocument(document, collectionPath) {
    const path = relativePath(document?.name);
    const segments = path.split('/');
    const id = segments[segments.length - 1] || '';
    const data = decodeFields(document?.fields || {});
    return {
      id,
      exists: true,
      ref: documentRef(collectionPath, id),
      data: () => ({ ...data }),
      get: (field) => data[field]
    };
  }

  function missingSnapshot(collectionPath, id) {
    return {
      id,
      exists: false,
      ref: documentRef(collectionPath, id),
      data: () => undefined,
      get: () => undefined
    };
  }

  function writeFor(ref, data, { merge = false, exists = null } = {}) {
    const write = {
      update: {
        name: documentName(projectId, ref.path),
        fields: encodeFields(data || {})
      }
    };
    if (merge) write.updateMask = { fieldPaths: Object.keys(data || {}).filter((key) => data[key] !== undefined) };
    if (exists === false) write.currentDocument = { exists: false };
    if (exists === true) write.currentDocument = { exists: true };
    return write;
  }

  async function commit(writes, transactionId) {
    if (!writes.length) return {};
    const body = { writes };
    if (transactionId) body.transaction = transactionId;
    return request(`${base}:commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function documentRef(collectionPath, id) {
    const path = `${collectionPath}/${id}`;

    async function fetchDocument(transactionId) {
      const search = new URLSearchParams();
      if (transactionId) search.set('transaction', transactionId);
      const query = search.toString() ? `?${search}` : '';
      try {
        const body = await request(`${base}/${encodePath(path)}${query}`, { method: 'GET' });
        return snapshotFromDocument(body, collectionPath);
      } catch (error) {
        if (Number(error?.status) === 404) return missingSnapshot(collectionPath, id);
        throw error;
      }
    }

    const ref = {
      id,
      path,
      collectionPath,

      async get() {
        return fetchDocument(null);
      },

      async set(data, opts = {}) {
        await commit([writeFor(ref, data, { merge: !!opts.merge })]);
        return undefined;
      },

      async create(data) {
        await commit([writeFor(ref, data, { exists: false })]);
        return undefined;
      },

      async update(data) {
        await commit([writeFor(ref, data, { merge: true })]);
        return undefined;
      },

      async delete() {
        await commit([{ delete: documentName(projectId, path) }]);
        return undefined;
      },

      /** 트랜잭션 내부용 (외부에서 쓰지 않는다) */
      _get: (transactionId) => fetchDocument(transactionId)
    };

    return ref;
  }

  function collectionRef(collectionPath, queryOptions = {}) {
    const ref = {
      path: collectionPath,
      doc: (id) => documentRef(collectionPath, String(id)),

      orderBy(field, direction = 'asc') {
        return collectionRef(collectionPath, { ...queryOptions, orderBy: `${field} ${direction}` });
      },

      limit(count) {
        return collectionRef(collectionPath, { ...queryOptions, limit: Number(count) || 0 });
      },

      where() {
        throw new Error('Firestore REST shim: where() is not implemented');
      },

      async get() {
        const pageSize = queryOptions.limit
          ? Math.min(queryOptions.limit, DEFAULT_PAGE_SIZE)
          : DEFAULT_PAGE_SIZE;
        const docs = [];
        let pageToken = '';
        for (let page = 0; page < 200; page += 1) {
          const search = new URLSearchParams({ pageSize: String(pageSize) });
          if (queryOptions.orderBy) search.set('orderBy', queryOptions.orderBy);
          if (pageToken) search.set('pageToken', pageToken);
          const body = await request(`${base}/${encodePath(collectionPath)}?${search}`);
          for (const document of body.documents || []) {
            docs.push(snapshotFromDocument(document, collectionPath));
            if (queryOptions.limit && docs.length >= queryOptions.limit) break;
          }
          pageToken = body.nextPageToken || '';
          if (!pageToken) break;
          if (queryOptions.limit && docs.length >= queryOptions.limit) break;
        }
        return {
          docs,
          size: docs.length,
          empty: docs.length === 0,
          forEach: (callback) => docs.forEach(callback)
        };
      }
    };
    return ref;
  }

  /** 낙관적 트랜잭션: 읽기는 트랜잭션 id 로, 쓰기는 commit 에 모아 한 번에 반영한다. */
  async function runTransaction(callback) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      const begun = await request(`${base}:beginTransaction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ options: { readWrite: {} } })
      });
      const transactionId = begun.transaction;
      const writes = [];
      let result;
      let failure = null;

      const transaction = {
        async get(ref) {
          if (!ref || typeof ref._get !== 'function') throw new Error('transaction.get: invalid document reference');
          return ref._get(transactionId);
        },
        set(ref, data, opts = {}) {
          writes.push(writeFor(ref, data, { merge: !!opts.merge }));
          return transaction;
        },
        create(ref, data) {
          writes.push(writeFor(ref, data));
          return transaction;
        },
        delete(ref) {
          writes.push({ delete: documentName(projectId, ref.path) });
          return transaction;
        }
      };

      try {
        result = await callback(transaction);
      } catch (error) {
        failure = error;
      }

      if (failure) {
        try {
          await request(`${base}:rollback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ transaction: transactionId })
          });
        } catch { /* rollback 실패는 원래 오류를 가리지 않는다 */ }
        if (!isRetryable(failure)) throw failure;
        lastError = failure;
        await sleep(120 * (attempt + 1));
        continue;
      }

      try {
        const committed = await commit(writes, transactionId);
        if (result && typeof result === 'object' && committed?.commitTime && !result.commitTime) {
          result = { ...result, commitTime: committed.commitTime };
        }
        return result;
      } catch (error) {
        if (!isRetryable(error)) throw error;
        lastError = error;
        await sleep(120 * (attempt + 1));
      }
    }
    throw lastError || new Error('firestore transaction failed');
  }

  return {
    projectId,
    collection: (name) => collectionRef(String(name)),
    runTransaction,
    doc: (path) => {
      const segments = String(path).split('/').filter(Boolean);
      const id = segments.pop();
      return documentRef(segments.join('/'), id);
    }
  };
}

function encodePath(path) {
  return String(path).split('/').map((part) => encodeURIComponent(part)).join('/');
}
