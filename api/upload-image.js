import { randomBytes } from 'node:crypto';
import { getFirebaseStorageBucket } from '../lib/firebase-admin.js';
import { parseImageDataUrl } from '../lib/image-upload.js';
import { getUploadStore, uploadUrlFor, UPLOAD_KEY_PREFIX } from '../lib/upload-store.js';
import { withOptionalUser } from '../lib/auth/guard.js';

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function errorResponse(res, statusCode, code, error) {
  return res.status(statusCode).json({ success: false, code, error });
}

async function uploadImageHandler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    return errorResponse(res, 405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
  }

  let image;
  try {
    image = parseImageDataUrl(parseBody(req).imageBase64);
  } catch (error) {
    return errorResponse(res, error.statusCode || 400, error.code || 'invalid_image', error.publicMessage || error.message);
  }
  if (image.externalUrl) {
    return res.status(200).json({ success: true, url: image.externalUrl });
  }

  const fileName = `${UPLOAD_KEY_PREFIX}${Date.now()}_${randomBytes(8).toString('hex')}.${image.ext}`;

  // 1) Cloudflare R2(또는 KV) 바인딩이 있으면 그쪽에 저장한다 — 무료 한도로 동작하고,
  //    사진은 이 워커의 GET /api/uploads/<key> 로 내려간다.
  const store = getUploadStore();
  if (store) {
    try {
      await store.put(fileName, image.buffer, { contentType: image.mime });
      return res.status(200).json({ success: true, url: uploadUrlFor(fileName, req) });
    } catch (error) {
      const code = 'image_storage_unavailable';
      console.error('[Image Upload] Object storage failed:', error?.message || error);
      return errorResponse(res, 503, code, '사진 저장소에 저장하지 못했습니다. 잠시 후 다시 시도하거나 감성 프리셋 사진·이미지 URL을 사용해주세요.');
    }
  }

  // 2) 바인딩이 없는 실행(Express 로컬·Vercel)은 기존 Firebase Storage 경로를 그대로 쓴다.
  try {
    const bucket = getFirebaseStorageBucket();
    const downloadToken = randomBytes(24).toString('hex');
    await bucket.file(fileName).save(image.buffer, {
      resumable: false,
      metadata: {
        contentType: image.mime,
        cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: downloadToken }
      }
    });

    const encodedFileName = encodeURIComponent(fileName);
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedFileName}?alt=media&token=${downloadToken}`;
    return res.status(200).json({ success: true, url });
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 503;
    const code = error?.code || 'image_storage_unavailable';
    const message = error?.publicMessage || '사진 저장소에 연결하지 못했습니다. 감성 프리셋 사진이나 이미지 URL을 사용해주세요.';
    console.error('[Image Upload] Storage operation failed:', code, error?.message || error);
    return errorResponse(res, statusCode, code, message);
  }
}

// 사진 업로드는 게스트도 쓸 수 있다(형식·크기 검증은 lib/image-upload.js).
export default withOptionalUser(uploadImageHandler);
