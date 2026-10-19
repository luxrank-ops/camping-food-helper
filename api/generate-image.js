import { generateImageUrl } from '../lib/generate-image.js';
import { MAX_IMAGE_PROMPT_LENGTH } from '../lib/sample.js';

// Vercel 서버리스용 이미지 생성 엔드포인트.
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
  if (prompt.length > MAX_IMAGE_PROMPT_LENGTH) {
    return res.status(400).json({ code: 'prompt_too_long', error: 'Prompt is too long' });
  }

  try {
    const imageUrl = await generateImageUrl(prompt);
    return res.status(200).json({ imageUrl });
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'quota_exceeded') {
      return res.status(429).json({ code: err.code, error: err.message });
    }
    console.error('[Vercel API] /api/generate-image error:', err);
    return res.status(502).json({ code: 'upstream_error', error: err.message || 'Image generation failed' });
  }
}
