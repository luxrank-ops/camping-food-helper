import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// 비밀의 정원 비밀번호 보관/검증 공용 유틸.
//
// - 새 비밀번호는 scrypt 해시(`scrypt1:<salt>:<hash>`)로만 저장한다(평문 저장 금지).
// - 이미 저장된 옛 평문 비밀번호(`password` 필드)는 검증만 허용하고,
//   upgradeLegacyPassword()로 기회가 닿을 때마다 해시로 교체한다(마이그레이션).
// - 모든 비교는 길이에 상관없이 타이밍 정보를 흘리지 않도록 SHA-256 다이제스트를
//   timingSafeEqual로 비교한다.

const HASH_PREFIX = 'scrypt1';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT = { N: 16384, r: 8, p: 1 };

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(sha256(a), sha256(b));
}

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(String(password), salt, KEY_BYTES, SCRYPT);
  return `${HASH_PREFIX}:${salt.toString('hex')}:${key.toString('hex')}`;
}

export function isHashedPassword(value) {
  return typeof value === 'string' && value.startsWith(`${HASH_PREFIX}:`);
}

/** 저장된 해시(scrypt1:…)와 입력값을 비교한다. 형식이 깨졌으면 false. */
export function verifyPasswordHash(input, storedHash) {
  try {
    const [, saltHex, keyHex] = String(storedHash).split(':');
    if (!saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    if (!salt.length || expected.length !== KEY_BYTES) return false;
    return timingSafeEqual(scryptSync(String(input), salt, KEY_BYTES, SCRYPT), expected);
  } catch {
    return false;
  }
}

/** 정원 레코드의 작성자 비밀번호와 입력값을 비교한다(해시 우선, 옛 평문은 마이그레이션용). */
export function verifyGardenPassword(input, garden) {
  const value = typeof input === 'string' ? input : '';
  if (!value) return false;
  if (isHashedPassword(garden?.passwordHash)) {
    return verifyPasswordHash(value, garden.passwordHash);
  }
  const legacy = typeof garden?.password === 'string' ? garden.password : '';
  return !!legacy && timingSafeStringEqual(value, legacy);
}

/** 마스터 키 비교. 환경변수로 설정된 키가 없으면(빈 문자열) 절대 일치하지 않는다. */
export function isMasterKey(input, masterKey) {
  if (!masterKey || typeof input !== 'string') return false;
  return timingSafeStringEqual(input, String(masterKey));
}

/** 옛 평문 비밀번호가 남아 있으면 해시로 교체한 새 레코드를 돌려준다. */
export function upgradeLegacyPassword(garden) {
  if (!garden || typeof garden !== 'object') return garden;
  if (isHashedPassword(garden.passwordHash)) {
    if (garden.password === undefined) return garden;
    const { password, ...rest } = garden;
    return rest;
  }
  if (typeof garden.password === 'string' && garden.password) {
    const { password, ...rest } = garden;
    return { ...rest, passwordHash: hashPassword(password) };
  }
  return garden;
}

/** 응답용 복사본에서 인증 정보(평문·해시)를 항상 제거한다. */
export function stripCredentials(garden) {
  if (!garden || typeof garden !== 'object') return garden;
  const { password, passwordHash, secretCode, ...safe } = garden;
  return safe;
}
