import { randomUUID } from 'node:crypto';
import { getSecretGardenStore } from './secret-gardens-store.js';
import {
  hashPassword,
  isMasterKey,
  stripCredentials,
  upgradeLegacyPassword,
  verifyGardenPassword
} from './garden-password.js';

// 비밀의 정원 API (Express 로컬 서버와 Vercel 서버리스 함수가 같은 로직을 쓴다)
//
// 보안 원칙
//  - 마스터 키는 코드에 하드코딩하지 않는다. 환경변수 MASTER_KEY가 없으면 마스터 인증은 비활성화된다.
//  - 마스터 키는 쿼리스트링(URL 로그/히스토리에 남음)으로 받지 않고 x-master-key 헤더로만 받는다.
//  - 비밀번호는 scrypt 해시로만 저장한다. 어떤 응답에도 비밀번호/해시를 포함하지 않는다.
//  - 비밀번호 확인은 아이피+스팟 단위로 실패 횟수를 제한한다(인메모리 베스트 에포트).

const DEFAULT_PHOTO_URL = 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=800&q=80';
const MIN_PASSWORD_LENGTH = 4;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = {
  create: { max: 10, windowMs: 10 * 60 * 1000 },
  like: { max: 30, windowMs: 60 * 1000 }
};
const MAX_TRACKED_KEYS = 5000;

const FIELD_LIMITS = {
  category: 20,
  address: 120,
  addressDetail: 300,
  navQuery: 80,
  groundType: 40,
  fee: 40,
  toiletStatus: 60,
  entryRoad: 120,
  tips: 500,
  photoUrl: 2048
};

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.publicMessage = message;
  return error;
}

function parseBody(req) {
  if (req.body == null || req.body === '') return {};
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      throw httpError(400, 'invalid_json', '요청 내용을 읽을 수 없습니다. 입력 내용을 확인해주세요.');
    }
  }
  if (typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw httpError(400, 'invalid_json', '요청 내용이 올바르지 않습니다.');
  }
  return req.body;
}

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const ip = forwarded
    || String(req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '');
  return ip ? ip.slice(0, 64) : 'unknown';
}

function limitedString(value, field, fallback = '') {
  const text = value == null ? fallback : String(value).trim();
  const limit = FIELD_LIMITS[field];
  if (limit && text.length > limit) {
    throw httpError(400, 'invalid_field_length', '입력한 내용 중 허용 길이를 초과한 항목이 있습니다.');
  }
  return text;
}

function parseCoordinate(value, min, max) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw httpError(400, 'invalid_coordinates', '위도/경도가 올바른 범위가 아닙니다.');
  }
  return number;
}

function finiteCoordinate(value) {
  // 하위 호환용: 위도/경도 구분이 없는 호출은 경도 범위로 검증한다.
  return parseCoordinate(value, -180, 180);
}

function isPrivateValue(value) {
  return value === false || value === 0 || value === 'false' || value === '0' ? false : !!value;
}

function resolveMasterKey() {
  return String(process.env.MASTER_KEY || '').trim();
}

function normalizeFacilities(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 30);
}

function validatePhotoUrl(photoUrl) {
  if (!photoUrl) return photoUrl;
  if (/^data:/i.test(photoUrl)) {
    throw httpError(400, 'photo_not_uploaded', '사진 업로드가 끝난 뒤 다시 시도해주세요. 업로드에 실패했다면 프리셋 사진이나 이미지 URL을 선택해주세요.');
  }
  if (!/^https?:\/\//i.test(photoUrl)) {
    throw httpError(400, 'invalid_photo_url', '사진은 http(s) 이미지 URL이거나 업로드한 사진만 사용할 수 있습니다.');
  }
  return photoUrl;
}

export function sanitizePublicSecretGardens(gardens) {
  return (Array.isArray(gardens) ? gardens : []).map((garden) => {
    if (!garden.isPrivate) {
      return stripCredentials(garden);
    }

    const regionShort = garden.address
      ? garden.address.split(' ').slice(0, 2).join(' ') + ' *** (비밀 노지)'
      : '비공개 위치';
    return {
      id: garden.id,
      name: garden.name,
      category: garden.category,
      isPrivate: true,
      author: garden.author,
      createdAt: garden.createdAt,
      fee: garden.fee,
      photoUrl: garden.photoUrl,
      addressMasked: regionShort,
      facilitiesCount: Array.isArray(garden.facilities) ? garden.facilities.length : 0,
      toiletStatus: garden.toiletStatus
        ? (garden.toiletStatus.includes('없음') ? '화장실 없음' : '화장실 있음')
        : '비공개',
      views: garden.views || 0,
      likes: garden.likes || 0
    };
  });
}

