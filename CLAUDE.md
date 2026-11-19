# CLAUDE.md

이 파일은 `sub note`(서울 지하철 실내 내비게이션 PWA) 저장소에서 작업할 때 참고하는 가이드다.
사용자와의 대화는 **한국어**로 한다. 코드 주석도 기존 스타일대로 한국어로 작성한다.

## 프로젝트 요약

- 서울 지하철 노선도(2D) → 역 선택 → 강남역 실내 지도(2D 탑뷰 / 3D 쿼터뷰)로 진입하는 모바일 퍼스트 웹앱.
- 빌드 도구·번들러·패키지 매니저 **없음**. 순수 HTML/CSS/Vanilla JS 단일 페이지.
- 배포: GitHub Pages (`origin` = `https://github.com/JHB-0613/maptest.git`, 브랜치 `main`).
- 현재 실내 지도는 **강남역만** 지원한다 (`selectStation`에서 `name.includes("강남")`일 때만 실내 진입 버튼 활성화).

## 실행 방법

`.glb` 로딩과 서비스 워커 때문에 `file://`로는 동작하지 않는다. 반드시 로컬 HTTP 서버로 연다.

```bash
python -m http.server 8080   # http://localhost:8080
# 또는
npx serve .
```

테스트·린트 설정은 없다. 변경 후에는 브라우저에서 직접 확인한다
(콘솔 에러, 2D↔3D 전환, B1~B4 층 전환, 핀 목록/포커싱, 모바일 폭 412px).

## 파일 구조

```text
index.html          # 앱 전체 (약 2,900줄): <style> L20–869, 마크업, <script> L1090–2875
manifest.json       # PWA 매니페스트 (아이콘은 logo/subnote.png 하나를 192/512에 공용 사용)
sw.js               # 서비스 워커 – 네트워크 우선, 실패 시 caches.match (실제로 캐시에 넣는 코드는 없음)
stations.json       # 노선도 역 메타데이터 (좌표, 노선, queryTerm)
metroimg.svg        # 메인 노선도 SVG (약 4MB, 2000×2000 좌표계 = MAP_SIZE)
logo/subnote.png    # 헤더 로고 겸 앱 아이콘
Pins/               # 카테고리별 2D 아이콘(PNG) + 3D 핀 모델(GLB)
models/gangnam/     # gangnam_B1~B4.glb 층별 실내 모델
README.md           # API 연동·좌표계 상세 문서
schemas/ai-chat.v0.json  # AI 대화 통신 규격 (JSON Schema)
worker/subnote-proxy.js  # Cloudflare Worker 코드 사본 (공공데이터 중계만). 수정 후 대시보드에 붙여넣고 Deploy해야 반영됨
ai-backend/              # AI 대화 백엔드 (Vercel 서울 리전). lib/ai-chat.js 로직, api/chat.js 진입점
project_handover_document.md  # 인계서 (일부 내용이 실제 코드와 다름 – 아래 "주의" 참고)
```

## 외부 의존성 (CDN, index.html `<head>`의 Three.js 스크립트)

- Three.js **r128** (`three.min.js`) + `examples/js`의 `OrbitControls`, `GLTFLoader`.
  각 `<script>`에 `integrity`(sha384, SRI)·`crossorigin`·`referrerpolicy`가 있다. **CDN 주소·버전을 바꾸면 해시를 다시 계산해야 한다**
  (`openssl dgst -sha384 -binary 파일 | openssl base64 -A`). 해시가 안 맞으면 스크립트가 차단돼 3D가 통째로 안 뜬다.
- r128 기준 API를 쓴다: `renderer.outputEncoding = THREE.sRGBEncoding` 등. 버전을 올리면
  `outputColorSpace`, ES 모듈 import 방식 등 깨지는 부분이 많으니 **임의로 업그레이드하지 않는다.**

## index.html 스크립트 구조 (위에서 아래 순서)

