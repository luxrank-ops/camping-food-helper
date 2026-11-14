# 회원 · 유료화(구독) 구조

이 문서는 캠핑음식 도우미의 **로그인 필수 서비스 + 향후 유료 앱 전환** 구조를 설명합니다.
결제 사업자만 연결하면 바로 유료화할 수 있도록, 요금제·권한·사용량·구독 상태를 한 곳에서 관리합니다.

## 한눈에

| 계층 | 파일 | 역할 |
|---|---|---|
| 로그인 화면·게이트 | `index.html`(= `camp-kitchen.html`) 인라인 스크립트의 `AUTH` 블록 | 비로그인 시 앱 대신 로그인/회원가입 폼만 표시, 모든 `/api/*` 호출에 `Authorization: Bearer` 첨부 |
| 인증 API | `lib/auth-api.js`, `api/auth/[...route].js` | 가입·로그인·내 정보·닉네임·비밀번호·로그아웃·탈퇴 |
| 인증 로직 | `lib/auth/service.js` | 입력 검증, scrypt 비밀번호, 로그인 실패 제한(10분 10회) |
| 세션 토큰 | `lib/auth/token.js` | HS256 서명 JWT(30일). 키는 `AUTH_SECRET` 또는 서비스 계정에서 유도 |
| 회원 저장소 | `lib/auth/users-store.js` | 운영 Firestore `users/{uid}` · 로컬 `data/users.local.json` |
| API 보호 | `lib/auth/guard.js` | `withUserAuth()`(Vercel) · `expressUserAuth()`(로컬 Express) |
| 사용량 제한 | `lib/auth/quota.js` | 무료/유료 하루 한도 판정·기록(`users/{uid}.usage`) |
| 요금제·권한 정의 | `lib/plans.js` | **무료/프로 한도·기능 플래그의 유일한 정의** |
| 결제 어댑터 자리 | `lib/billing/provider.js` | 토스페이먼츠·Stripe 어댑터 계약(현재 미연결) |
| 구독 상태 반영 | `lib/billing/apply-subscription.js` | 웹훅 이벤트 → `users/{uid}` 패치 매핑 |
| 결제 API | `lib/billing-api.js`, `api/billing/[...route].js` | `status` · `checkout` · `portal` · `webhook` |
| 공개 헬스체크 | `lib/health-api.js`, `api/health.js` | Firestore 연결 확인(개인 데이터 없음) |
| 보안 규칙 | `firestore.rules` | 모든 컬렉션 클라이언트 직접 접근 차단(서버 전용) |
| 경로 해석 | `lib/route-segments.js` | 캐치올 함수 경로 → 라우터 segments (Vercel 함수 12개 제한 대응) |

## 회원 문서 스키마 — `users/{uid}`

`uid` 는 이메일에서 유도한 값(`u` + sha256 24자)이라 같은 이메일로 두 번 가입할 수 없습니다.

```jsonc
{
  "uid": "u64f482b2f9cea187398dd863",
  "email": "camp@example.com",
  "emailLower": "camp@example.com",
  "nickname": "춘학",
  "passwordHash": "scrypt1:<salt>:<hash>",   // 평문 저장 없음
  "plan": "free",                            // free | pro  (lib/plans.js)
  "status": "active",                        // active | trial | canceled | expired | past_due
  "role": "user",                            // user | admin (admin 은 한도 무제한)
  "usage": { "date": "2026-11-14", "ai": 3, "image": 1 },  // KST 날짜가 바뀌면 0으로 리셋
  "billingProvider": null,                   // toss | stripe …
  "customerId": null,
  "subscriptionId": null,
  "currentPeriodEnd": null,                  // ISO8601, 이 날짜가 지나면 무료 권한으로 내려감
  "trialEndsAt": null,
  "cancelAtPeriodEnd": false,
  "createdAt": "2026-11-14T04:55:28.407Z",
  "updatedAt": "2026-11-14T04:55:28.407Z",
  "lastLoginAt": "2026-11-14T04:55:28.407Z"
}
```

