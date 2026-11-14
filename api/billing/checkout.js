import { createBillingApi } from '../../lib/billing-api.js';

const billingApi = createBillingApi();

// POST /api/billing/checkout (Bearer) { plan } → 200 { checkoutUrl } · 연결 전에는 503 billing_not_configured
export default function handler(req, res) {
  return billingApi(req, res, ['checkout']);
}
