import { createAuthApi } from '../../lib/auth-api.js';
import { catchAllSegments } from '../../lib/route-segments.js';

const authApi = createAuthApi();

// /api/auth/* 전체를 한 함수로 처리한다.
// (Vercel Hobby 플랜은 배포당 서버리스 함수 12개 제한이 있어, 엔드포인트마다 파일을 만들지 않는다.)
//   POST   /api/auth/signup    { email, password, nickname } → 201 { token, user }
//   POST   /api/auth/login     { email, password }           → 200 { token, user }
//   GET    /api/auth/me        (Bearer)                      → 200 { user }
//   PATCH  /api/auth/profile   (Bearer) { nickname }
//   POST   /api/auth/password  (Bearer) { currentPassword, newPassword }
//   POST   /api/auth/logout    (Bearer)
//   DELETE /api/auth/account   (Bearer)  회원 탈퇴
//   GET    /api/auth/plans                                   → 무료·프로 요금제(공개)
export default function handler(req, res) {
  return authApi(req, res, catchAllSegments(req.query?.route));
}
