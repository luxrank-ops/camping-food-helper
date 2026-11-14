import { createSecretGardensApi } from '../../../lib/secret-gardens-api.js';
import { withUserAuth } from '../../../lib/auth/guard.js';

const secretGardensApi = createSecretGardensApi();

export default withUserAuth(function handler(req, res) {
  return secretGardensApi(req, res, [req.query?.id, 'like']);
});
