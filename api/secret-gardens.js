import { createSecretGardensApi } from '../lib/secret-gardens-api.js';
import { withUserAuth } from '../lib/auth/guard.js';

const secretGardensApi = createSecretGardensApi();

// 비밀의 정원 목록은 로그인한 회원만 조회할 수 있다.
export default withUserAuth(function handler(req, res) {
  return secretGardensApi(req, res, []);
});
