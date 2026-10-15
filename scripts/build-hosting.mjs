// Firebase Hosting 배포용 정적 번들(dist/) 생성 스크립트.
// 서버 전용 파일(server.js, api/, .env 등)이나 민감 정보(비밀번호 평문 등)가
// 정적 호스팅에 노출되지 않도록 필요한 클라이언트 자산만 정제하여 dist/ 폴더로 복사한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 4. 비밀의 정원 초기 데이터 정제 복사 (비밀번호 및 비공개 상세주소 마스킹)
const gardensSrc = path.join(ROOT, 'data', 'secret_gardens.json');
if (fs.existsSync(gardensSrc)) {
  const raw = JSON.parse(fs.readFileSync(gardensSrc, 'utf8'));
  const sanitized = (Array.isArray(raw) ? raw : []).map((spot) => {
    const copy = { ...spot };
    delete copy.password;
    delete copy.secretCode;
    if (copy.isPrivate) {
      const parts = (copy.address || '').split(' ');
      copy.addressMasked = parts.slice(0, 2).join(' ') + ' (비공개 스팟)';
      copy.addressDetail = '🔒 잠금 해제 후 상세 진입로와 위치가 표시됩니다.';
      copy.tips = '🔒 비공개 스팟입니다. 비밀번호를 입력해 열람하세요.';
      copy.navQuery = parts.slice(0, 2).join(' ');
      if (typeof copy.lat === 'number') copy.lat = Math.round(copy.lat * 100) / 100;
      if (typeof copy.lng === 'number') copy.lng = Math.round(copy.lng * 100) / 100;
    }
    return copy;
  });
  fs.writeFileSync(path.join(DIST_DATA, 'secret_gardens.json'), JSON.stringify(sanitized, null, 2), 'utf8');
}

console.log('build-hosting: Firebase Hosting 정적 배포 번들(dist/) 생성 완료');
