import { randomUUID } from 'node:crypto';
import { getSecretGardenStore } from './secret-gardens-store.js';

const DEFAULT_MASTER_KEY = Buffer.from([57, 52, 52, 53]).toString();
const DEFAULT_PHOTO_URL = 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=800&q=80';

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

function finiteCoordinate(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isPrivateValue(value) {
  return value === false || value === 0 || value === 'false' || value === '0' ? false : !!value;
}

function resolveMasterKey() {
  return String(process.env.MASTER_KEY || DEFAULT_MASTER_KEY);
}

export function sanitizePublicSecretGardens(gardens) {
  return (Array.isArray(gardens) ? gardens : []).map((garden) => {
    if (!garden.isPrivate) {
      const { password, ...safe } = garden;
      return safe;
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
  const input = String(password || '').trim();
  return input === masterKey || input === String(garden.password || '').trim();
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

  const facilities = Array.isArray(body.facilities)
    ? body.facilities.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 100)
    : [];
  const photoUrl = String(body.photoUrl || '').trim();
  if (/^data:/i.test(photoUrl)) {
    throw httpError(400, 'photo_not_uploaded', '사진 업로드가 끝난 뒤 다시 등록해주세요. 업로드에 실패했다면 프리셋 사진이나 이미지 URL을 선택해주세요.');
  }

  return {
    id: `sg_${now.getTime()}_${randomUUID().slice(0, 8)}`,
    name,
    category: String(body.category || 'noji').trim() || 'noji',
    address: String(body.address || '').trim(),
    addressDetail: String(body.addressDetail || '').trim(),
    lat: finiteCoordinate(body.lat),
    lng: finiteCoordinate(body.lng),
    navQuery: String(body.navQuery || name).trim(),
    facilities,
    groundType: String(body.groundType || '자갈/흙').trim(),
    fee: String(body.fee || '무료').trim(),
    toiletStatus: String(body.toiletStatus || '정보 없음').trim(),
    entryRoad: String(body.entryRoad || '승용차 진입 가능').trim(),
    photoUrl: photoUrl || DEFAULT_PHOTO_URL,
    tips: String(body.tips || '').trim(),
    author,
    password,
    isPrivate: isPrivateValue(body.isPrivate),
    createdAt: now.toISOString(),
    views: 1,
    likes: 0
  };
}

function updateGarden(current, body) {
  const photoUrl = body.photoUrl !== undefined ? String(body.photoUrl).trim() : current.photoUrl;
  if (/^data:/i.test(photoUrl)) {
    throw httpError(400, 'photo_not_uploaded', '사진 업로드가 끝난 뒤 다시 저장해주세요. 업로드에 실패했다면 프리셋 사진이나 이미지 URL을 선택해주세요.');
  }
  return {
    ...current,
    name: body.name !== undefined ? String(body.name).trim() : current.name,
    category: body.category !== undefined ? String(body.category) : current.category,
    address: body.address !== undefined ? String(body.address).trim() : current.address,
    addressDetail: body.addressDetail !== undefined ? String(body.addressDetail).trim() : current.addressDetail,
    lat: body.lat !== undefined ? finiteCoordinate(body.lat) : current.lat,
    lng: body.lng !== undefined ? finiteCoordinate(body.lng) : current.lng,
    navQuery: body.navQuery !== undefined ? String(body.navQuery).trim() : current.navQuery,
    facilities: Array.isArray(body.facilities)
      ? body.facilities.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 100)
      : current.facilities,
    groundType: body.groundType !== undefined ? String(body.groundType).trim() : current.groundType,
    fee: body.fee !== undefined ? String(body.fee).trim() : current.fee,
    toiletStatus: body.toiletStatus !== undefined ? String(body.toiletStatus).trim() : current.toiletStatus,
    entryRoad: body.entryRoad !== undefined ? String(body.entryRoad).trim() : current.entryRoad,
    photoUrl,
    tips: body.tips !== undefined ? String(body.tips).trim() : current.tips,
    isPrivate: body.isPrivate !== undefined ? isPrivateValue(body.isPrivate) : current.isPrivate,
    ...(body.newPassword ? { password: String(body.newPassword).trim() } : {})
  };
}

export function createSecretGardensApi(options = {}) {
  const store = options.store || null;
  const getStore = options.getStore || (() => store || getSecretGardenStore());
  const masterKey = options.masterKey == null ? resolveMasterKey() : String(options.masterKey);
  const clock = options.clock || (() => new Date());

  return async function secretGardensApi(req, res, routeSegments = []) {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const segments = (Array.isArray(routeSegments) ? routeSegments : [routeSegments])
        .filter((segment) => segment != null && String(segment) !== '')
        .map((segment) => String(segment));
      const body = parseBody(req);
      const gardenStore = getStore();

      if (segments.length === 0 && method === 'GET') {
        const suppliedKey = req.query?.master_key || req.headers?.['x-master-key'];
        const isMaster = !!suppliedKey && String(suppliedKey) === masterKey;
        const gardens = await gardenStore.list();
        return respond(res, 200, {
          authorized: isMaster,
          gardens: isMaster ? gardens : sanitizePublicSecretGardens(gardens)
        });
      }

      if (segments.length === 0 && method === 'POST') {
        const garden = createNewGarden(body, clock());
        const savedGarden = await gardenStore.insert(garden);
        return respond(res, 201, { success: true, garden: savedGarden });
      }

      if (segments.length === 1 && segments[0] === 'verify' && method === 'POST') {
        const id = String(body.id || '').trim();
        const password = String(body.password || '').trim();
        if (!id || !password) {
          throw httpError(400, 'missing_credentials', '아이디와 비밀번호를 입력해주세요.');
        }
        const target = await gardenStore.get(id);
        if (!target) throw httpError(404, 'garden_not_found', '해당 스팟을 찾을 수 없습니다.');

        const isMaster = password === masterKey;
        const isAuthor = password === String(target.password || '').trim();
        if (!isMaster && !isAuthor) {
          throw httpError(401, 'invalid_password', '비밀번호가 일치하지 않습니다.');
        }
        return respond(res, 200, { success: true, authorized: isMaster, isAuthor, garden: target });
      }

      if (segments.length === 1 && method === 'PUT') {
        const id = segments[0];
        const password = String(body.password || '').trim();
        const updated = await gardenStore.update(id, (target) => {
          if (!authorized(password, target, masterKey)) {
            throw httpError(401, 'edit_forbidden', '수정 권한이 없습니다. 비밀번호를 확인해주세요.');
          }
          return updateGarden(target, body);
        });
        if (!updated) throw httpError(404, 'garden_not_found', '스팟을 찾을 수 없습니다.');
        return respond(res, 200, { success: true, garden: updated });
      }

      if (segments.length === 1 && method === 'DELETE') {
        const id = segments[0];
        const password = String(body.password || req.query?.password || '').trim();
        const removed = await gardenStore.remove(id, (target) => {
          if (!authorized(password, target, masterKey)) {
            throw httpError(401, 'delete_forbidden', '삭제 권한이 없습니다. 비밀번호를 확인해주세요.');
          }
        });
        if (!removed) throw httpError(404, 'garden_not_found', '스팟을 찾을 수 없습니다.');
        return respond(res, 200, { success: true, message: '스팟이 삭제되었습니다.' });
      }

      if (segments.length === 2 && segments[1] === 'like' && method === 'POST') {
        const id = segments[0];
        const updated = await gardenStore.update(id, (target) => ({
          ...target,
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
