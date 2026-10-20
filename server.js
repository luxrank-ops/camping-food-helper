import express from 'express';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'url';
import { generateImageUrl } from './lib/generate-image.js';
import { generateSampleJson, MAX_IMAGE_PROMPT_LENGTH } from './lib/sample.js';
import { parseImageDataUrl } from './lib/image-upload.js';
import { createSecretGardensApi, sanitizePublicSecretGardens } from './lib/secret-gardens-api.js';
import { createVisitorStatsApi } from './lib/visitor-stats-api.js';
import { createGuestbookApi } from './lib/guestbook-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 로컬 개발용 .env 로딩 (이미 설정된 환경변수는 덮어쓰지 않는다)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match && !line.trim().startsWith('#')) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val && process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
} catch {}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 보안 및 성능 최적화: 서버 식별 헤더 제거
app.disable('x-powered-by');

// 기본 보안 헤더 (인라인 스크립트 중심 구조라 CSP는 별도 마이그레이션 과제로 둔다)
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN'
  });
  next();
});

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 이미지 업로드 API (카메라 촬영 / 갤러리 업로드) — Vercel과 같은 검증(lib/image-upload.js)을 쓴다.
app.post('/api/upload-image', (req, res) => {
  try {
    const image = parseImageDataUrl(req.body?.imageBase64);
    if (image.externalUrl) {
      return res.json({ success: true, url: image.externalUrl });
    }
    const filename = `garden_${Date.now()}_${randomBytes(8).toString('hex')}.${image.ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), image.buffer);
    return res.json({ success: true, url: `/uploads/${filename}` });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ success: false, code: err.code, error: err.publicMessage || err.message });
    }
    console.error('Image upload error:', err);
    return res.status(500).json({ success: false, error: '이미지 저장 처리 실패' });
  }
});

app.post('/api/generate-image', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ code: 'invalid_json', error: 'Missing prompt' });
  }
  if (prompt.length > MAX_IMAGE_PROMPT_LENGTH) {
    return res.status(400).json({ code: 'prompt_too_long', error: 'Prompt is too long' });
  }

  try {
    const imageUrl = await generateImageUrl(prompt);
    return res.json({ imageUrl });
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'quota_exceeded') {
      return res.status(429).json({ code: err.code, error: err.message });
    }
    console.error('[Image Generation] /api/generate-image error:', err);
    return res.status(502).json({ code: 'upstream_error', error: err.message || 'Image generation failed' });
  }
});

app.post('/api/sample', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ code: 'invalid_json', error: 'Missing prompt' });
  }

  try {
    return res.json(await generateSampleJson(prompt));
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'prompt_too_long' || err.code === 'invalid_json') {
      return res.status(400).json({ code: err.code, error: err.message });
    }
    console.error('[Express API] /api/sample error:', err?.message || err);
    return res.status(502).json({ code: 'upstream_error', error: err?.message || 'Text generation failed' });
  }
});

// === 나만의 비밀의 정원 API ===
// Express 로컬 서버와 Vercel 서버리스 함수가 같은 API 로직·저장소를 사용한다.
const secretGardensApi = createSecretGardensApi();
app.all('/api/secret-gardens/verify', (req, res) => secretGardensApi(req, res, ['verify']));
app.all('/api/secret-gardens/:id/like', (req, res) => secretGardensApi(req, res, [req.params.id, 'like']));
app.all('/api/secret-gardens/:id', (req, res) => secretGardensApi(req, res, [req.params.id]));
app.all('/api/secret-gardens', (req, res) => secretGardensApi(req, res, []));

// === 방문자 카운터 API (오늘 방문자 · 누적 방문자) ===
// Express 로컬 서버와 Vercel 서버리스 함수(api/visitor-stats.js)가 같은 로직·저장소를 사용한다.
const visitorStatsApi = createVisitorStatsApi();
app.all('/api/visitor-stats', (req, res) => visitorStatsApi(req, res));

// === 방명록 게시판 API ===
const guestbookApi = createGuestbookApi();
app.all('/api/guestbook/:id', (req, res) => guestbookApi(req, res, [req.params.id]));
app.all('/api/guestbook', (req, res) => guestbookApi(req, res, []));

// 정적 폴백 데이터에서는 비밀번호와 비공개 상세 위치를 절대 노출하지 않는다.
app.get('/data/secret_gardens.json', (req, res) => {
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(dataDir, 'secret_gardens.json'), 'utf8'));
    res.set('Cache-Control', 'no-store');
    return res.json(sanitizePublicSecretGardens(seed));
  } catch (error) {
    console.error('[Secret gardens] Failed to read public fallback data:', error?.message || error);
    return res.json([]);
  }
});

// 정적 파일은 허용 목록만 내려준다.
// 예전에는 저장소 루트 전체가 공개되어 server.js, lib/*.js 같은 서버 소스도 열람할 수 있었다.
const PUBLIC_FILES = new Set(['/', '/index.html', '/camp-kitchen.html', '/data/campgrounds.js']);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const requestPath = req.path;
  if (requestPath.startsWith('/api/')) return next();
  if (PUBLIC_FILES.has(requestPath)) return next();
  if (/^\/uploads\/[A-Za-z0-9._-]+$/.test(requestPath)) return next();
  // 확장자가 있는 파일 경로인데 허용 목록에 없으면 소스/설정 파일로 보고 차단한다.
  if (/\.[A-Za-z0-9]+$/.test(requestPath)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  return next(); // 확장자 없는 경로는 SPA 폴백으로 넘긴다.
});

app.use(express.static(__dirname, {
  dotfiles: 'deny',
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(`${path.sep}data${path.sep}campgrounds.js`)) {
      res.set('Cache-Control', 'public, max-age=86400');
    } else if (filePath.includes(`${path.sep}uploads${path.sep}`)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    }
  }
}));

// 등록되지 않은 /api/* 경로는 SPA HTML이 아니라 JSON 404로 답한다.
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, code: 'route_not_found', error: '요청한 API 경로를 찾을 수 없습니다.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 전역 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, error: '서버 내부 오류가 발생했습니다.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
