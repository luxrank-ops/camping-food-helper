import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// POST /api/auth/logout (Bearer) → 200 { success }  (토큰은 클라이언트가 버린다)
export default function handler(req, res) {
  return authApi(req, res, ['logout']);
}