| 영역 | 주요 심볼 |
| --- | --- |
| 공통 | `showToast`, `getLineBadgeClass`, `formatLineName` |
| 메인 노선도 | `MAP_SIZE`, `STATIONS_LIST`, `initStations`, `selectStation`, `onMainSearchInput`, `updateTransform`, `panToStation`, `handleMapClick` (CSS transform 기반 pan/zoom, 핀치줌) |
| 실내 상태 | `PIN_CATEGORY_GROUPS`, `CATEGORY_EMOJI`, `normalizeCategory`, `getCategoryGroup`, `activeGroup`, `activeCategory`, `currentIndoorMode`("2D"/"3D"), `activeFloor`("B1"~"B4") |
| 좌표 변환 | `MODEL_BBOX`, `coord2Dto3D`, `coord3Dto2D` |
| 핀 DB | `STATION_PINS_DB` |
| 실내 UI | `enterIndoorView`, `exitIndoorView`, `renderExploreFilters`, `pinMatchesFilter`, `renderExplorePinsList`, `toggleAiCapsule`, `handleAiSubmit`, `toggleSubpage` |
| 카메라 | `setIndoorMode`, `setCameraToTopDownView`, `syncCameraToIsometricView`, `transitionCamera`(rAF 애니메이션, 연타 시 `cancelAnimationFrame`으로 인터럽트), `clampTopDownPan`, `update2DPinsScaling` |
| Three.js | `initThreeScene`, `loadFloorGlbModel`, `selectFloor`, `getSurfaceHeightAt`(Raycaster로 바닥 높이) |
| 핀 렌더링 | `syncPinsTo3D`, `PIN_3D_MODEL_MAP`, `getPinTexture`, `create2DTopViewPin`, `create3DIsometricPin`, `createFallbackGeometryPin`, `focusOnPin`, `setup3DInteraction` |
| 핀 편집 | `openCreatePinModal`, `openViewPinModal`, `saveCurrentPin`, `deleteCurrentPin` |
| 공공데이터 | `convertGeoToThreeCoord`, `GANGNAM_EXIT_ZONES`, `mapFacilityToCategory`, `extractFloorFromItem`, `estimateGangnamCoords`, `fetchAndGenerateApiPins` |
| 기타 | `enableFullScreenOnMobile`, 서비스 워커 등록 |

함수가 대부분 전역이고 HTML `onclick`/`onkeydown` 속성에서 직접 호출된다. 함수 이름을 바꾸면 마크업의 호출부도 같이 고친다.

## 데이터 모델

### 핀 객체 (`STATION_PINS_DB["강남역"]` 배열 원소)

```js
{
  id: 'base_b1_1',        // 접두사로 출처 구분 (아래 참고)
  title: "중앙 화장실",
  category: "화장실",      // PIN_CATEGORY_GROUPS의 카테고리 중 하나 (없으면 '기타')
  desc: "상세 위치 설명",
  floor: "B1",            // "B1" ~ "B4"
  realX3d: 4.0,           // Three.js 월드 X (동서)
  realZ3d: -56.0,         // Three.js 월드 Z (남북)
  x: 171, y: 120,         // 2D 좌표 (360×520 기준, coord3Dto2D로 계산)
  y3d: null,              // 선택. 없으면 getSurfaceHeightAt으로 바닥 스냅
  photo: "data:image/jpeg;base64,..."  // 선택. 핀 사진 (아래 참고)
}
```

- `photo`(선택): 핀 등록·수정 모달의 사진 칸에서 고르면 `resizeImageFile`이 긴 변 1024px JPEG(품질 0.8)로 줄여
  data URL로 담는다. 미리 넣는 사진은 파일 경로(예: `photos/gangnam/<id>.jpg`)를 적어도 된다.
  표시 위치: 핀 모달 미리보기, 탐색 목록 썸네일, AI 답변 핀 카드(사진이 있으면 아이콘 대신 사진).
  **AI 요청에는 사진을 보내지 않는다** (`buildAiRequest`가 필요한 필드만 고름). 다른 사용자 핀 정보처럼 메모리에만 있다.

