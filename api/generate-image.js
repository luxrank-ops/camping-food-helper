import { generateImageUrl } from '../lib/generate-image.js';
import { MAX_IMAGE_PROMPT_LENGTH } from '../lib/sample.js';
import { getAuthService } from '../lib/auth/service.js';
import { optionalUser, clientIp } from '../lib/auth/guard.js';
import { checkQuota, recordUsage } from '../lib/auth/quota.js';
import { checkGuestQuota, recordGuestUsage } from '../lib/auth/guest-limit.js';

// Vercel 서버리스용 이미지 생성 엔드포인트.
// 로그인 없이도 쓸 수 있고, 토큰이 있으면 그 회원의 하루 한도(lib/plans.js)를 적용한다.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ code: 'method_not_allowed' });
  }

  const auth = await optionalUser(req);
  if (!auth.ok) {
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

  const ip = clientIp(req);
  const quota = auth.user ? checkQuota(auth.user, 'image') : checkGuestQuota(ip, 'image');
  if (!quota.ok) {
    return res.status(429).json({
      success: false,
      code: quota.code,
      plan: quota.plan || 'guest',
      limit: quota.limit,
      used: quota.used,
      error: quota.message
    });
  }

  try {
    const imageUrl = await generateImageUrl(prompt);
    if (auth.user) await recordUsage(getAuthService().store, auth.user, 'image');
    else recordGuestUsage(ip, 'image');
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
