import { generateSampleJson } from '../lib/sample.js';
import { getAuthService } from '../lib/auth/service.js';
import { optionalUser, clientIp } from '../lib/auth/guard.js';
import { checkQuota, recordUsage } from '../lib/auth/quota.js';
import { checkGuestQuota, recordGuestUsage } from '../lib/auth/guest-limit.js';

// Vercel 서버리스용 Gemini 텍스트(JSON) 엔드포인트. 로직은 lib/sample.js를 Express와 공유한다.
//
// 로그인 없이도 쓸 수 있다(게스트). 토큰(Authorization: Bearer)이 있으면 그 회원의
// 플랜·하루 사용량을 적용하고 저장하고, 없으면 아이피 기준 게스트 한도를 적용한다.
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

  const ip = clientIp(req);
  const quota = auth.user ? checkQuota(auth.user, 'ai') : checkGuestQuota(ip, 'ai');
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
    const payload = await generateSampleJson(prompt);
    if (auth.user) await recordUsage(getAuthService().store, auth.user, 'ai');
    else recordGuestUsage(ip, 'ai');
    return res.status(200).json(payload);
  } catch (err) {
    if (err.code === 'capability_disabled') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    if (err.code === 'prompt_too_long' || err.code === 'invalid_json') {
      return res.status(400).json({ code: err.code, error: err.message });
    }
    console.error('[Vercel API] /api/sample error:', err?.message || err);
    return res.status(502).json({ code: 'upstream_error', error: 'Text generation failed' });
  }
}
