import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

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
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text;
    if (!text) {
      return res.status(502).json({ code: 'empty_completion' });
    }

    const parsed = JSON.parse(text.trim());
    return res.json(parsed);
  } catch (err) {
    console.error('[AI Studio] /api/sample error:', err);
    return res.status(502).json({ code: 'upstream_error' });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