- id 접두사 규칙:
  - `base_...` : 하드코딩된 기본 핀 (2호선 구역)
  - `sbd_...` : 신분당선 구역 실측 핀 (API가 제공하지 않는 구역)
  - `api_{operation}_{index}` : 서울교통공사 API로 생성된 핀. **갱신 시 `api_` 핀만 지우고 다시 채운다.**
  - 숫자(`Date.now()`) : 사용자가 직접 만든 핀
- 사용자 핀은 메모리에만 있고 **저장(localStorage/서버)되지 않는다.** 새로고침하면 사라진다.

### 카테고리 (층 → 상황 → 시설)

강남역 핀 탐색 패널은 **층 → 상황 그룹 → 시설 카테고리** 순으로 거른다. 정의는 `PIN_CATEGORY_GROUPS` 하나에 모여 있다.

| 상황 그룹 | 카테고리 |
| --- | --- |
| 🚨 비상시 | AED, 소화전, 비상전화, 휴대용 비상손전등, 구호용품 보관함, 비상용 모래함 |
| 🚇 이동·탑승 | 출입구, 개찰구, 탑승구, 엘리베이터, 에스컬레이터, 계단 |
| 🚻 편의시설 | 화장실, 벤치, 쓰레기통, 충전기, 물품보관함, 공중전화 |
| 🛍️ 상가·음식 | 상가, 자판기 |
| 🎫 표·금융 | 표사는 곳, ATM기 |
| 📍 기타 | 기타 (고객안전실·수유실·무인민원발급기 등 목록에 없는 시설) |

- 카테고리 비교는 항상 `normalizeCategory()`를 거친다. 예전 이름(충전소→충전기, 편의점→상가, 휴식→벤치, AD→AED)은
  `LEGACY_CATEGORY_MAP`으로 바뀌고, 목록에 없는 이름은 '기타'가 된다.
- 지도에 보이는 핀도 탐색 패널 필터(`pinMatchesFilter`)를 따른다 (`syncPinsTo3D`).
- 아이콘: 전용 PNG/GLB는 화장실·충전기·엘리베이터·상가·벤치·쓰레기통 6개뿐 (`PIN_2D_IMAGE_MAP`, `PIN_3D_MODEL_MAP`).
  나머지는 2D에서 `getEmojiPinTexture`(그룹 색 원 + 이모지 캔버스), 3D에서 `createFallbackGeometryPin`(그룹 색)으로 그린다.
  전용 아이콘을 추가하면 두 맵에 카테고리 이름으로 등록만 하면 된다.
- 3D 핀은 `Box3`로 최하단을 바닥에 맞추고 크기를 정규화한 뒤 `pin3DModelCache`에 캐시한다.
- 공공데이터 오퍼레이션 → 카테고리: 엘리베이터·에스컬레이터·화장실·ATM기·물품보관함·표사는 곳(승차권발매기),
  수유실·고객안전실·무인민원발급기는 '기타'.

## 좌표계

- 강남역 모델 바운딩 박스: `MODEL_BBOX = { centerX: 6.9, centerZ: 0.0, width: 120, depth: 240 }`.
- X: 음수 = 서쪽(교대, 7–10번 출구), 양수 = 동쪽(역삼, 1·2·11·12번 출구).
- Z: 약 -115 ~ -50 = 2호선 구역(북), -20 ~ +70 = 환승통로, +70 ~ +105 = 신분당선 남측 대합실.
- Y는 하드코딩하지 않는다. `getSurfaceHeightAt(x3d, z3d)`가 현재 층 모델 표면에 맞춘다.
- 위경도 → 월드 좌표: `convertGeoToThreeCoord(lat, lng)`에 **아핀 계수가 숫자로 하드코딩**돼 있다.
  위경도가 없는 API 항목은 `estimateGangnamCoords`가 설명 텍스트의 키워드(출구 번호, 역삼/교대, 개찰구 등)를
  `GANGNAM_EXIT_ZONES`와 매칭해 좌표를 정한다.
- 2D 좌표(360×520)와 3D 좌표 변환은 `coord2Dto3D` / `coord3Dto2D`로만 한다.

