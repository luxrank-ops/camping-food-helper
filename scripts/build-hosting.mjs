// Firebase Hosting 배포용 정적 번들(dist/) 생성 스크립트.
// 서버 전용 파일(server.js, api/, .env 등)이나 민감 정보(비밀번호 평문 등)가
// 정적 호스팅에 노출되지 않도록 필요한 클라이언트 자산만 정제하여 dist/ 폴더로 복사한다.
//
// 비밀의 정원 정제는 API와 같은 sanitizePublicSecretGardens()를 사용한다.
// (예전에는 여기서 별도로 마스킹했는데, 비공개 스팟의 전체 주소(address)가 그대로 남아
//  정적 JSON을 직접 열면 상세 위치가 보이는 문제가 있었다.)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizePublicSecretGardens } from '../lib/secret-gardens-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_DATA = path.join(DIST, 'data');

// 1. 기존 dist 초기화 및 생성
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST_DATA, { recursive: true });

// 2. HTML 엔트리 복사 (index.html, camp-kitchen.html 동기화 보장)
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST, 'index.html'));
fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(DIST, 'camp-kitchen.html'));

// 3. 캠핑장 데이터 복사
const campgroundsSrc = path.join(ROOT, 'data', 'campgrounds.js');
if (fs.existsSync(campgroundsSrc)) {
  fs.copyFileSync(campgroundsSrc, path.join(DIST_DATA, 'campgrounds.js'));
}

// 4. 비밀의 정원 초기 데이터 정제 복사 (비밀번호 및 비공개 상세 위치 제거 — API와 동일 규칙)
const gardensSrc = path.join(ROOT, 'data', 'secret_gardens.json');
if (fs.existsSync(gardensSrc)) {
  const raw = JSON.parse(fs.readFileSync(gardensSrc, 'utf8'));
  const sanitized = sanitizePublicSecretGardens(Array.isArray(raw) ? raw : []);
  fs.writeFileSync(path.join(DIST_DATA, 'secret_gardens.json'), JSON.stringify(sanitized, null, 2), 'utf8');
}

console.log('build-hosting: Firebase Hosting 정적 배포 번들(dist/) 생성 완료');
