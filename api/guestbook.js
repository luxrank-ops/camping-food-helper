import { createGuestbookApi } from '../lib/guestbook-api.js';
import { withOptionalUser } from '../lib/auth/guard.js';
const guestbookApi = createGuestbookApi();
// 방명록 읽기·쓰기는 게스트도 가능하다(비밀번호로 본인 글 삭제).
export default withOptionalUser(function handler(req, res) { return guestbookApi(req, res, []); });
