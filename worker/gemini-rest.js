// '@google/genai' 대체 구현 (Cloudflare Workers).
//
// lib/sample.js · lib/generate-image.js 는 SDK 의 두 메서드만 쓴다.
//   ai.models.generateContent({ model, contents, config })  → { text, candidates, ... }
//   ai.models.generateImages({ model, prompt, config })     → { generatedImages: [{ image }] }
// Workers 에서는 SDK 번들(Node 전용 코드 포함) 대신 Gemini REST API 를 그대로 호출한다.
// 모델 폴백·오류 코드 처리는 호출부(lib/*)가 그대로 담당하므로 여기서는 원본 응답만 옮긴다.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = 45000;

function timeoutError(ms) {
  const error = new Error(`Gemini request timed out after ${ms}ms`);
  error.code = 'ETIMEDOUT';
  error.name = 'APIConnectionTimeoutError';
  return error;
}

function isImagen(model) {
  return typeof model === 'string' && model.startsWith('imagen-');
}

export class GoogleGenAI {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.timeoutMs = Number(options.httpOptions?.timeout) > 0
      ? Number(options.httpOptions.timeout)
      : DEFAULT_TIMEOUT_MS;
    this.userAgent = options.httpOptions?.headers?.['User-Agent'] || 'camping-food-helper';

    const self = this;
    this.models = {
      async generateContent(request) {
        return self.generateContent(request);
      },
      async generateImages(request) {
        return self.generateImages(request);
      }
    };
  }

  async call(path, payload) {
    if (!this.apiKey) {
      const error = new Error('GEMINI_API_KEY is not configured');
      error.code = 'capability_disabled';
      throw error;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(`${API_BASE}/${path}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': this.userAgent
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw timeoutError(this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    if (!response.ok) {
      const message = body?.error?.message || `Gemini request failed (${response.status})`;
      const error = new Error(`${response.status} ${message}`);
      error.status = response.status;
      error.code = body?.error?.status || `http_${response.status}`;
      throw error;
    }
    return body || {};
  }

  async generateContent({ model, contents, config } = {}) {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: String(contents ?? '') }] }]
    };
    const generationConfig = {};
    if (config?.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
    if (Array.isArray(config?.responseModalities)) generationConfig.responseModalities = config.responseModalities;
    if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

    const body = await this.call(`models/${encodeURIComponent(model)}:generateContent`, payload);
    const candidate = body?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
    return { ...body, text, candidates: body?.candidates || [] };
  }

  async generateImages({ model, prompt, config } = {}) {
    if (!isImagen(model)) {
      // 이미지 계열 Gemini 모델은 generateContent 로 이미지를 돌려준다.
      return this.generateContent({
        model,
        contents: prompt,
        config: { responseModalities: ['TEXT', 'IMAGE'] }
      });
    }

    const body = await this.call(`models/${encodeURIComponent(model)}:predict`, {
      instances: [{ prompt: String(prompt ?? '') }],
      parameters: {
        sampleCount: config?.numberOfImages || 1,
        ...(config?.aspectRatio ? { aspectRatio: config.aspectRatio } : {})
      }
    });

    const generatedImages = (body?.predictions || []).map((prediction) => ({
      image: {
        imageBytes: prediction?.bytesBase64Encoded || '',
        mimeType: prediction?.mimeType || 'image/png'
      }
    }));
    return { ...body, generatedImages };
  }
}
