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
project_handover_document.md  # 인계서 (일부 내용이 실제 코드와 다름 – 아래 "주의" 참고)
```

## 외부 의존성 (CDN, index.html L15–18)

- Three.js **r128** (`three.min.js`) + `examples/js`의 `OrbitControls`, `GLTFLoader`, `OBJLoader`(로드만 하고 미사용).
- r128 기준 API를 쓴다: `renderer.outputEncoding = THREE.sRGBEncoding` 등. 버전을 올리면
  `outputColorSpace`, ES 모듈 import 방식 등 깨지는 부분이 많으니 **임의로 업그레이드하지 않는다.**

## index.html 스크립트 구조 (위에서 아래 순서)

| 영역 | 주요 심볼 |
| --- | --- |
| 공통 | `showToast`, `getLineBadgeClass`, `formatLineName` |
| 메인 노선도 | `MAP_SIZE`, `STATIONS_LIST`, `initStations`, `selectStation`, `onMainSearchInput`, `updateTransform`, `panToStation`, `handleMapClick` (CSS transform 기반 pan/zoom, 핀치줌) |
| 실내 상태 | `FIGMA_CATEGORIES`, `CATEGORY_THEMES`, `activeCategory`, `currentIndoorMode`("2D"/"3D"), `activeFloor`("B1"~"B4") |
| 좌표 변환 | `MODEL_BBOX`, `coord2Dto3D`, `coord3Dto2D` |
| 핀 DB | `STATION_PINS_DB` |
| 실내 UI | `enterIndoorView`, `exitIndoorView`, `renderExplorePinsList`, `toggleAiCapsule`, `handleAiSubmit`, `toggleSubpage` |
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
  category: "화장실",      // FIGMA_CATEGORIES 중 하나 (API 핀은 '기타'도 가능)
  desc: "상세 위치 설명",
  floor: "B1",            // "B1" ~ "B4"
  realX3d: 4.0,           // Three.js 월드 X (동서)
  realZ3d: -56.0,         // Three.js 월드 Z (남북)
  x: 171, y: 120,         // 2D 좌표 (360×520 기준, coord3Dto2D로 계산)
  y3d: null               // 선택. 없으면 getSurfaceHeightAt으로 바닥 스냅
}
```

- id 접두사 규칙:
  - `base_...` : 하드코딩된 기본 핀 (2호선 구역)
  - `sbd_...` : 신분당선 구역 실측 핀 (API가 제공하지 않는 구역)
  - `api_{operation}_{index}` : 서울교통공사 API로 생성된 핀. **갱신 시 `api_` 핀만 지우고 다시 채운다.**
  - 숫자(`Date.now()`) : 사용자가 직접 만든 핀
- 사용자 핀은 메모리에만 있고 **저장(localStorage/서버)되지 않는다.** 새로고침하면 사라진다.

### 카테고리 ↔ 3D 핀 모델

`PIN_3D_MODEL_MAP`에 6개 카테고리가 모두 등록돼 있다:
쓰레기통·엘리베이터·화장실·충전소·편의점·휴식 → `Pins/*_3d.glb`.
매핑이 없는 카테고리(예: '기타')는 `createFallbackGeometryPin`으로 기본 도형을 그린다.
3D 핀은 `Box3`로 최하단을 바닥에 맞추고 크기를 정규화한 뒤 `pin3DModelCache`에 캐시한다.

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

## AI 에이전트 (미구현)

- `handleAiSubmit(e)`는 현재 Enter 시 토스트만 띄운다. 백엔드 호출은 없다.
- 계획된 구조: 별도 백엔드(FastAPI)에 `{ 현재 역, activeFloor, 핀 목록 }` 컨텍스트를 보내고,
  `{ message, action, targetFloor, targetPinId }` 형태의 JSON을 받아
  `selectFloor(targetFloor)` → 해당 핀을 찾아 `focusOnPin(pin)` 순서로 지도를 제어한다.
- 백엔드 URL은 하드코딩하지 말고 파일 상단 상수 하나로 모은다.

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
