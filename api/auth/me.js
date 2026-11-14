import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// GET /api/auth/me (Authorization: Bearer <token>) → 200 { success, user }
// user.entitlements 에 현재 플랜·한도·남은 횟수가 들어 있다.
export default function handler(req, res) {
  return authApi(req, res, ['me']);
}
