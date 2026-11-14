import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// PATCH /api/auth/profile (Bearer) { nickname } → 200 { success, user }
export default function handler(req, res) {
  return authApi(req, res, ['profile']);
}
