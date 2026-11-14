// 'firebase-admin/storage' 대체 구현 (Cloudflare Workers).
//
// api/upload-image.js 는 getFirebaseStorageBucket().file(name).save(buffer, {metadata}) 만 쓴다.
// firebase-admin 의 Storage 는 Node 전용이라, Google Cloud Storage JSON API 에
// multipart 업로드로 직접 올린다. Firebase 다운로드 토큰도 그대로 메타데이터에 넣기 때문에
// 기존과 같은 firebasestorage.googleapis.com URL 로 접근할 수 있다.

import { getAccessToken } from '../google-auth.js';

const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const UPLOAD_BASE = 'https://storage.googleapis.com/upload/storage/v1/b';

function storageError(status, body) {
  const remoteCode = String(body?.error?.status || '').toUpperCase();
  const message = String(body?.error?.message || `storage request failed (${status})`);
  const error = new Error(remoteCode ? `${remoteCode}: ${message}` : message);
  error.code = remoteCode || String(status);
  error.status = status;
  return error;
}

function storageBucket(credentials, bucketName) {
  if (!bucketName) {
    const error = new Error('Firebase Storage 버킷이 설정되지 않았습니다.');
    error.code = 'storage_bucket_not_configured';
    error.statusCode = 503;
    error.publicMessage = '사진 저장소가 설정되지 않았습니다. 사진은 감성 프리셋 또는 이미지 URL을 사용해주세요.';
    throw error;
  }

  async function uploadMultipart(name, bytes, contentType, metadata) {
    const token = await getAccessToken(credentials, STORAGE_SCOPE);
    const boundary = `cfh_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const metadataJson = JSON.stringify({
      name,
      contentType: contentType || 'application/octet-stream',
      ...(metadata || {})
    });

    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n` +
      `--${boundary}\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`
    );
    const tail = encoder.encode(`\r\n--${boundary}--`);

    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const url = `${UPLOAD_BASE}/${encodeURIComponent(bucketName)}/o?uploadType=multipart&name=${encodeURIComponent(name)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`
      },
      body
    });

    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) throw storageError(response.status, parsed);
    return parsed;
  }

  return {
    name: bucketName,
    file(key) {
      return {
        name: key,
        async save(data, options = {}) {
          const bytes = data instanceof Uint8Array
            ? data
            : new Uint8Array(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
          const metadata = options?.metadata || {};
          await uploadMultipart(
            key,
            bytes,
            metadata.contentType || 'application/octet-stream',
            {
              cacheControl: metadata.cacheControl,
              metadata: metadata.metadata
            }
          );
          return undefined;
        }
      };
    }
  };
}

export function getStorage(app) {
  const options = app?.options || {};
  const credential = options.credential || {};
  return {
    bucket(name) {
      return storageBucket(
        {
          projectId: credential.projectId || options.projectId || '',
          clientEmail: credential.clientEmail || '',
          privateKey: credential.privateKey || ''
        },
        String(name || options.storageBucket || '').trim()
      );
    }
  };
}
