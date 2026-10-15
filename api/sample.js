import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

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
          'User-Agent': 'aistudio-build',
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
        console.warn(`[Vercel API] Model ${model} failed, trying fallback:`, e?.message || e);
      }
    }

    if (!parsed) {
      console.error('[Vercel API] All models failed:', lastErr);
      return res.status(502).json({ code: 'upstream_error', error: lastErr?.message });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('[Vercel API] /api/sample error:', err);
    return res.status(502).json({ code: 'upstream_error', error: err?.message });
  }
}
