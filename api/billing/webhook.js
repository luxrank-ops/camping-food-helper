import { createBillingApi } from '../../lib/billing-api.js';

const billingApi = createBillingApi();

// POST /api/billing/webhook 결제 사업자 콜백 → 구독 상태를 users/{uid} 에 반영
export default function handler(req, res) {
  return billingApi(req, res, ['webhook']);
}
