import { createBillingApi } from '../../lib/billing-api.js';

const billingApi = createBillingApi();

// POST /api/billing/portal (Bearer) → 200 { portalUrl } · 연결 전에는 503 billing_not_configured
export default function handler(req, res) {
  return billingApi(req, res, ['portal']);
}
