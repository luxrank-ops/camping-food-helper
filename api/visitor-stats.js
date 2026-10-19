import { createVisitorStatsApi } from '../lib/visitor-stats-api.js';

const visitorStatsApi = createVisitorStatsApi();

// GET  /api/visitor-stats → 오늘·누적 방문자 읽기
// POST /api/visitor-stats → 이번 방문 카운트
export default function handler(req, res) {
  return visitorStatsApi(req, res);
}
