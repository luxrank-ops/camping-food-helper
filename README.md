# 캠핑음식 도우미

나 혼자 쓰는 캠핑 요리 도우미 웹앱과 기획안입니다.

- **바로 접속 주소 (Vercel)**: https://camping-food-helper.vercel.app/
- `캠핑음식앱_기획안.md`: 개인용 앱 기획안 (v0.4)
- `camp-kitchen.html` / `index.html`: 1단계 웹앱 (인원·장비 입력 → 맞춤 메뉴 추천 → 준비물 체크리스트, 요리 직접 지정)

## 캠핑지 날씨 · 인근 캠핑장 찾기 (2026-10-13 추가)

추천 탭의 **[캠핑지 찾기]** 카드에서 씁니다.

- **캠핑장 자동완성**: 이름·지역·초성(`ㅈㄹㅅ` → 자라섬)을 치면 캠핑장 후보를 제안합니다. [📍 내 위치]를 누르면 GPS 기준 반경 30km의 캠핑장을 **가까운 순서**로 보여주고, OpenStreetMap(실시간)에서 주변 야영지를 더 찾아 함께 붙여 줍니다. 목록에는 내 위치에서의 거리가 표시됩니다.
- **캠핑지 날씨**: 고른 캠핑지(또는 현재 위치)의 현재 기온·체감·강수확률·풍속·습도·일몰, 12시간 예보, 4일 예보를 가져옵니다. 키가 필요 없는 Open-Meteo를 씁니다.
- **날씨 맞춤 메뉴 자동 제안**: 비·눈·추위·쌀쌀·강풍·무더위·더위·좋음 8가지로 분류해 국물/한 냄비/짧은 조리 메뉴를 골라 줍니다. 메뉴를 누르면 준비물 목록까지 만들어지고, AI 추천·준비물 프롬프트에도 캠핑지와 날씨가 함께 들어갑니다(내 정보 탭에서 끌 수 있어요).
- **날씨 대비 준비물**: 타프·방수포·핫팩·방풍판·얼음 등을 체크리스트에 한 번에 추가합니다.
- **인터넷·위치가 막혀도**: [지금 날씨를 직접 고르기]로 조건만 골라 같은 맞춤 메뉴를 쓸 수 있고, 준비물 탭에는 저장된 예보가 남습니다.

### 데이터 출처

| 쓰임 | 자료 | 비고 |
|---|---|---|
| 캠핑장 이름·좌표 4,018곳 (`data/campgrounds.js`) | 한국관광공사 **고캠핑** 정보 (공공데이터포털) | 2024-09 스냅샷, `이름\|시군구\|시도코드\|위도,경도\|시설코드` 형식으로 압축 |
| 날씨 예보·지역 검색 | Open-Meteo | API 키 필요 없음 |
| 주변 야영지 실시간 보강 | OpenStreetMap Overpass API | 12시간 캐시, 실패해도 번들 데이터로 동작 |

`index.html`을 파일로 직접 열 때도 `data/campgrounds.js`가 같은 폴더에 있으면 자동완성이 동작합니다(없으면 실시간 검색과 직접 입력만 가능).

## 자동화 · 품질 검증

푸시와 PR마다 GitHub Actions가 검사를 돌리고, 배포는 Vercel이 `main` 머지 시 자동으로 합니다. 수동 배포는 없습니다.

### CI (`.github/workflows/ci.yml`)

| 잡 | 검사 내용 | 로컬 실행 |
|---|---|---|
| 백엔드 문법 검사 | `server.js`, `api/`, `lib/`, `scripts/` 문법 (`node --check`) | `node --check server.js` |
| 클라이언트 정적 스캔 | `index.html`, `camp-kitchen.html`, `data/*.js`에서 `process.env`, `require(`, `module.exports`, `__dirname` 같은 서버 전용 참조 검출. 주석은 무시합니다. | `npm run check:client` |
| HTML 유효성 | `html-validate`로 구조 오류 검사 | `npx html-validate@8.29.0 index.html camp-kitchen.html` |
| 의존성 취약점 | `npm audit --omit=dev --audit-level=high` (high 이상이면 실패) | — |

- 클라이언트 코드는 브라우저에 `process`가 없습니다. `process.env`를 쓰면 앱 전체가 멈추므로, 키 유무는 서버가 판단해서 503으로 알려주도록 되어 있습니다.
- `index.html`과 `camp-kitchen.html`은 같은 내용입니다. 한쪽을 고치면 다른 쪽도 같이 고치세요.

### 의존성 자동 업데이트 (`.github/dependabot.yml`)

- 매주 월요일 오전 9시(KST)에 npm 패키지와 GitHub Actions 버전을 점검해 PR을 만듭니다.
- 마이너·패치 업데이트는 한 PR로 묶고, 메이저 업데이트는 자동 PR에서 제외합니다(예: express 5.x). 보안 경고는 별도로 올라옵니다.

### 배포 (Vercel GitOps)

- `main`에 머지되면 Vercel이 프로덕션에 자동 배포합니다. 브랜치 푸시는 프리뷰 배포가 됩니다.
- 별도의 토큰이나 CLI 배포 단계는 필요 없습니다.

### 헬스체크 (`.github/workflows/uptime-check.yml`)

10분마다 아래 대상을 점검하고, 실패하면 텔레그램으로 알립니다.

| 대상 | 정상 기준 |
|---|---|
| https://camping-food-helper.vercel.app/ | HTTP 200 |
| `POST /api/sample`, `POST /api/generate-image` | 빈 요청에 HTTP 400 (프롬프트 없음 → Gemini를 호출하지 않아 쿼터를 쓰지 않음) |
| Open-Meteo 날씨 API | HTTP 200 + 현재 기온 값 존재 |

- 응답이 5초를 넘거나 연결이 실패하면 장애로 봅니다. 한 번 더 확인한 뒤에도 실패해야 알림을 보냅니다.
- 실패한 실행은 GitHub Actions 실패 메일도 보냅니다.

**텔레그램 알림 설정 (한 번만)**

1. 텔레그램에서 `@BotFather`로 봇을 만들고 토큰을 받습니다.
2. 만든 봇에게 아무 메시지나 보낸 뒤 `https://api.telegram.org/bot<토큰>/getUpdates`에서 `chat.id` 값을 확인합니다.
3. GitHub 저장소 **Settings → Secrets and variables → Actions**에 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`를 추가합니다.

시크릿이 없으면 점검은 계속 돌고 알림만 건너뜁니다.

## 참고

- 웹앱의 AI 추천 기능은 Claude의 아티팩트 환경에서만 동작합니다. 이 저장소의 파일을 다른 곳에서 열면 화면은 보이지만 추천 버튼은 쓸 수 없습니다.
- 이 저장소는 백업과 버전 기록용입니다. 실제로 쓰는 앱은 Claude에 게시된 아티팩트입니다.
