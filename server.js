import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { generateImageUrl } from './lib/generate-image.js';
import { createSecretGardensApi, sanitizePublicSecretGardens } from './lib/secret-gardens-api.js';

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

// === 나만의 비밀의 정원 API ===
// Express 로컬 서버와 Vercel 서버리스 함수가 같은 API 로직·저장소를 사용한다.
const secretGardensApi = createSecretGardensApi();
app.all('/api/secret-gardens/verify', (req, res) => secretGardensApi(req, res, ['verify']));
app.all('/api/secret-gardens/:id/like', (req, res) => secretGardensApi(req, res, [req.params.id, 'like']));
app.all('/api/secret-gardens/:id', (req, res) => secretGardensApi(req, res, [req.params.id]));
app.all('/api/secret-gardens', (req, res) => secretGardensApi(req, res, []));

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
