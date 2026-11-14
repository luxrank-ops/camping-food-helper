import { generateSampleJson } from '../lib/sample.js';
import { getAuthService } from '../lib/auth/service.js';
import { requireUser } from '../lib/auth/guard.js';
import { checkQuota, recordUsage } from '../lib/auth/quota.js';

// Vercel 서버리스용 Gemini 텍스트(JSON) 엔드포인트. 로직은 lib/sample.js를 Express와 공유한다.
//
// 로그인한 회원만 호출할 수 있다(Authorization: Bearer <token>).
// 무료/유료 하루 한도는 lib/plans.js 에서 정해지고, 사용량은 서버가 users/{uid}.usage 에 기록한다.
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

  const quota = checkQuota(auth.user, 'ai');
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
    const payload = await generateSampleJson(prompt);
    await recordUsage(getAuthService().store, auth.user, 'ai');
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
