import { createSecretGardensApi } from '../../lib/secret-gardens-api.js';
import { withUserAuth } from '../../lib/auth/guard.js';
import { secretGardenSegments } from '../../lib/route-segments.js';

const secretGardensApi = createSecretGardensApi();

// /api/secret-gardens/{id}, /{id}/like, /verify 를 한 함수로 처리한다(서버리스 함수 수 제한 대응).
// 목록(/api/secret-gardens)은 ../secret-gardens.js 가 맡는다.
export default withUserAuth(function handler(req, res) {
  return secretGardensApi(req, res, secretGardenSegments(req.query?.path));
});
