import { generateImageUrl } from '../lib/generate-image.js';

// Vercel 서버리스용 이미지 생성 엔드포인트.
// (server.js는 Vercel에서 실행되지 않으므로 이 파일이 없으면 운영 환경에서 404가 난다.)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ code: 'invalid_json', error: 'Missing prompt' });
  }

  try {
    const imageUrl = await generateImageUrl(prompt);
    return res.status(200).json({ imageUrl });
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    console.error('[Vercel API] /api/generate-image error:', err);
    return res.status(502).json({ code: 'upstream_error', error: 'Image generation failed' });
  }
}
