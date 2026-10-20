import { createGuestbookApi } from '../../lib/guestbook-api.js';
const guestbookApi = createGuestbookApi();
export default function handler(req, res) { return guestbookApi(req, res, [req.query.id]); }
