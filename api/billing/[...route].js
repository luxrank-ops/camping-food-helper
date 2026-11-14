import { createBillingApi } from '../../lib/billing-api.js';
import { catchAllSegments } from '../../lib/route-segments.js';

const billingApi = createBillingApi();

// /api/billing/* 전체를 한 함수로 처리한다(서버리스 함수 수 제한 대응).
//   GET  /api/billing/status    결제 연결 상태 + 유료 플랜(공개)
//   POST /api/billing/checkout  (Bearer) 구독 결제 세션
//   POST /api/billing/portal    (Bearer) 구독 관리
//   POST /api/billing/webhook   결제 사업자 콜백(서명 검증)
export default function handler(req, res) {
  return billingApi(req, res, catchAllSegments(req.query?.route));
}