## 공공데이터 API

- 서울교통공사 편의시설위치정보 (`https://apis.data.go.kr/B553766/facility/{op}`).
- `fetchAndGenerateApiPins("강남")`이 `enterIndoorView()` 이후 1회 호출되어 9개 오퍼레이션을 `Promise.all`로 병렬 호출.
- 이 API는 **2호선 구역만** 데이터를 준다. 신분당선 구역은 `sbd_` 핀으로 유지한다.
- 브라우저는 Cloudflare Worker 프록시(`PROXY_URL`, `<script>` 맨 위 상수)의 `/facility/{op}`를 호출한다.
  인증키는 Worker의 Secret `API_KEY`에만 있다. **프론트 코드·README에 키를 다시 넣지 않는다.**
  Worker는 `getFc*` 경로만 중계하고, CORS 허용 Origin은 `https://jhb-0613.github.io`, `http://localhost:8080`이다
  (다른 포트로 띄우면 CORS로 막힌다).
- ⚠️ 예전 키는 git 기록에 남아 있다(공개 저장소). 재발급 시 Cloudflare의 `API_KEY` 값만 바꾸면 된다.

## AI 대화 (Gemini 연결됨)

- 통신 규격: `schemas/ai-chat.v0.json` (JSON Schema, 현재 `schemaVersion` "0.4"). **규격을 바꾸면 이 파일을 먼저 고친다.**
  - 규칙: 필드는 추가만 / 받는 쪽은 모르는 필드·모르는 `actions[].type`을 무시 / 응답 필수 필드는 `reply.text`뿐.
  - 요청: `{ schemaVersion, message, history[], context: { currentStation, indoor: {activeFloor, mode} | null, categoryGroups[], pins[] } }`
    (pins는 **화면과 무관하게 항상 강남역 핀**, 좌표 없이 id/title/category/group/desc/floor만. categoryGroups는 `PIN_CATEGORY_GROUPS`).
  - 응답: `{ schemaVersion, aboutStation, intent, reply: {text, blocks[]?, sources[]?, searchSuggestionHtml?}, route: {from,to,steps[]} | null, actions[] }`.
    `intent` = route_plan | station_info | pin_locate | general.
  - **답변 블록(`reply.blocks`, 0.4)**: paragraph / steps(번호 목록) / bullets / table / callout(info·warning·emergency) / pins(핀 카드).
    앱은 블록이 있으면 `renderAiBlocks`로 그리고 `reply.text`(1~2문장 요약, 서식 없음)는 숨긴다. 글은 전부 textContent로 넣고
    `**굵게**`만 `<strong>`으로 바꾼다 (`appendInlineText`) — **innerHTML로 AI 글을 넣지 않는다.**
  - 블록 출처: 1단계는 스키마 강제로 AI가 직접, 2단계(웹 검색)는 마크다운 일부로 받아 `markdownToBlocks`로 변환.
    서버 보정: `sanitizeBlocks`(개수·길이 제한, 없는 핀 제거), 경로가 있으면 steps 블록 제거(화면이 route를 따로 그림),
    `ensurePinCards`(강남역 핀 안내인데 카드가 없으면 같은 시설 핀을 같은 층 우선 최대 4개, '기타'는 안내 핀만),
    119 안내가 있으면 emergency 상자로.
  - route는 `renderRouteSteps`가 종류별 아이콘 + 노선 배지(`getLineBadgeClass`) + 세로 연결선으로 그린다.
  - actions: `focus_pin`(pinId, floor) — 핀으로 이동, `show_category`(group, category|null) — 지도·탐색 패널을 그 상황/시설로 거름.
    서버는 각각 최대 1개만 보내고, show_category의 category가 비면 focus_pin 핀의 시설로 채운다.
    프론트(`applyAiActions`)는 focus 핀이 필터에 안 맞으면 필터를 건너뛴다.
