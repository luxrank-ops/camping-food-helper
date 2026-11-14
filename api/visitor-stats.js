import { createVisitorStatsApi } from '../lib/visitor-stats-api.js';
import { withOptionalUser } from '../lib/auth/guard.js';

const visitorStatsApi = createVisitorStatsApi();

// GET  /api/visitor-stats → 오늘·누적 방문자 읽기
// POST /api/visitor-stats → 이번 방문 카운트
// 로그인한 회원만 호출할 수 있다(비로그인 직접 호출 차단).
export default withOptionalUser(function handler(req, res) {
  return visitorStatsApi(req, res);
});