function respond(res, statusCode, payload) {
  return res.status(statusCode).json(payload);
}

function authorized(password, garden, masterKey) {
  return isMasterKey(password, masterKey) || verifyGardenPassword(password, garden);
}

function createNewGarden(body, now = new Date()) {
  const name = String(body.name || '').trim();
  const author = String(body.author || '').trim();
  const password = String(body.password || '').trim();

  if (!name || !author || !password) {
    throw httpError(400, 'missing_required_fields', '스팟 이름, 작성자 닉네임, 비밀번호는 필수입니다.');
  }
  if (name.length > 40 || author.length > 15 || password.length > 20) {
    throw httpError(400, 'invalid_field_length', '스팟 이름, 닉네임 또는 비밀번호가 허용 길이를 초과했습니다.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, 'password_too_short', `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 입력해주세요.`);
  }

  const photoUrl = validatePhotoUrl(limitedString(body.photoUrl, 'photoUrl'));

  return {
    id: `sg_${now.getTime()}_${randomUUID().slice(0, 8)}`,
    name,
    category: limitedString(body.category, 'category', 'noji') || 'noji',
    address: limitedString(body.address, 'address'),
    addressDetail: limitedString(body.addressDetail, 'addressDetail'),
    lat: parseCoordinate(body.lat, -90, 90),
    lng: parseCoordinate(body.lng, -180, 180),
    navQuery: limitedString(body.navQuery, 'navQuery', name),
    facilities: normalizeFacilities(body.facilities, []),
    groundType: limitedString(body.groundType, 'groundType', '자갈/흙'),
    fee: limitedString(body.fee, 'fee', '무료'),
    toiletStatus: limitedString(body.toiletStatus, 'toiletStatus', '정보 없음'),
    entryRoad: limitedString(body.entryRoad, 'entryRoad', '승용차 진입 가능'),
    photoUrl: photoUrl || DEFAULT_PHOTO_URL,
    tips: limitedString(body.tips, 'tips'),
    author,
    passwordHash: hashPassword(password),
    isPrivate: isPrivateValue(body.isPrivate),
    createdAt: now.toISOString(),
    views: 1,
    likes: 0
  };
}

function updateGarden(current, body) {
  const newPassword = body.newPassword ? String(body.newPassword).trim() : '';
  if (newPassword && newPassword.length < MIN_PASSWORD_LENGTH) {
    throw httpError(400, 'password_too_short', `새 비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 입력해주세요.`);
  }
  if (newPassword && newPassword.length > 20) {
    throw httpError(400, 'invalid_field_length', '새 비밀번호가 허용 길이를 초과했습니다.');
  }

  const photoUrl = body.photoUrl !== undefined
    ? validatePhotoUrl(limitedString(body.photoUrl, 'photoUrl'))
    : current.photoUrl;

  const updated = {
    ...current,
    name: body.name !== undefined ? String(body.name).trim().slice(0, 40) : current.name,
    category: body.category !== undefined ? limitedString(body.category, 'category') : current.category,
    address: body.address !== undefined ? limitedString(body.address, 'address') : current.address,
    addressDetail: body.addressDetail !== undefined ? limitedString(body.addressDetail, 'addressDetail') : current.addressDetail,
    lat: body.lat !== undefined ? parseCoordinate(body.lat, -90, 90) : current.lat,
    lng: body.lng !== undefined ? parseCoordinate(body.lng, -180, 180) : current.lng,
    navQuery: body.navQuery !== undefined ? limitedString(body.navQuery, 'navQuery') : current.navQuery,
    facilities: normalizeFacilities(body.facilities, current.facilities),
    groundType: body.groundType !== undefined ? limitedString(body.groundType, 'groundType') : current.groundType,
    fee: body.fee !== undefined ? limitedString(body.fee, 'fee') : current.fee,
    toiletStatus: body.toiletStatus !== undefined ? limitedString(body.toiletStatus, 'toiletStatus') : current.toiletStatus,
    entryRoad: body.entryRoad !== undefined ? limitedString(body.entryRoad, 'entryRoad') : current.entryRoad,
    photoUrl,
    tips: body.tips !== undefined ? limitedString(body.tips, 'tips') : current.tips,
    isPrivate: body.isPrivate !== undefined ? isPrivateValue(body.isPrivate) : current.isPrivate
  };

  // 수정이 저장될 때 옛 평문 비밀번호는 해시로 교체한다(점진적 마이그레이션).
  delete updated.password;
  if (newPassword) {
    updated.passwordHash = hashPassword(newPassword);
  } else if (!updated.passwordHash && typeof current.password === 'string' && current.password) {
    updated.passwordHash = hashPassword(current.password);
  }
  return updated;
}

export function createSecretGardensApi(options = {}) {
  const store = options.store || null;
  const getStore = options.getStore || (() => store || getSecretGardenStore());
  const masterKey = options.masterKey == null ? resolveMasterKey() : String(options.masterKey);
  const clock = options.clock || (() => new Date());
  const now = options.now || (() => Date.now());

  const failedAttempts = new Map(); // `${ip}|${id}` → 실패 시각 배열
  const rateBuckets = new Map();    // `${kind}|${ip}` → 요청 시각 배열

  function prune(map) {
    if (map.size <= MAX_TRACKED_KEYS) return;
    const keepFrom = now() - FAILED_ATTEMPT_WINDOW_MS;
    for (const [key, times] of map) {
      if (!times.length || times[times.length - 1] < keepFrom) map.delete(key);
    }
  }

  function recent(map, key, windowMs) {
    const from = now() - windowMs;
    const times = (map.get(key) || []).filter((t) => t >= from);
    if (times.length) map.set(key, times);
    else map.delete(key);
    return times;
  }

  function checkRateLimit(kind, req) {
    const { max, windowMs } = RATE_LIMITS[kind];
    const key = `${kind}|${clientIp(req)}`;
    const times = recent(rateBuckets, key, windowMs);
    if (times.length >= max) {
      throw httpError(429, 'rate_limited', '요청이 너무 자주 발생하고 있습니다. 잠시 후 다시 시도해주세요.');
    }
    times.push(now());
    rateBuckets.set(key, times);
    prune(rateBuckets);
  }

  function checkFailedAttempts(req, id) {
    const key = `${clientIp(req)}|${id}`;
    if (recent(failedAttempts, key, FAILED_ATTEMPT_WINDOW_MS).length >= MAX_FAILED_ATTEMPTS) {
      throw httpError(429, 'too_many_attempts', '비밀번호 확인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  function recordFailedAttempt(req, id) {
    const key = `${clientIp(req)}|${id}`;
    const times = recent(failedAttempts, key, FAILED_ATTEMPT_WINDOW_MS);
    times.push(now());
    failedAttempts.set(key, times);
    prune(failedAttempts);
  }

  function clearFailedAttempts(req, id) {
    failedAttempts.delete(`${clientIp(req)}|${id}`);
  }

  return async function secretGardensApi(req, res, routeSegments = []) {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const segments = (Array.isArray(routeSegments) ? routeSegments : [routeSegments])
        .filter((segment) => segment != null && String(segment) !== '')
        .map((segment) => String(segment));
      const body = parseBody(req);
      const gardenStore = getStore();

      if (segments.length === 0 && method === 'GET') {
        const isMaster = isMasterKey(req.headers?.['x-master-key'], masterKey);
        const gardens = await gardenStore.list();
        return respond(res, 200, {
          authorized: isMaster,
          gardens: isMaster ? gardens.map(stripCredentials) : sanitizePublicSecretGardens(gardens)
        });
      }

      if (segments.length === 0 && method === 'POST') {
        checkRateLimit('create', req);
        const garden = createNewGarden(body, clock());
        const savedGarden = await gardenStore.insert(garden);
        return respond(res, 201, { success: true, garden: stripCredentials(savedGarden) });
      }

      if (segments.length === 1 && segments[0] === 'verify' && method === 'POST') {
        const id = String(body.id || '').trim();
        const password = String(body.password || '').trim();
        if (!id || !password) {
          throw httpError(400, 'missing_credentials', '아이디와 비밀번호를 입력해주세요.');
        }
        checkFailedAttempts(req, id);
        const target = await gardenStore.get(id);
        if (!target) throw httpError(404, 'garden_not_found', '해당 스팟을 찾을 수 없습니다.');

        const isMaster = isMasterKey(password, masterKey);
        const isAuthor = !isMaster && verifyGardenPassword(password, target);
        if (!isMaster && !isAuthor) {
          recordFailedAttempt(req, id);
          throw httpError(401, 'invalid_password', '비밀번호가 일치하지 않습니다.');
        }
        clearFailedAttempts(req, id);

        // 작성자 인증에 성공한 옛 평문 비밀번호는 해시로 교체한다(실패해도 확인 자체는 성공으로 둔다).
        let garden = target;
        if (isAuthor && typeof target.password === 'string' && target.password && !target.passwordHash) {
          try {
            garden = (await gardenStore.update(id, (current) => upgradeLegacyPassword(current))) || target;
          } catch (error) {
            console.error('[Secret gardens API] legacy password upgrade failed:', error?.code || 'server_error');
          }
        }
        return respond(res, 200, { success: true, authorized: isMaster, isAuthor, garden: stripCredentials(garden) });
      }

      if (segments.length === 1 && method === 'PUT') {
        const id = segments[0];
        const password = String(body.password || '').trim();
        checkFailedAttempts(req, id);
        const updated = await gardenStore.update(id, (target) => {
          if (!authorized(password, target, masterKey)) {
            recordFailedAttempt(req, id);
            throw httpError(401, 'edit_forbidden', '수정 권한이 없습니다. 비밀번호를 확인해주세요.');
          }
          return updateGarden(target, body);
        });
        if (!updated) throw httpError(404, 'garden_not_found', '스팟을 찾을 수 없습니다.');
        clearFailedAttempts(req, id);
        return respond(res, 200, { success: true, garden: stripCredentials(updated) });
      }

      if (segments.length === 1 && method === 'DELETE') {
        const id = segments[0];
        const password = String(body.password || '').trim();
        checkFailedAttempts(req, id);
        const removed = await gardenStore.remove(id, (target) => {
          if (!authorized(password, target, masterKey)) {
            recordFailedAttempt(req, id);
            throw httpError(401, 'delete_forbidden', '삭제 권한이 없습니다. 비밀번호를 확인해주세요.');
          }
        });
        if (!removed) throw httpError(404, 'garden_not_found', '스팟을 찾을 수 없습니다.');
        clearFailedAttempts(req, id);
        return respond(res, 200, { success: true, message: '스팟이 삭제되었습니다.' });
      }

      if (segments.length === 2 && segments[1] === 'like' && method === 'POST') {
        checkRateLimit('like', req);
        const id = segments[0];
        const updated = await gardenStore.update(id, (target) => ({
          ...upgradeLegacyPassword(target),
          likes: (Number(target.likes) || 0) + 1
        }));
        if (!updated) throw httpError(404, 'garden_not_found', '스팟을 찾을 수 없습니다.');
        return respond(res, 200, { success: true, likes: updated.likes });
      }

      if (segments.length === 0 || (segments.length === 1 && segments[0] === 'verify')) {
        res.setHeader?.('Allow', segments.length === 0 ? 'GET, POST' : 'POST');
        throw httpError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
      }
      if (segments.length === 1) {
        res.setHeader?.('Allow', 'PUT, DELETE');
        throw httpError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
      }
      if (segments.length === 2 && segments[1] === 'like') {
        res.setHeader?.('Allow', 'POST');
        throw httpError(405, 'method_not_allowed', '지원하지 않는 요청 방식입니다.');
      }
      throw httpError(404, 'route_not_found', '요청한 비밀의 정원 경로를 찾을 수 없습니다.');
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      const message = error?.publicMessage || (statusCode >= 500
        ? '서버 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'
        : error?.message || '요청을 처리하지 못했습니다.');
      if (statusCode >= 500) {
        console.error('[Secret gardens API]', error?.code || 'server_error');
      }
      return respond(res, statusCode, {
        success: false,
        code: error?.code || 'server_error',
        error: message
      });
    }
  };
}