- 백엔드 주소: `<script>` 맨 위 `AI_CHAT_URL` = `https://subnote-ai.vercel.app/api/chat`.
  **비우면 `mockAiChat`(키워드 매칭 목업)이 응답한다** (AI 없이 UI 개발할 때).
- 백엔드: `ai-backend/` (Vercel 프로젝트 `subnote-ai`, 리전 **서울 `icn1`** 고정, `maxDuration` 60초).
  - 로직은 `ai-backend/lib/ai-chat.js`, 진입점은 `ai-backend/api/chat.js`. 배포: `ai-backend`에서 `npx vercel deploy --prod --yes`.
  - 환경변수(Vercel → Settings → Environment Variables, **추가·변경 후 재배포 필요**): `GEMINI_API_KEY`(사용 중),
    `AI_PROVIDER`(gemini|openai, 선택), `GEMINI_MODEL`(기본 gemini-3.8-flash), `GEMINI_THINKING_LEVEL`(기본 low), `GEMINI_WEB_SEARCH`(off면 검색 끔),
    `OPENAI_API_KEY` / `OPENAI_MODEL`(OpenAI 전환 시).
  - 두 공급자 모두 JSON 스키마를 강제해 `{intent, replyText, route, actions}`를 받고, `toChatResponse`가 규격 응답으로 변환하며
    없는 pinId를 지운다. 공급자를 바꿔도 프론트는 수정하지 않는다.
  - ⚠️ **AI 호출을 Cloudflare Worker로 옮기지 않는다.** 한국 요청이 Cloudflare 홍콩(HKG)을 거치면 Gemini가
    "User location is not supported"로 거절한다 (Placement Hint·AI Gateway로도 해결 안 됨. OpenAI도 홍콩 차단).
  - thinking 수준을 높이면 경로 질문이 30초를 넘길 수 있다 (low 기준 약 2~4초).
- **처리 경로는 두 가지다 (`aboutStation`으로 갈린다).**
  - 강남역 질문 → 분류 체계 + 핀 데이터에서 찾는다 (웹 검색은 핀에 없는 비(非)비상 정보일 때만).
  - 다른 역 질문 → 분류 체계·핀을 쓰지 않고 웹 검색으로 답한다. 시설·역 정보 질문(`intent` station_info/pin_locate)은
    AI가 `needsWebSearch`를 빼먹어도 서버가 강제로 검색한다 (예전에 "신논현역 AED"를 추측으로 답한 사례).
- **핀은 강남역 질문에만 쓴다.** 1단계 응답의 `aboutStation`이 강남역(강남구청 제외)이 아니면 서버가 actions·step.pinId를 버린다.
- **강남역 시설 찾기는 분류 체계(층 → 상황 → 시설)를 따른다.** 지침(`buildSystemPrompt`)에 분류 체계와
  `formatPinsByCategory`로 정리한 핀 목록(핀 없는 시설은 "등록된 핀 없음")을 넣고, AI가 질문을 상황·시설로 바꿔
  (예: 쓰러짐 → 비상시>AED, 목마름 → 상가·음식) 현재 층 우선으로 핀을 고른다. 비상시는 119·역무원 안내를 먼저, 웹 검색 없이.
  분류를 바꾸면 앱의 `PIN_CATEGORY_GROUPS`만 고치면 된다 (요청에 실려 가므로 백엔드 수정 불필요).
  지침이 길어져 강남역 질문은 약 5~6초 걸린다.
- **다른 역/외부 정보는 웹 검색(2단계)으로 답한다.**
  - 1단계: JSON 스키마 강제로 `{aboutStation, needsWebSearch, intent, replyText, route, actions}` 결정 (약 2초).
  - 2단계: `needsWebSearch=true`일 때만 `searchAnswer`가 Google 검색 그라운딩(`tools: [{google_search:{}}]`, 형식 강제 없음)으로
    답변 글을 다시 만들고 `reply.sources`(출처)·`reply.searchSuggestionHtml`(Google 검색 제안)을 붙인다. 실패하면 1단계 초안 유지.
  - ⚠️ 검색 도구와 responseSchema를 한 요청에 같이 주면 Gemini가 **에러 없이 검색을 건너뛴다**. 둘을 합치지 않는다.
  - 검색 제안(`searchSuggestionHtml`)은 Google 약관상 표시 필수 → 프론트 `renderSearchSuggestion`이 Shadow DOM에 넣는다.
  - 검색 비용: Gemini 3+는 검색 쿼리당 과금 (월 5,000회 무료 후 1,000회당 $14). 검색 질문은 약 7~10초.
