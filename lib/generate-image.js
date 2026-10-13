import { GoogleGenAI } from '@google/genai';

// 이미지 생성 공용 로직 (server.js와 api/generate-image.js가 함께 씀)
// 지원되는 Gemini 이미지 모델을 우선순위 순서대로 폴백 시도합니다.
export const DEFAULT_IMAGE_MODELS = [
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
];

function isImagenModel(model) {
  return typeof model === 'string' && model.startsWith('imagen-');
}

export function extractImageFromGenerateContent(response) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const data = part?.inlineData?.data;
    if (data) {
      return { data, mimeType: part.inlineData.mimeType || 'image/png' };
    }
  }
  return null;
}

export function extractImageFromGenerateImages(response) {
  const image = response?.generatedImages?.[0]?.image;
  if (image?.imageBytes) {
    return { data: image.imageBytes, mimeType: image.mimeType || 'image/png' };
  }
  if (image?.gcsUri) {
    return { uri: image.gcsUri };
  }
  return null;
}

function toImageUrl(extracted) {
  if (!extracted) return null;
  if (extracted.uri) return extracted.uri;
  return `data:${extracted.mimeType};base64,${extracted.data}`;
}

async function tryModel(ai, model, prompt) {
  if (isImagenModel(model)) {
    const response = await ai.models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1, aspectRatio: '16:9' },
    });
    return toImageUrl(extractImageFromGenerateImages(response));
  }

  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  return toImageUrl(extractImageFromGenerateContent(response));
}

/**
 * @param {string} prompt
 * @returns {Promise<string>} <img src>에 바로 넣을 수 있는 data URL(또는 URI)
 */
export async function generateImageUrl(prompt) {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.code = 'capability_disabled';
    throw err;
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { headers: { 'User-Agent': 'camping-food-helper' } },
  });

  // GEMINI_IMAGE_MODEL을 지정하면 그 모델만 쓰고, 아니면 기본 순서대로 폴백한다.
  const override = process.env.GEMINI_IMAGE_MODEL?.trim();
  const models = override ? [override] : DEFAULT_IMAGE_MODELS;

  let lastError = null;
  for (const model of models) {
    try {
      const imageUrl = await tryModel(ai, model, prompt);
      if (imageUrl) return imageUrl;
      lastError = new Error(`Model ${model} returned no image`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[Image Generation] model ${model} failed:`, msg);
      lastError = err;
      // 429 쿼터 초과 시 안내 메시지 보강
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        const quotaErr = new Error('Gemini API 일일 할당량(Quota)이 소진되었습니다. 잠시 후 다시 시도해 주세요.');
        quotaErr.code = 'quota_exceeded';
        throw quotaErr;
      }
    }
  }

  const err = new Error(lastError?.message || 'Image generation failed');
  err.code = 'upstream_error';
  throw err;
}