## 요금제 정의 (`lib/plans.js`)

| 항목 | FREE | PRO |
|---|---|---|
| 가격 | 0원 | 월 4,900원 |
| AI 메뉴 추천 | 하루 10회 | 하루 100회 |
| 요리 사진 생성 | 하루 5회 | 하루 30회 |
| 프리미엄 캠핑장·오지 스팟 | — | ✓ |
| 우선 지원 | — | ✓ |

- 한도를 바꾸려면 `PLANS.free.limits` / `PLANS.pro.limits` **한 곳만** 고치면 됩니다. 서버 제한과 화면 표시(남은 횟수·배지)가 함께 바뀝니다.
- 플랜을 늘릴 때는 `PLAN_IDS` 와 `PLANS` 에 항목을 추가하고 `planCatalog()` 가 자동으로 화면에 노출합니다.
- `role: "admin"` 계정은 한도 없이 씁니다(운영자 계정 지정용: Firestore 콘솔에서 `users/{uid}` 문서의 `role` 을 `admin` 으로 수정).

## 권한 계산 규칙

`resolveAccess()` 는 `plan` + `status` + `currentPeriodEnd` 로 "지금 실제 적용되는 플랜"을 계산합니다.

| 저장된 상태 | 실제 권한 |
|---|---|
| `plan:pro`, `status:active`, 기간 남음 | PRO |
| `plan:pro`, `status:active`, 기간 지남 | FREE (`subscription_ended`) |
| `plan:pro`, `status:trial`, `trialEndsAt` 남음 | PRO (`trial`) |
| `plan:pro`, `status:canceled`, 기간 남음 | PRO (`canceled_active`) — 해지해도 결제한 기간까지 사용 |
| `plan:pro`, `status:canceled`, 기간 지남 | FREE (`subscription_ended`) |
| `status:expired` / `past_due` | FREE (`expired` / `past_due`) |

유료 기간이 끝나도 **로그인은 유지되고 무료 기능은 계속** 쓸 수 있습니다(잠금이 아니라 다운그레이드).

## API 보호 범위

| 경로 | 로그인 |
|---|---|
| `GET /api/health` | 공개(헬스체크) |
| `POST /api/auth/signup`, `login` · `GET /api/auth/plans` | 공개 |
| `GET /api/billing/status` | 공개 |
| `GET/PATCH/POST/DELETE /api/auth/*` (me·profile·password·logout·account) | **필수** |
| `POST /api/sample`, `POST /api/generate-image` | **필수** + 하루 사용량 한도 |
| `POST /api/upload-image` | **필수** |
| `/api/secret-gardens*`, `/api/guestbook*`, `/api/visitor-stats` | **필수** |
| `POST /api/billing/checkout`, `portal` | **필수** |
| `POST /api/billing/webhook` | 공개(사업자 서명 검증) |

비로그인 호출은 `401 {"code":"auth_required"}` 로 답합니다.

**서버리스 함수 구성**: Vercel Hobby 플랜은 배포당 서버리스 함수가 12개까지입니다. 그래서 `/api/auth/*` 와 `/api/billing/*` 는 각각 `[...route].js` 한 파일, `/api/secret-gardens/*` 는 `[...path].js` 한 파일로 묶어 **총 11개 함수**로 배포합니다. 엔드포인트를 추가할 때는 새 파일을 만들지 말고 기존 라우터(`lib/auth-api.js` 등)에 경로를 더한 뒤 함수 수를 확인하세요.
`Uptime check`(`scripts/uptime-check.mjs`)는 이 401 응답을 **정상**으로 판정해(인증 가드가 켜져 있다는 증거) 대신 `/api/health` 로 Firestore 연결을 확인합니다.

## 유료화 켜는 순서 (결제 연동 체크리스트)

