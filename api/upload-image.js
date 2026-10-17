import { randomBytes } from 'node:crypto';
import { getFirebaseStorageBucket } from '../lib/firebase-admin.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

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

export default async function handler(req, res) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    return errorResponse(res, 405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
  }

  const { imageBase64 } = parseBody(req);
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return errorResponse(res, 400, 'missing_image', '업로드할 이미지 데이터가 없습니다.');
  }
  if (imageBase64.startsWith('http://') || imageBase64.startsWith('https://')) {
    return res.status(200).json({ success: true, url: imageBase64 });
  }

  const match = imageBase64.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) {
    return errorResponse(res, 400, 'invalid_image', 'JPEG, PNG 또는 WebP 이미지 파일만 업로드할 수 있습니다.');
  }

  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    return errorResponse(res, 400, 'invalid_image', '이미지 데이터가 비어 있습니다.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return errorResponse(res, 413, 'image_too_large', '사진 크기가 너무 큽니다. 3MB 이하의 사진을 선택해주세요.');
  }

  try {
    const bucket = getFirebaseStorageBucket();
    const fileName = `secret-gardens/${Date.now()}_${randomBytes(8).toString('hex')}.${MIME_EXTENSIONS[mime]}`;
    const downloadToken = randomBytes(24).toString('hex');
    await bucket.file(fileName).save(buffer, {
      resumable: false,
      metadata: {
        contentType: mime,
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
