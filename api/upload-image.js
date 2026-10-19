import { randomBytes } from 'node:crypto';
import { getFirebaseStorageBucket } from '../lib/firebase-admin.js';
import { parseImageDataUrl } from '../lib/image-upload.js';

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

  let image;
  try {
    image = parseImageDataUrl(parseBody(req).imageBase64);
  } catch (error) {
    return errorResponse(res, error.statusCode || 400, error.code || 'invalid_image', error.publicMessage || error.message);
  }
  if (image.externalUrl) {
    return res.status(200).json({ success: true, url: image.externalUrl });
  }

  try {
    const bucket = getFirebaseStorageBucket();
    const fileName = `secret-gardens/${Date.now()}_${randomBytes(8).toString('hex')}.${image.ext}`;
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
