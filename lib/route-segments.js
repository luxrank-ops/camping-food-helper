// Vercel 캐치올(catch-all) 함수의 경로 조각을 우리 API 라우터가 쓰는 segments 배열로 바꾼다.
//
// 서버리스 함수 수 제한(Vercel Hobby: 배포당 12개) 때문에 /api/auth/*, /api/billing/*,
// /api/secret-gardens/* 는 파일 하나로 여러 경로를 처리한다. 경로 해석은 여기서만 하고
// 단위 테스트로 고정한다.

/** ['signup'] 처럼 그대로 쓰는 경로. 값이 없으면 빈 배열. */
export function catchAllSegments(value) {
  if (Array.isArray(value)) return value.map((part) => String(part ?? '')).filter(Boolean);
  const single = String(value ?? '').trim();
  if (!single) return [];
  return single.split('/').map((part) => part.trim()).filter(Boolean);
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
