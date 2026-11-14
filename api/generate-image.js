import { generateImageUrl } from '../lib/generate-image.js';
import { MAX_IMAGE_PROMPT_LENGTH } from '../lib/sample.js';
import { getAuthService } from '../lib/auth/service.js';
import { requireUser } from '../lib/auth/guard.js';
import { checkQuota, recordUsage } from '../lib/auth/quota.js';

// Vercel 서버리스용 이미지 생성 엔드포인트.
// 로그인한 회원만 호출할 수 있고, 하루 이미지 생성 한도(lib/plans.js)를 넘으면 429 로 답한다.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

  const auth = await requireUser(req);
  if (!auth.ok) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(auth.status).json({ success: false, code: auth.code, error: auth.message });
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

  const quota = checkQuota(auth.user, 'image');
  if (!quota.ok) {
    return res.status(429).json({
      success: false,
      code: quota.code,
      plan: quota.plan,
      limit: quota.limit,
      used: quota.used,
      error: quota.message
    });
  }

  try {
    const imageUrl = await generateImageUrl(prompt);
    await recordUsage(getAuthService().store, auth.user, 'image');
    return res.status(200).json({ imageUrl });
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'quota_exceeded') {
      return res.status(429).json({ code: err.code, error: '이미지 생성 서비스 한도에 닿았어요. 잠시 뒤 다시 시도해 주세요.' });
    }
    console.error('[Vercel API] /api/generate-image error:', err);
    return res.status(502).json({ code: 'upstream_error', error: 'Image generation failed' });
  }
}
