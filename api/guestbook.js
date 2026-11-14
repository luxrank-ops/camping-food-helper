import { createGuestbookApi } from '../lib/guestbook-api.js';
import { withUserAuth } from '../lib/auth/guard.js';
const guestbookApi = createGuestbookApi();
// 방명록 읽기·쓰기는 로그인한 회원만 가능하다.
export default withUserAuth(function handler(req, res) { return guestbookApi(req, res, []); });
