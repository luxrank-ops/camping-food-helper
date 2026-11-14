// Vercel 캐치올(catch-all) 함수의 경로 조각을 우리 API 라우터가 쓰는 segments 배열로 바꾼다.
//
// 서버리스 함수 수 제한(Vercel Hobby: 배포당 12개) 때문에 /api/auth/*, /api/billing/*,
// /api/secret-gardens/* 는 파일 하나로 여러 경로를 처리한다. 경로 해석은 여기서만 하고
// 단위 테스트로 고정한다.
//
// 경로는 두 곳에서 얻는다.
//  1) req.query 의 캐시올 파라미터(런타임이 넣어 주는 값)
//  2) req.url 의 실제 경로(1번이 비어 있는 런타임·로컬 테스트 대비)
// 두 값을 모두 보므로 Vercel·Express·단위 테스트 어디서든 같은 결과가 나온다.

/** 'signup' · ['signup'] · 'sg_1/like' → ['signup'] 처럼 항상 배열로 만든다. */
export function catchAllSegments(value) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? '').trim()).filter(Boolean);
  const single = String(value ?? '').trim();
  if (!single) return [];
  return single.split('/').map((part) => part.trim()).filter(Boolean);
}

/** URL 경로에서 prefix 뒤의 조각만 뽑는다. */
export function pathSegments(url, prefix) {
  const pathname = String(url || '').split('?')[0];
  let rest = pathname;
  if (prefix && pathname.startsWith(prefix)) rest = pathname.slice(prefix.length);
  return catchAllSegments(rest);
}

/**
 * 요청 하나에서 prefix 뒤의 경로 조각을 얻는다.
 * @param {object} req Vercel/Express 요청 객체
 * @param {{prefix: string, queryKey?: string}} options
 */
export function requestSegments(req, { prefix, queryKey } = {}) {
  const fromQuery = queryKey ? catchAllSegments(req?.query?.[queryKey]) : [];
  if (fromQuery.length) return fromQuery;
  return pathSegments(req?.url, prefix);
}

/**
 * /api/secret-gardens/{id}, /{id}/like, /verify → ['verify'] | [id] | [id, 'like']
 * 그 밖의 경로는 첫 조각만 쓴다(알 수 없는 하위 경로는 해당 스팟 조회로 처리).
 */
export function secretGardenSegments(value) {
  const parts = catchAllSegments(value);
  if (!parts.length) return [];
  if (parts[0] === 'verify') return ['verify'];
  if (parts.length > 1 && parts[1] === 'like') return [parts[0], 'like'];
  return [parts[0]];
}
