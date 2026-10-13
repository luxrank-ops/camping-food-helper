import { GoogleGenAI } from '@google/genai';

// 이미지 생성 공용 로직 (server.js와 api/generate-image.js가 함께 씀)
//
// 예전 코드는 Imagen 모델을 generateContent로 부르고
// 존재하지 않는 응답 필드(candidates[0].image.uri)를 읽어서 항상 실패했다.
// 올바른 사용법:
//  - Gemini 이미지 모델(gemini-2.5-flash-image 등): generateContent →
//    candidates[0].content.parts[].inlineData { data(base64), mimeType }
//  - Imagen 모델(imagen-4.0-generate-001 등): generateImages →
//    generatedImages[0].image { imageBytes(base64), mimeType }
// 두 방식 모두 URL이 아니라 base64 바이트를 돌려주므로 data URL로 바꿔 반환한다.

export const DEFAULT_IMAGE_MODELS = [
  'gemini-2.5-flash-image',
  'imagen-4.0-generate-001',
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
      console.error(`[Image Generation] model ${model} failed:`, err?.message || err);
      lastError = err;
    }
  }

  const err = new Error(lastError?.message || 'Image generation failed');
  err.code = 'upstream_error';
  throw err;
}
