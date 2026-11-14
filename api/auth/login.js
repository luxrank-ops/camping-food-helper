import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// POST /api/auth/login { email, password } → 200 { success, token, user }
export default function handler(req, res) {
  return authApi(req, res, ['login']);
}
