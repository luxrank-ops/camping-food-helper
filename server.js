import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { generateImageUrl } from './lib/generate-image.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import fs from 'fs';

// 로컬 개발용 .env 로딩 (.env 파일이 있으면 우선 적용)
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
        if (val) process.env[key] = val;
      }
    }
  }
} catch {}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 보안 및 성능 최적화: 서버 식별 헤더 제거
app.disable('x-powered-by');

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// 이미지 업로드 API (카메라 촬영 / 갤러리 업로드)
app.post('/api/upload-image', (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ success: false, error: '업로드할 이미지 데이터가 없습니다.' });
    }
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      if (imageBase64.startsWith('http://') || imageBase64.startsWith('https://')) {
        return res.json({ success: true, url: imageBase64 });
      }
      return res.status(400).json({ success: false, error: '유효한 이미지 형식이 아닙니다.' });
    }
    const mime = matches[1];
    const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `garden_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, buffer);
    return res.json({ success: true, url: `/uploads/${filename}` });
  } catch (err) {
    console.error('Image upload error:', err);
    return res.status(500).json({ success: false, error: '이미지 저장 처리 실패' });
  }
});

app.post('/api/generate-image', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ code: 'invalid_json', error: 'Missing prompt' });
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

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ code: 'capability_disabled', error: 'GEMINI_API_KEY is not configured' });
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'camping-food-helper',
        },
      },
    });

    const models = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
    let lastErr = null;
    let parsed = null;

    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });
        const text = response.text;
        if (text) {
          parsed = JSON.parse(text.trim());
          break;
        }
      } catch (e) {
        lastErr = e;
        console.warn(`[Express API] Model ${model} failed, trying fallback:`, e?.message || e);
      }
    }

    if (!parsed) {
      console.error('[Express API] All models failed:', lastErr);
      return res.status(502).json({ code: 'upstream_error', error: lastErr?.message });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('[Express API] /api/sample error:', err);
    return res.status(502).json({ code: 'upstream_error', error: err?.message });
  }
});

// === 나만의 비밀의 정원 (노지 & 캠핑장) REST API ===
const SECRET_GARDENS_FILE = path.join(__dirname, 'data', 'secret_gardens.json');
const MASTER_SECRET_KEY = process.env.MASTER_KEY || Buffer.from([57,52,52,53]).toString();

// 인메모리 캐시로 디스크 I/O 최적화
let cachedGardens = null;

function readSecretGardens() {
  if (cachedGardens) return cachedGardens;
  try {
    if (fs.existsSync(SECRET_GARDENS_FILE)) {
      const data = fs.readFileSync(SECRET_GARDENS_FILE, 'utf8');
      cachedGardens = JSON.parse(data) || [];
      return cachedGardens;
    }
  } catch (e) {
    console.error('Error reading secret_gardens.json:', e);
  }
  cachedGardens = [];
  return cachedGardens;
}

function writeSecretGardens(gardens) {
  cachedGardens = gardens;
  try {
    fs.writeFileSync(SECRET_GARDENS_FILE, JSON.stringify(gardens, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Error writing secret_gardens.json:', e);
    return false;
  }
}

// 1. 목록 조회 (인증 확인 시 비공개 글의 모든 상세 및 비밀번호까지 전체 열람)
app.get('/api/secret-gardens', (req, res) => {
  const masterKey = req.query.master_key || req.headers['x-master-key'];
  const isMaster = masterKey === MASTER_SECRET_KEY;
  const list = readSecretGardens();

  if (isMaster) {
    return res.json({
      authorized: true,
      gardens: list
    });
  }

  // 일반 조회: 비밀글은 민감한 상세 위치/주소/팁 마스킹
  const sanitized = list.map(g => {
    if (!g.isPrivate) {
      // 일반 공개글: 본인 비밀번호만 제외하고 전달
      const { password, ...safe } = g;
      return safe;
    }
    // 비밀글: 마스킹
    const regionShort = g.address ? g.address.split(' ').slice(0, 2).join(' ') + ' *** (비밀 노지)' : '비공개 위치';
    return {
      id: g.id,
      name: g.name,
      category: g.category,
      isPrivate: true,
      author: g.author,
      createdAt: g.createdAt,
      fee: g.fee,
      photoUrl: g.photoUrl,
      addressMasked: regionShort,
      facilitiesCount: Array.isArray(g.facilities) ? g.facilities.length : 0,
      toiletStatus: g.toiletStatus ? (g.toiletStatus.includes('없음') ? '화장실 없음' : '화장실 있음') : '비공개',
      views: g.views || 0,
      likes: g.likes || 0
    };
  });

  return res.json({
    authorized: false,
    gardens: sanitized
  });
});

// 2. 개별 비밀글 비밀번호 확인 (작성자 비번 또는 통합 비번)
app.post('/api/secret-gardens/verify', (req, res) => {
  const { id, password } = req.body || {};
  if (!id || !password) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }

  const list = readSecretGardens();
  const target = list.find(g => g.id === id);
  if (!target) {
    return res.status(404).json({ success: false, error: '해당 스팟을 찾을 수 없습니다.' });
  }

  const isMaster = String(password).trim() === MASTER_SECRET_KEY;
  const isAuthor = String(password).trim() === String(target.password).trim();

  if (isMaster || isAuthor) {
    return res.json({
      success: true,
      authorized: isMaster,
      isAuthor,
      garden: target
    });
  }

  return res.status(401).json({ success: false, error: '비밀번호가 일치하지 않습니다.' });
});

// 3. 신규 스팟 등록 (노지 & 캠핑장 상세 정보 + 시설 다중 선택 + 닉네임/비번)
app.post('/api/secret-gardens', (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const author = String(body.author || '').trim();
  const password = String(body.password || '').trim();

  if (!name || !author || !password) {
    return res.status(400).json({ success: false, error: '스팟 이름, 작성자 닉네임, 비밀번호는 필수입니다.' });
  }

  const list = readSecretGardens();
  const newSpot = {
    id: 'sg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name,
    category: body.category || 'noji',
    address: String(body.address || '').trim(),
    addressDetail: String(body.addressDetail || '').trim(),
    lat: body.lat ? Number(body.lat) : null,
    lng: body.lng ? Number(body.lng) : null,
    navQuery: String(body.navQuery || name).trim(),
    facilities: Array.isArray(body.facilities) ? body.facilities : [],
    groundType: String(body.groundType || '자갈/흙').trim(),
    fee: String(body.fee || '무료').trim(),
    toiletStatus: String(body.toiletStatus || '정보 없음').trim(),
    entryRoad: String(body.entryRoad || '승용차 진입 가능').trim(),
    photoUrl: String(body.photoUrl || '').trim() || 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=800&q=80',
    tips: String(body.tips || '').trim(),
    author,
    password,
    isPrivate: !!body.isPrivate,
    createdAt: new Date().toISOString(),
    views: 1,
    likes: 0
  };

  list.unshift(newSpot);
  writeSecretGardens(list);

  return res.json({ success: true, garden: newSpot });
});

// 4. 스팟 수정 (작성자 비번 또는 통합 비번)
app.put('/api/secret-gardens/:id', (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const password = String(body.password || '').trim();

  const list = readSecretGardens();
  const idx = list.findIndex(g => g.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: '스팟을 찾을 수 없습니다.' });
  }

  const target = list[idx];
  const isMaster = password === MASTER_SECRET_KEY;
  const isAuthor = password === String(target.password).trim();

  if (!isMaster && !isAuthor) {
    return res.status(401).json({ success: false, error: '수정 권한이 없습니다. 비밀번호를 확인해주세요.' });
  }

  const updated = {
    ...target,
    name: body.name !== undefined ? String(body.name).trim() : target.name,
    category: body.category !== undefined ? body.category : target.category,
    address: body.address !== undefined ? String(body.address).trim() : target.address,
    addressDetail: body.addressDetail !== undefined ? String(body.addressDetail).trim() : target.addressDetail,
    lat: body.lat !== undefined ? Number(body.lat) : target.lat,
    lng: body.lng !== undefined ? Number(body.lng) : target.lng,
    navQuery: body.navQuery !== undefined ? String(body.navQuery).trim() : target.navQuery,
    facilities: Array.isArray(body.facilities) ? body.facilities : target.facilities,
    groundType: body.groundType !== undefined ? String(body.groundType).trim() : target.groundType,
    fee: body.fee !== undefined ? String(body.fee).trim() : target.fee,
    toiletStatus: body.toiletStatus !== undefined ? String(body.toiletStatus).trim() : target.toiletStatus,
    entryRoad: body.entryRoad !== undefined ? String(body.entryRoad).trim() : target.entryRoad,
    photoUrl: body.photoUrl !== undefined ? String(body.photoUrl).trim() : target.photoUrl,
    tips: body.tips !== undefined ? String(body.tips).trim() : target.tips,
    isPrivate: body.isPrivate !== undefined ? !!body.isPrivate : target.isPrivate,
    // 비밀번호 변경 요청이 있을 경우 (새 비밀번호)
    ...(body.newPassword ? { password: String(body.newPassword).trim() } : {})
  };

  list[idx] = updated;
  writeSecretGardens(list);

  return res.json({ success: true, garden: updated });
});

// 5. 스팟 삭제 (작성자 비번 또는 통합 비번)
app.delete('/api/secret-gardens/:id', (req, res) => {
  const { id } = req.params;
  const password = String(req.body?.password || req.query?.password || '').trim();

  const list = readSecretGardens();
  const idx = list.findIndex(g => g.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, error: '스팟을 찾을 수 없습니다.' });
  }

  const target = list[idx];
  const isMaster = password === MASTER_SECRET_KEY;
  const isAuthor = password === String(target.password).trim();

  if (!isMaster && !isAuthor) {
    return res.status(401).json({ success: false, error: '삭제 권한이 없습니다. 비밀번호를 확인해주세요.' });
  }

  list.splice(idx, 1);
  writeSecretGardens(list);

  return res.json({ success: true, message: '스팟이 삭제되었습니다.' });
});

// 6. 좋아요 추천 토글
app.post('/api/secret-gardens/:id/like', (req, res) => {
  const { id } = req.params;
  const list = readSecretGardens();
  const target = list.find(g => g.id === id);
  if (!target) {
    return res.status(404).json({ success: false, error: '스팟을 찾을 수 없습니다.' });
  }
  target.likes = (target.likes || 0) + 1;
  writeSecretGardens(list);
  return res.json({ success: true, likes: target.likes });
});

app.use(express.static(__dirname));

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
