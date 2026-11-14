import { createBillingApi } from '../../lib/billing-api.js';

const billingApi = createBillingApi();

// GET /api/billing/status → 200 { configured, provider, plans }  (결제 연결 상태, 공개)
export default function handler(req, res) {
  return billingApi(req, res, ['status']);
}