- 흐름: `handleAiSubmit` → `buildAiRequest` → `requestAiChat` → `normalizeAiResponse` → `renderAiReply`(답변 패널 `#ai-reply-panel`) → `applyAiActions` → `focusAiPin`.
- 다른 층 핀으로 포커스할 때는 `pendingFocusPin`에 예약하고 `loadFloorGlbModel` 로드 완료 후 `focusOnPin`한다
  (로드 콜백이 카메라를 초기화하기 때문).
- 백엔드는 AI가 낸 `pinId`가 요청 `context.pins`에 있는지 검증해야 한다 (프론트도 없는 핀은 무시한다).
- AI 캡슐바는 현재 실내 화면에만 있다. 노선도 화면에서 경로 질문을 받으려면 UI 추가가 필요하다.

## 작업 규칙

- `index.html` 하나에 모든 것이 들어 있으므로, 수정 전에 해당 함수 위치를 `grep`으로 찾고 그 부분만 고친다. 파일 전체를 다시 쓰지 않는다.
- 새 에셋은 기존 폴더 규칙을 따른다: 2D 아이콘 `Pins/<Name>.png`, 3D 핀 `Pins/<name>_3d.glb`, 층 모델 `models/<역>/<역>_B<n>.glb`.
- 모바일 레이아웃(412px 목업 프레임 / 실제 모바일 `100dvh` 풀스크린) 둘 다 깨지지 않게 확인한다.
- 3D 코드 수정 후에는 2D↔3D 빠른 연타 전환, 층 전환 후 핀 높이 스냅, 줌아웃 시 2D 핀 크기(`1/zoom` 스케일)를 확인한다.
- 커밋·푸시는 사용자가 요청할 때만 한다. 커밋 메시지는 무엇을 바꿨는지 구체적으로 쓴다 ("Update index.html" 지양).

## 인계서와 실제 코드의 차이 (주의)

`project_handover_document.md`의 다음 내용은 현재 코드와 다르다:

- `GANGNAM_ANCHOR` 상수는 **존재하지 않는다** (계수 하드코딩 방식).
- `PIN_3D_MODEL_MAP` 전체 등록과 `sRGBEncoding` 적용은 **이미 완료**됐다. 남은 건 조명 밝기 미세 조정
  (현재 Ambient 0.85, Directional 0.8 / 0.3).
- `logo/icon-512.png`, `logo/icon-192.png`, `metroimg.jpg`는 **없다**.
- `sw.js`는 오프라인 캐시를 실제로 하지 않는다.

## 도구 추천 (설치 보류 중)

ECC(everything-claude-code)는 아직 설치하지 않았다. 아래 상황이 되면 작업 전에 사용자에게 설치를 한 번 제안한다 (같은 대화에서 반복하지 않는다).
- API 키·CORS·Worker·AI 백엔드 프롬프트 등 보안 관련 수정 → security-reviewer (`/security-scan`)
- 함수 이름 변경이나 여러 함수에 걸친 큰 수정, 커밋 직전 → code-reviewer (`/code-review`)
- 다른 역 추가, 노선도 화면 AI UI처럼 여러 단계로 나뉘는 기능 → planner (`/plan`)
- 수동 확인(2D↔3D, B1~B4, 412px)을 자동화하고 싶다고 할 때 → e2e-runner (`/e2e`)
- 성능·접근성·PWA 개선 → Modern Web Guidance

설치는 이 프로젝트의 `.claude/`에만 한다 (`~/.claude` 전역 설치 금지 — IISD 과제 규칙과 충돌).
