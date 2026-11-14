import { createHealthApi } from '../lib/health-api.js';

const healthApi = createHealthApi();

// GET /api/health → 200 { ok, storage, time }  (공개 · GitHub Actions Uptime check 대상)
export default function handler(req, res) {
  return healthApi(req, res);
}
