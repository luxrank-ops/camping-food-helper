import { generateSampleJson } from '../lib/sample.js';

// Vercel 서버리스용 Gemini 텍스트(JSON) 엔드포인트. 로직은 lib/sample.js를 Express와 공유한다.
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
    return res.status(200).json(await generateSampleJson(prompt));
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'prompt_too_long' || err.code === 'invalid_json') {
      return res.status(400).json({ code: err.code, error: err.message });
    }
    console.error('[Vercel API] /api/sample error:', err?.message || err);
    return res.status(502).json({ code: 'upstream_error', error: err?.message || 'Text generation failed' });
  }
}
