import { createGuestbookApi } from '../../lib/guestbook-api.js';
import { withOptionalUser } from '../../lib/auth/guard.js';
const guestbookApi = createGuestbookApi();
export default withOptionalUser(function handler(req, res) { return guestbookApi(req, res, [req.query.id]); });
