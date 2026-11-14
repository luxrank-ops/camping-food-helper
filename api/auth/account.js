import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// DELETE /api/auth/account (Bearer) → 200 { success }  (회원 탈퇴)
export default function handler(req, res) {
  return authApi(req, res, ['account']);
}
