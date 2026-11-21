# sub note - 서울 지하철 스마트 실내 내비게이션 & 3D 맵

> 서울 지하철 강남역을 중심으로 실내 3D/2D 내비게이션, 공공데이터포털 실시간 편의시설 API 연동, 층별 시설물 탐색, AI 대화 안내 기능을 제공하는 웹앱입니다.
> 배포: GitHub Pages (`https://jhb-0613.github.io/maptest/`)

---

## 📌 목차
1. [프로젝트 개요 및 기술 스택](#1-프로젝트-개요-및-기술-스택)
2. [공공데이터포털 API 연동 내역](#2-공공데이터포털-api-연동-내역)
3. [강남역 3D 모델 및 좌표계 구조](#3-강남역-3d-모델-및-좌표계-구조)
4. [층별 시설물 데이터 및 보강 내역](#4-층별-시설물-데이터-및-보강-내역)
5. [핀 분류 체계](#5-핀-분류-체계)
6. [AI 대화 안내](#6-ai-대화-안내)
7. [다른 컴퓨터에서 개발 및 실행 가이드](#7-다른-컴퓨터에서-개발-및-실행-가이드)
8. [주요 파일 구조](#8-주요-파일-구조)

---

## 1. 프로젝트 개요 및 기술 스택

* **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+)
* **3D 렌더링**: [Three.js](https://threejs.org/) (r128), OrbitControls, GLTFLoader
* **2D 탑뷰 & 3D 뷰 전환**: `currentIndoorMode` ("2D" / "3D")
* **PWA 지원**: `manifest.json`, `sw.js` (홈 화면 추가용. 서비스 워커는 네트워크 우선이며 **오프라인 캐시는 하지 않음**)
* **모바일 반응형 최적화**: 412px 모바일 목업 컨테이너 및 실제 모바일 브라우저 풀스크린 지원
* **공공데이터 중계**: Cloudflare Worker (`worker/subnote-proxy.js`) – 인증키를 Worker Secret에만 보관
* **AI 대화 백엔드**: Vercel 서버리스 함수 (`ai-backend/`, 서울 리전 `icn1`) + Google Gemini (Google 검색 그라운딩)
* **빌드 도구 없음**: 번들러·패키지 매니저 없이 정적 파일 그대로 배포

---

## 2. 공공데이터포털 API 연동 내역

### 1) 서비스 개요
* **제공 기관**: 서울교통공사 (`B553766`)
* **데이터셋 명칭**: [서울교통공사_편의시설위치정보](https://www.data.go.kr/data/15143841/openapi.do) (데이터셋 ID: `15143841`)
* **기본 엔드포인트**: `https://apis.data.go.kr/B553766/facility/{operation}`

### 2) 호출 중인 9개 핵심 오퍼레이션
실시간으로 강남역(`stnNm=강남`)의 모든 편의시설을 병렬(`Promise.all`)로 수신합니다:
1. `getFcElvtr`: 엘리베이터 (외선 8-1, 내선 3-4, 1번 출구, 10번 출구 등 4대)
2. `getFcEsctr`: 에스컬레이터
3. `getFcRstrm`: 대합실 화장실 (2호선 중앙 개찰구 안쪽 화장실)
4. `getFcAtm`: ATM / 현금지급기 (1·12번 출구 사이, 7·10번 출구 사이, 2번 출구 방면 3곳)
5. `getFcLckr`: 물품보관함 T-Locker (1번 출구 통로, 1·12번 출구 통로 상가 맞은편)
6. `getFcNrsrm`: 수유실 (B1 고객안전실 앞)
7. `getFcCstct`: 고객안전실 (B1 대합실)
8. `getFcAtdspnr`: 무인민원발급기 (B1 대합실)
9. `getFcTkatm`: 승차권자동발매기 (3대) 및 교통카드 키오스크 (3대)

### 3) API 키 설정 위치
인증키는 프론트엔드 코드에 두지 않는다. 브라우저는 Cloudflare Worker 프록시(`subnote-proxy`)를 호출하고,
Worker가 Secret으로 저장된 `API_KEY`를 붙여 공공데이터포털에 요청을 전달한다.

```javascript
// index.html <script> 상단
const PROXY_URL = "https://subnote-proxy.skdlxm1412.workers.dev";

// 호출 예: ${PROXY_URL}/facility/getFcRstrm?dataType=JSON&pageNo=1&numOfRows=100&stnNm=강남
```

* 키 변경: Cloudflare 대시보드 → Workers & Pages → `subnote-proxy` → Settings → Variables and Secrets → `API_KEY` 값만 수정 (코드 수정 불필요)
* 허용 Origin: `https://jhb-0613.github.io`, `http://localhost:8080` (Worker 코드에서 관리)

### 4) 데이터 변환 및 매핑 원리
* **층수 감지 (`extractFloorFromItem`)**: `stnFlr`, `bgngFlr`, `endFlr` 및 위치 설명 텍스트에서 `B1`, `B2`, `B3`, `B4` 정규식 추출
* **위·경도 GPS ➡️ 3D 좌표 변환 (`convertGeoToThreeCoord`)**:
  실측 앵커 포인트로 구한 아핀 변환 계수를 코드에 숫자로 넣어 사용
  ```javascript
  const x3d = 19993.0 * lat + 38722.3 * lng - 5668509.5;
  const z3d = -61998.7 * lat - 7006.3 * lng + 3214763.3;
  ```
* **출구 및 위치 설명 텍스트 기반 3D 매핑 (`estimateGangnamCoords`)**:
  위경도 값이 없는 시설물은 상세 위치 텍스트(`dtlPstn`, `vcntEntrcNo`)에서 출구 번호(1~12번), 승강장 방면(역삼/교대), 개집표기, 고객안전실 키워드를 매칭하여 해당 3D 좌표(`GANGNAM_EXIT_ZONES`)로 자동 배치

---

## 3. 강남역 3D 모델 및 좌표계 구조

### 1) 층별 GLB 모델 파일 (`models/gangnam/`)
* `gangnam_B1.glb`: 지하 1층 대합실 및 환승통로 (전체 폭: X 118m, 깊이: Z 240m)
* `gangnam_B2.glb`: 지하 2층 2호선 승강장 및 신분당선 환승통로
* `gangnam_B3.glb`: 지하 3층 신분당선 대합실 및 개찰구
* `gangnam_B4.glb`: 지하 4층 신분당선 승강장

### 2) 좌표축 방향 정의
* **X축 (동서 방향)**:
  * `-52.0 ~ -35.0`: 서쪽 (교대 방면, 7·8·9·10번 출구)
  * `0.0`: 중앙 사거리 (강남역 중심 교차로)
  * `+20.0 ~ +66.0`: 동쪽 (역삼 방면, 1·2·11·12번 출구)
* **Z축 (남북 방향)**:
  * `-115.0 ~ -80.0`: 북쪽 (신논현 방면, 10·11번 출구)
  * `-70.0 ~ -50.0`: **2호선 본선 대합실 및 승강장**
  * `-20.0 ~ +70.0`: 2호선 ↔ 신분당선 환승통로
  * `+70.0 ~ +105.0`: **신분당선 남측 대합실 및 3·4·5·6번 출구**
* **Y축 (높이)**:
  * Three.js Raycaster 기반 `getSurfaceHeightAt(x3d, z3d)` 함수를 통해 모델 바닥 슬래브 표면 높이에 핀이 자동 스냅

### 3) 전체 바운딩 박스 (`MODEL_BBOX`)
```javascript
const MODEL_BBOX = {
  centerX: 6.9,
  centerZ: 0.0,
  width: 120.0,
  depth: 240.0
};
```

### 4) 카메라 뷰포트 센터링 최적화
* **B1, B2 (2D 탑뷰)**: 상단(2호선)과 하단(신분당선) 전체를 한 화면에 조망할 수 있도록 `targetZ: -10.0`, `targetViewWidth: 100` 설정
* **B3, B4 (신분당선 전용층)**: 신분당선 승강장/대합실에 포커싱되도록 `targetX: -13.0`, `targetZ: 40.0`, `targetViewWidth: 75` 자동 전환

---

## 4. 층별 시설물 데이터 및 보강 내역

> **중요 안내**: 서울교통공사 API(`B553766`)는 **2호선 구역(B1 상단부, B2 2호선 승강장)**만 데이터를 제공합니다.
> 신분당선 관할 구역(B1 하단부 통로, B2 하단 환승통로, B3 대합실, B4 승강장)은 실측 데이터를 기반으로 고유 핀(`sbd_...`)으로 탑재되어 있으며, 실시간 API 핀 갱신 시에도 지워지지 않고 보존됩니다.

### 층별 배치 현황
| 층수 | 구역 | 주요 시설물 핀 |
| :--- | :--- | :--- |
| **B1** | 2호선 대합실 (상단부) | 기본 핀: 중앙 화장실, 휴대폰 급속 충전소, GS25 편의점 / 실시간 API: 중앙 화장실, 1번·10번 출구 외부 EV, ATM 3곳, T-Locker 보관함 2곳, 수유실, 고객안전실, 무인민원발급기, 승차권 발매기 3대, 교통카드 키오스크 3대 |
| **B1** | 신분당선 통로·출구 (하단부) | 신분당선 대합실 화장실, 4번 출구 EV, 5번 출구 EV, 신분당선 T-Locker, ATM/충전기, 스토리웨이 편의점, 3번·6번 출구 쉼터 벤치 |
| **B2** | 2호선 승강장 (상단부) | 기본 핀: 승강장 엘리베이터, 쉬어가는 벤치 / 실시간 API: 2호선 외선(역삼 방면 8-1) 승강기, 내선(교대 방면 3-4) 승강기 |
| **B2** | 신분당선 통로 (하단부) | B1↔B2 환승통로 승강기, 환승통로 1·2구역 휴식 벤치, 음료 자동판매기, 남측 연결 쉼터 |
| **B3** | 신분당선 대합실 | 신분당선 화장실, B3↔B4 상·하행 승강기 2기, 신분당선 고객안내센터, 교통카드 무인충전기, T-Locker 물품보관함 |
| **B4** | 신분당선 승강장 | 승강장 승강기 2기 (상행/하행), 휠체어 급속 충전소, 고객 대기 쉼터 벤치, 음료 자동판매기 |

> 표의 이름은 핀 제목이다. 핀의 시설 분류(카테고리)는 아래 5장 기준이다 (예: "휠체어 급속 충전소" → 충전기, "쉼터 벤치" → 벤치).

### 핀 id 규칙
| 접두사 | 의미 |
| :--- | :--- |
| `base_...` | 코드에 넣어 둔 2호선 구역 기본 핀 |
| `sbd_...` | 신분당선 구역 실측 핀 (API가 데이터를 주지 않는 구역) |
| `api_{오퍼레이션}_{번호}` | 서울교통공사 API로 만든 핀. 갱신할 때 이 핀만 지우고 다시 채움 |
| 숫자 (`Date.now()`) | 사용자가 직접 등록한 핀. 메모리에만 있어 새로고침하면 사라짐 |

---

## 5. 핀 분류 체계

강남역 핀 탐색 패널은 **층 → 상황 → 시설** 순으로 거른다. 정의는 `index.html`의 `PIN_CATEGORY_GROUPS` 하나에 있고,
지도에 보이는 핀도 이 필터를 따른다.

| 상황 | 시설 |
| :--- | :--- |
| 🚨 비상시 | AED, 소화전, 비상전화, 휴대용 비상손전등, 구호용품 보관함, 비상용 모래함 |
| 🚇 이동·탑승 | 출입구, 개찰구, 탑승구, 엘리베이터, 에스컬레이터, 계단 |
| 🚻 편의시설 | 화장실, 벤치, 쓰레기통, 충전기, 물품보관함, 공중전화 |
| 🛍️ 상가·음식 | 상가, 자판기 |
| 🎫 표·금융 | 표사는 곳, ATM기 |
| 📍 기타 | 기타 (고객안전실·수유실·무인민원발급기 등) |

* 예전 이름(충전소, 편의점, 휴식, AD)은 `normalizeCategory`가 지금 이름으로 바꾸고, 목록에 없는 이름은 '기타'가 된다.
* 전용 아이콘(PNG/GLB)은 화장실·충전기·엘리베이터·상가·벤치·쓰레기통 6개. 나머지는 상황 그룹 색 + 이모지로 그린다.
* 핀 등록·수정 창에서 **사진**을 붙일 수 있다 (긴 변 1024px JPEG로 줄여 저장, AI 요청에는 보내지 않음).

---

## 6. AI 대화 안내

실내 화면 하단 AI 입력창에서 질문하면 Vercel 백엔드(`https://subnote-ai.vercel.app/api/chat`)가 Gemini로 답한다.

* **통신 규격**: `schemas/ai-chat.v0.json` (현재 `schemaVersion` "0.4"). 요청에는 현재 층·모드, 분류 체계, 강남역 핀 목록(좌표·사진 제외)이 실린다.
* **강남역 질문**: 분류 체계와 핀 데이터에서 시설을 찾아 답하고, 핀 카드 표시·핀으로 이동·필터 전환 같은 동작(`actions`)을 함께 보낸다.
  비상 상황은 119·역무원 안내를 먼저 한다.
* **다른 역·외부 정보 질문**: Google 검색 그라운딩으로 답하고 출처와 Google 검색 제안을 함께 표시한다.
* **답변 형식**: 문단·번호 목록·표·주의 상자·핀 카드 블록으로 그리며, AI 글은 HTML로 해석하지 않고 텍스트로만 넣는다.
* **AI 없이 개발할 때**: `index.html`의 `AI_CHAT_URL`을 빈 문자열로 두면 키워드 매칭 목업(`mockAiChat`)이 답한다.
* **백엔드 배포**: `ai-backend` 폴더에서 `npx vercel deploy --prod --yes`. 환경변수 `GEMINI_API_KEY` 필요 (바꾸면 재배포).

---

## 7. 다른 컴퓨터에서 개발 및 실행 가이드

### 1) 저장소 클론 및 이동
```bash
git clone https://github.com/JHB-0613/maptest.git
cd maptest
```

### 2) 로컬 웹 서버 실행
Three.js 모델 파일(`.glb`)과 PWA 서비스 워커는 브라우저 보안 정책(CORS)으로 인해 `file://` 직접 실행 대신 로컬 HTTP 서버가 필요합니다.

> ⚠️ **반드시 8080 포트로 띄우세요.** 공공데이터 프록시(Worker)는 `http://localhost:8080`과 GitHub Pages 주소만 허용합니다.
> 다른 포트(Live Server 기본 5500, `npx serve` 기본 3000 등)로 열면 CORS로 막혀 API 핀이 뜨지 않습니다.

* **Python 사용 시**:
  ```bash
  python -m http.server 8080
  # 브라우저에서 http://localhost:8080 접속
  ```

* **Node.js 사용 시**:
  ```bash
  npx serve -l 8080 .
  ```

* **VS Code Live Server 사용 시**: 설정 `liveServer.settings.port`를 `8080`으로 바꾼 뒤 `index.html` 우클릭 ➡️ **"Open with Live Server"**

### 3) 수정 시 주의 사항
* **API 호출 유지**: `fetchAndGenerateApiPins("강남")` 함수가 `enterIndoorView()` 실행 시 Three.js 초기화 완료 후 1회 트리거됩니다.
* **핀 갱신 로직**: API를 새로 고칠 때 `p.id.startsWith("api_")` 핀만 제거 후 다시 채우므로, `base_...`(2호선 기본 핀)와 `sbd_...`(신분당선 실측 핀)는 그대로 유지됩니다.
* **3D 모델 추가/교체**: `models/gangnam/` 폴더에 위치하며, 층별 높이는 레이캐스터(`getSurfaceHeightAt`)가 자동으로 계산하므로 모델의 Y축 오프셋을 임의로 변경하지 않아도 됩니다.

---

## 8. 주요 파일 구조

```text
maptest/
├── index.html          # 메인 앱 단일 페이지 (HTML + UI + Three.js 스크립트 전체)
├── manifest.json       # PWA 매니페스트 설정
├── sw.js               # 서비스 워커 (네트워크 우선, 오프라인 캐시 없음)
├── stations.json       # 수도권 노선도 지하철역 메타데이터
├── metroimg.svg        # 2D 전체 지하철 노선도 SVG 벡터
├── models/
│   └── gangnam/
│       ├── gangnam_B1.glb   # 강남역 지하 1층 모델
│       ├── gangnam_B2.glb   # 강남역 지하 2층 모델
│       ├── gangnam_B3.glb   # 강남역 지하 3층 모델
│       └── gangnam_B4.glb   # 강남역 지하 4층 모델
├── Pins/               # 2D/3D 핀 에셋 (아이콘 PNG 및 모델 GLB)
│   ├── Charging.png
│   ├── Elevator.png
│   ├── RestArea.png
│   ├── Restroom.png
│   ├── Store.png
│   ├── Trash.png
│   ├── charging_3d.glb
│   ├── elevator_3d.glb
│   ├── restarea_3d.glb
│   ├── restroom_3d.glb
│   ├── store_3d.glb
│   └── trashcan_3d.glb
├── logo/
│   └── subnote.png     # 앱 대표 아이콘
├── schemas/
│   └── ai-chat.v0.json # AI 대화 통신 규격 (JSON Schema)
├── worker/
│   └── subnote-proxy.js # Cloudflare Worker 코드 사본 (수정 후 대시보드에 붙여넣고 Deploy)
├── ai-backend/         # AI 대화 백엔드 (Vercel)
│   ├── api/chat.js     # 진입점
│   ├── lib/ai-chat.js  # Gemini/OpenAI 호출·응답 변환 로직
│   ├── package.json
│   └── vercel.json     # 서울 리전(icn1), 최대 60초
└── README.md
```