1. **사업자 선택**: 토스페이먼츠(국내·간편결제) 또는 Stripe(해외·구독 관리 기능이 강함).
2. **어댑터 구현**: `lib/billing/provider.js` 의 `BillingAdapter` 계약
   (`createCheckout` · `createPortal` · `verifyWebhook` · `parseEvent`)을 구현해 `PROVIDERS.toss` 또는 `PROVIDERS.stripe` 에 등록합니다.
3. **환경변수**: Vercel → Settings → Environment Variables 에 `BILLING_PROVIDER=toss`(또는 `stripe`)와 사업자 키를 등록하고 재배포합니다.
4. **웹훅 등록**: 사업자 콘솔에서 웹훅 URL 을 `https://camping-food-helper.vercel.app/api/billing/webhook` 으로 등록합니다.
   `subscription.activated / .updated / .canceled / .expired / payment.failed / .trial_started` 이벤트를 받습니다.
5. **가격·한도 확인**: `lib/plans.js` 의 `priceKRW`·`limits` 를 실제 판매 조건과 맞춥니다.
6. **검증**: 테스트 결제 → `users/{uid}` 에 `plan:pro`, `status:active`, `currentPeriodEnd` 가 들어오는지 확인 →
   `GET /api/auth/me` 의 `entitlements.pro === true` 확인 → 해지·실패 이벤트로 다운그레이드 확인.

연결 전에는 `POST /api/billing/checkout` 이 `503 billing_not_configured` 로 답하고, 화면의 **PRO 구독 시작** 버튼은 "결제 연결을 준비하고 있어요" 안내만 보여 줍니다(가짜 결제 없음).

## 화면

- **로그인/회원가입**: 앱 진입 시 비로그인이면 로그인·회원가입 폼만 보입니다(하단 탭·방문자 위젯 숨김).
  - 가입 항목: 닉네임, 이메일, 비밀번호(영문+숫자 8자 이상), 비밀번호 확인.
  - 오류 안내: 이미 가입된 이메일, 비밀번호 불일치, 로그인 실패, 시도 제한, 연결 실패 등을 한국어로 표시.
  - 세션 만료(401) 시 자동으로 로그인 화면으로 돌아갑니다.
- **플랜 배지**: 각 화면 상단 제목 옆에 `FREE` / `PRO` 배지.
- **내 정보 → 내 플랜 카드**: 현재 플랜, 상태(체험·해지 예약·다운그레이드 사유), 오늘 사용량/한도, 로그아웃, PRO 혜택과 **PRO 구독 시작** 버튼(결제 연결 시 결제 화면으로 이동), 구독 관리(PRO).
- **내 정보 → 계정 설정**: 닉네임 변경, 비밀번호 변경.

## 운영 주의

- **세션 키**: `AUTH_SECRET` 을 지정하지 않으면 서명 키를 `FIREBASE_SERVICE_ACCOUNT` 에서 유도합니다. 서비스 계정 키를 교체하면 기존 로그인 세션이 모두 만료됩니다(다시 로그인하면 됨). 세션을 키와 분리하려면 `AUTH_SECRET`(16자 이상)을 등록하세요.
- **이메일 인증·비밀번호 재설정 메일**: 아직 메일 발송이 연결되지 않았습니다. 비밀번호를 잊으면 로그인 후 [내 정보 → 계정 설정]에서 바꾸거나 운영자가 Firestore 문서를 갱신해야 합니다. 필요하면 같은 `lib/auth` 구조에 메일 발송(예: Resend·네이버 메일 SMTP)만 추가하면 됩니다.
- **로컬 개발**: `FIREBASE_SERVICE_ACCOUNT` 가 없으면 회원은 `data/users.local.json` 에 저장됩니다(저장소 제외). `npm run dev` 로 로그인·가입까지 그대로 시험할 수 있습니다.
- **테스트**: `scripts/test-auth.mjs` 가 토큰 위조·만료, 중복 가입, 로그인 실패 제한, 한도 초과, 플랜 다운그레이드, 웹훅 반영까지 검증합니다(`npm test` 포함).
