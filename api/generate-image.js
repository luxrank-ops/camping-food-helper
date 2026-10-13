import { GoogleGenAI } from '@google/genai';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not configured' });
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

    const response = await ai.models.generateImages({
      model: 'imagen-3.0-generate-002',
      prompt: prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: 'image/jpeg',
      },
    });

    const b64 = response.generatedImages?.[0]?.image?.imageBytes;
    if (b64) {
      return res.status(200).json({ imageUrl: `data:image/jpeg;base64,${b64}` });
    }
    return res.status(502).json({ error: 'Image generation failed' });
  } catch (err) {
    console.error('[Vercel API] /api/generate-image error:', err);
    return res.status(502).json({ error: 'Image generation failed' });
  }
}
