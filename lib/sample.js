import { GoogleGenAI } from '@google/genai';

// Gemini 텍스트(JSON 응답) 생성 공용 로직.
// 예전에는 server.js와 api/sample.js에 같은 코드가 복붙되어 모델 목록·User-Agent가
// 서로 어긋나 있었다. 이제 두 진입점이 이 함수 하나를 쓴다.
//
// 모델은 우선순위 순서대로 시도하고, JSON 파싱에 실패한 모델도 폴백 대상이다.
// 환경변수 GEMINI_TEXT_MODEL을 지정하면 그 모델만 쓴다.

export const DEFAULT_TEXT_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
export const MAX_PROMPT_LENGTH = 20000;
export const MAX_IMAGE_PROMPT_LENGTH = 2000;
// Gemini 요청 한 건의 상한(밀리초). 응답이 없을 때 함수가 몇 분씩 매달리지 않고
// 빨리 끝나야 화면도 빨리 내장 레시피로 폴백한다. 정상 생성은 5~40초라 45초로 둔다.
export const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) > 0 ? Number(process.env.GEMINI_TIMEOUT_MS) : 45000;

function capabilityError(message) {
  const err = new Error(message);
  err.code = 'capability_disabled';
  return err;
}

function upstreamError(cause) {
  const err = new Error(cause?.message || 'Text generation failed');
  err.code = 'upstream_error';
  return err;
}

/** 요청 시간 초과(응답 없음) 오류인지 판단한다. */
export function isTimeoutError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const name = String(err.name || '');
  const message = String(err.message || err);
  return (
    code === 'ETIMEDOUT' ||
    code === 'APIConnectionTimeoutError' ||
    name === 'APIConnectionTimeoutError' ||
    err.status === 504 ||
    /timeout|timed out|ETIMEDOUT/i.test(message)
  );
}

/** 모델이 ```json 펜스를 붙여도 본문만 꺼낸다. */
export function parseJsonResponse(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export function createGeminiClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: { 'User-Agent': 'camping-food-helper' },
      // 무응답으로 함수가 매달리지 않게 요청 단위 시간 제한을 건다.
      timeout: GEMINI_TIMEOUT_MS
    }
  });
}

/**
 * @param {string} prompt
 * @param {{ createClient?: () => any, models?: string[] }} [options] 테스트용 주입 지점
 * @returns {Promise<any>} 파싱된 JSON
 */
export async function generateSampleJson(prompt, options = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) {
    const err = new Error('Missing prompt');
    err.code = 'invalid_json';
    err.statusCode = 400;
    throw err;
  }
  if (text.length > MAX_PROMPT_LENGTH) {
    const err = new Error('Prompt is too long');
    err.code = 'prompt_too_long';
    err.statusCode = 400;
    throw err;
  }
  if (!process.env.GEMINI_API_KEY && !options.createClient) {
    throw capabilityError('GEMINI_API_KEY is not configured');
  }

  const ai = (options.createClient || createGeminiClient)();
  const override = process.env.GEMINI_TEXT_MODEL?.trim();
  const models = options.models || (override ? [override] : DEFAULT_TEXT_MODELS);

  let lastErr = null;
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: text,
        config: { responseMimeType: 'application/json' }
      });
      if (response?.text) {
        return parseJsonResponse(response.text);
      }
      lastErr = new Error(`Model ${model} returned no text`);
    } catch (err) {
      lastErr = err;
      console.warn(`[Sample API] Model ${model} failed, trying fallback:`, err?.message || err);
      // 시간 초과는 서버가 응답을 못 주는 상태라 다음 모델도 같을 가능이 크다.
      // 남은 모델을 또 45초씩 기다리면 함수가 오래 매달리므로 바로 실패로 끝낸다.
      if (isTimeoutError(err)) {
        const timeoutErr = new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms`);
        timeoutErr.code = 'upstream_error';
        throw timeoutErr;
      }
    }
  }

  console.error('[Sample API] All models failed:', lastErr?.message || lastErr);
  throw upstreamError(lastErr);
}
