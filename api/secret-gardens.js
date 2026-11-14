import { createSecretGardensApi } from '../lib/secret-gardens-api.js';
import { withOptionalUser } from '../lib/auth/guard.js';

const secretGardensApi = createSecretGardensApi();

// 비밀의 정원 목록은 게스트도 조회할 수 있다(비밀번호·상세 위치는 서버가 제거).
export default withOptionalUser(function handler(req, res) {
  return secretGardensApi(req, res, []);
});
