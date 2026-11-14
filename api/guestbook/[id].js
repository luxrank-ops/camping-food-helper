import { createGuestbookApi } from '../../lib/guestbook-api.js';
import { withUserAuth } from '../../lib/auth/guard.js';
const guestbookApi = createGuestbookApi();
export default withUserAuth(function handler(req, res) { return guestbookApi(req, res, [req.query.id]); });
