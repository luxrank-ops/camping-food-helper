import { createSecretGardensApi } from '../../../lib/secret-gardens-api.js';

const secretGardensApi = createSecretGardensApi();

export default function handler(req, res) {
  return secretGardensApi(req, res, [req.query?.id, 'like']);
}
