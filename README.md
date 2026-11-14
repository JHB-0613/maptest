# sub note - 서울 지하철 스마트 실내 내비게이션 & 3D 맵

> 서울 지하철 강남역을 중심으로 실내 3D/2D 내비게이션, 공공데이터포털 실시간 편의시설 API 연동, 층별 시설물 탐색 기능을 제공하는 웹앱입니다.

---

## 📌 목차
1. [프로젝트 개요 및 기술 스택](#1-프로젝트-개요-및-기술-스택)
2. [공공데이터포털 API 연동 내역](#2-공공데이터포털-api-연동-내역)
3. [강남역 3D 모델 및 좌표계 구조](#3-강남역-3d-모델-및-좌표계-구조)
4. [층별 시설물 데이터 및 보강 내역](#4-층별-시설물-데이터-및-보강-내역)
5. [다른 컴퓨터에서 개발 및 실행 가이드](#5-다른-컴퓨터에서-개발-및-실행-가이드)
6. [주요 파일 구조](#6-주요-파일-구조)

---

## 1. 프로젝트 개요 및 기술 스택

* **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+)
* **3D 렌더링**: [Three.js](https://threejs.org/) (r128), OrbitControls, GLTFLoader
* **2D 탑뷰 & 3D 뷰 전환**: `currentIndoorMode` ("2D" / "3D")
* **PWA 지원**: `manifest.json`, `sw.js` (서비스 워커 등록)
* **모바일 반응형 최적화**: 412px 모바일 목업 컨테이너 및 실제 모바일 브라우저 풀스크린 지원

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
  실측 앵커 포인트를 기반으로 정밀 아핀 선형 변환 행렬 적용 (오차 1~2m 이내 안착)
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
| **B1** | 2호선 대합실 (상단부) | 실시간 API: 중앙 화장실, 1번·10번 출구 외부 EV, ATM 3곳, T-Locker 보관함 2곳, 수유실, 고객안전실, 무인민원발급기, 승차권 발매기 3대, 교통카드 키오스크 3대 |
| **B1** | 신분당선 통로·출구 (하단부) | 신분당선 대합실 화장실, 4번 출구 EV, 5번 출구 EV, 신분당선 T-Locker, ATM/충전기, 스토리웨이 편의점, 3번·6번 출구 쉼터 벤치 |
| **B2** | 2호선 승강장 (상단부) | 실시간 API: 2호선 외선(역삼 방면 8-1) 승강기, 내선(교대 방면 3-4) 승강기, 승강장 중앙 쉼터 벤치 |
| **B2** | 신분당선 통로 (하단부) | B1↔B2 환승통로 승강기, 환승통로 1·2구역 휴식 벤치, 음료 자동판매기, 남측 연결 쉼터 |
| **B3** | 신분당선 대합실 | 신분당선 화장실, B3↔B4 상·하행 승강기 2기, 신분당선 고객안내센터, 교통카드 무인충전기, T-Locker 물품보관함 |
| **B4** | 신분당선 승강장 | 승강장 승강기 2기 (상행/하행), 휠체어 급속 충전소, 고객 대기 쉼터 벤치, 음료 자동판매기 |

---

## 5. 다른 컴퓨터에서 개발 및 실행 가이드

### 1) 저장소 클론 및 이동
```bash
git clone <저장소_URL> maptest
cd maptest
```

### 2) 로컬 웹 서버 실행
Three.js 모델 파일(`.glb`)과 PWA 서비스 워커는 브라우저 보안 정책(CORS)으로 인해 `file://` 직접 실행 대신 로컬 HTTP 서버가 필요합니다.

* **VS Code 사용 시**:
  * [Live Server 확장 프로그램](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) 설치 후 `index.html` 우클릭 ➡️ **"Open with Live Server"**

* **Python 사용 시**:
  ```bash
  python -m http.server 8080
  # 브라우저에서 http://localhost:8080 접속
  ```

* **Node.js 사용 시**:
  ```bash
  npx serve .
  ```

### 3) 수정 시 주의 사항
* **API 호출 유지**: `fetchAndGenerateApiPins("강남")` 함수가 `enterIndoorView()` 실행 시 Three.js 초기화 완료 후 1회 트리거됩니다.
* **핀 갱신 로직**: API를 새로 고칠 때 `p.id.startsWith("api_")` 핀만 제거 후 다시 채우므로, `sbd_...` 및 `base_...`로 시작하는 신분당선 고유 핀은 안전하게 유지됩니다.
* **3D 모델 추가/교체**: `models/gangnam/` 폴더에 위치하며, 층별 높이는 레이캐스터(`getSurfaceHeightAt`)가 자동으로 계산하므로 모델의 Y축 오프셋을 임의로 변경하지 않아도 됩니다.

---

## 6. 주요 파일 구조

```text
maptest/
├── index.html          # 메인 앱 단일 페이지 (HTML + UI + Three.js 스크립트 전체)
├── manifest.json       # PWA 매니페스트 설정
├── sw.js               # 서비스 워커
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
│   ├── restroom_3d.glb
│   ├── store_3d.glb
│   └── trashcan_3d.glb
└── logo/
    └── subnote.png     # 앱 대표 아이콘
```
