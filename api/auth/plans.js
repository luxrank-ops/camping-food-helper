import { createAuthApi } from '../../lib/auth-api.js';

const authApi = createAuthApi();

// GET /api/auth/plans → 200 { success, plans }  (무료·프로 요금제 목록, 공개)
export default function handler(req, res) {
  return authApi(req, res, ['plans']);
}
