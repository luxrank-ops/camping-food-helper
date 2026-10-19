// 사진 업로드 입력 검증 공용 유틸 (Vercel api/upload-image.js와 Express server.js가 함께 씀).
//
// 선언된 MIME만 믿지 않고 파일 앞부분의 시그니처(매직 바이트)까지 확인한다.
// SVG/HTML 같은 스크립트성 포맷은 아예 받지 않는다.

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i;

function uploadError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.publicMessage = message;
  return error;
}

function hasSignature(buffer, mime) {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return buffer.length >= 8
      && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
      && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

/**
 * data URL 문자열을 검증해 { mime, ext, buffer }로 바꾼다.
 * 이미 http(s) URL인 값은 { externalUrl }로 돌려준다(서버가 대신 가져오지 않는다).
 * @throws {Error} statusCode/code/publicMessage를 가진 검증 오류
 */
export function parseImageDataUrl(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw uploadError(400, 'missing_image', '업로드할 이미지 데이터가 없습니다.');
  }
  if (/^https?:\/\//i.test(imageBase64)) {
    if (imageBase64.length > 2048) {
      throw uploadError(400, 'invalid_image', '이미지 URL이 너무 깁니다.');
    }
    return { externalUrl: imageBase64 };
  }

  const match = imageBase64.match(DATA_URL_PATTERN);
  if (!match) {
    throw uploadError(400, 'invalid_image', 'JPEG, PNG 또는 WebP 이미지 파일만 업로드할 수 있습니다.');
  }

  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) {
    throw uploadError(400, 'invalid_image', '이미지 데이터가 비어 있습니다.');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw uploadError(413, 'image_too_large', '사진 크기가 너무 큽니다. 3MB 이하의 사진을 선택해주세요.');
  }
  if (!hasSignature(buffer, mime)) {
    throw uploadError(400, 'invalid_image', '이미지 파일 형식이 올바르지 않습니다.');
  }
  return { mime, ext: MIME_EXTENSIONS[mime], buffer };
}
