import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// POST /api/auth/signup { email, password, nickname } → 201 { success, token, user }
export default function handler(req, res) {
  return authApi(req, res, ['signup']);
}
