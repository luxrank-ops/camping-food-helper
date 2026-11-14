import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// POST /api/auth/password (Bearer) { currentPassword, newPassword } → 200 { success }
export default function handler(req, res) {
  return authApi(req, res, ['password']);
}
