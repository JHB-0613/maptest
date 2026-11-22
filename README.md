# sub note - 서울 지하철 스마트 실내 내비게이션 & 3D 맵

> 서울 지하철 강남역을 중심으로 실내 3D/2D 내비게이션, 층별 시설물(핀) 탐색·등록, AI 대화 안내 기능을 제공하는 웹앱입니다.
> 배포: GitHub Pages (`https://jhb-0613.github.io/maptest/`)

---

## 📌 목차
1. [프로젝트 개요 및 기술 스택](#1-프로젝트-개요-및-기술-스택)
2. [강남역 핀 데이터](#2-강남역-핀-데이터)
3. [강남역 3D 모델 및 좌표계 구조](#3-강남역-3d-모델-및-좌표계-구조)
4. [핀 분류 체계](#4-핀-분류-체계)
5. [AI 대화 안내](#5-ai-대화-안내)
6. [다른 컴퓨터에서 개발 및 실행 가이드](#6-다른-컴퓨터에서-개발-및-실행-가이드)
7. [주요 파일 구조](#7-주요-파일-구조)

---

## 1. 프로젝트 개요 및 기술 스택

* **Frontend**: HTML5, CSS3, Vanilla JavaScript (ES6+)
* **3D 렌더링**: [Three.js](https://threejs.org/) (r128), OrbitControls, GLTFLoader
* **2D 탑뷰 & 3D 뷰 전환**: `currentIndoorMode` ("2D" / "3D")
* **PWA 지원**: `manifest.json`, `sw.js` (홈 화면 추가용. 서비스 워커는 네트워크 우선이며 **오프라인 캐시는 하지 않음**)
* **모바일 반응형 최적화**: 412px 모바일 목업 컨테이너 및 실제 모바일 브라우저 풀스크린 지원
* **AI 대화 백엔드**: Vercel 서버리스 함수 (`ai-backend/`, 서울 리전 `icn1`) + Google Gemini (Google 검색 그라운딩)
* **빌드 도구 없음**: 번들러·패키지 매니저 없이 정적 파일 그대로 배포

---

## 2. 강남역 핀 데이터

> 강남역 핀은 답사 자료를 바탕으로 **다시 넣을 예정이라 현재 비어 있다** (`index.html`의 `STATION_PINS_DB["강남역"]`).
> 예전에 쓰던 서울교통공사 편의시설 API 자동 핀 생성과 기본·신분당선 핀은 제거했다.

### 핀 객체 형식
```javascript
{
  id: "gn_b1_toilet_1",       // 겹치지 않는 문자열 (사용자가 만든 핀은 Date.now() 숫자)
  title: "중앙 화장실",
  category: "화장실",          // 4장 분류 체계의 시설 이름 (없으면 '기타')
  desc: "1~2번 출구 중간 B1 개찰구 인근",
  floor: "B1",                 // "B1" ~ "B4"
  realX3d: 4.0, realZ3d: -56.0, // Three.js 월드 좌표 (3장 좌표계)
  x: 171, y: 120,              // 2D 좌표 (360×520 기준, coord3Dto2D로 계산)
  photo: "photos/gangnam/gn_b1_toilet_1.jpg"  // 선택
}
```

* 위치는 `realX3d`/`realZ3d`로 넣으면 된다. 높이(Y)는 `getSurfaceHeightAt`이 층 모델 바닥에 자동으로 맞춘다.
* 좌표를 모를 때는 앱에서 지도를 눌러 핀을 등록한 뒤, 개발자 도구 콘솔에서 `STATION_PINS_DB["강남역"]`을 보면 좌표를 얻을 수 있다.
* 답사 핀을 모두가 보게 하려면 Supabase `pins` 테이블에 `owner_id` 없이 넣는다 (공식 핀: 앱에서는 아무도 수정 못 함).

### 계정·핀 저장 (Supabase)
* **로그인**: 아이디(영문 소문자·숫자·_ 4~20자) + 비밀번호 + 닉네임으로 가입. 내부적으로는 아이디를 메일이 가지 않는 주소(`아이디@id.subnote.example.com`)로 바꿔 Supabase 계정을 만든다. 마이페이지 버튼 → 로그인 안 했으면 로그인·회원가입, 했으면 마이페이지(내 핀·즐겨찾기·메모 수, 로그아웃).
* **핀**: 로그인한 사람만 등록할 수 있고, **수정·삭제는 등록한 계정만** 가능하다. 다른 사람 핀은 읽기 전용 + ☆ 즐겨찾기.
  로그인하지 않고 지도를 누르면 "로그인 후 이용" 안내가 올라온다.
* **내 핀만 보기**: 도구 버튼(`btn-tool-menu`)의 토글. 켜면 내가 등록한 핀 + 즐겨찾기한 핀만 보인다 (기본은 꺼짐 = 모든 사람의 핀).
* **커뮤니티**: 모든 사람의 핀을 짧게 보여주고, 누르면 전체 정보(사진·분류·등록일)와 "지도에서 위치 보기" 버튼이 펼쳐진다.
* **메모**: 제목·내용·사진·관련 핀. **작성한 사람만** 볼 수 있다.
* **회원 탈퇴**: 마이페이지 → 회원 탈퇴 → 비밀번호 확인. 사진 파일을 지운 뒤 서버 함수 `delete_my_account()`가 계정을 지우고,
  DB가 그 사람의 핀·즐겨찾기·메모·프로필을 함께 지운다 (다른 사람 메모의 관련 핀은 비워짐).
* 권한은 DB의 RLS 규칙(`supabase/schema.sql`)이 서버에서 강제한다. 화면은 그에 맞춰 버튼을 숨길 뿐이다.
* **체험 모드**: `index.html`의 `SUPABASE_URL`·`SUPABASE_ANON_KEY`가 비어 있으면 이 브라우저(localStorage)에만 저장하는 가짜 서버로 동작한다.

#### Supabase 설정 순서
1. [supabase.com](https://supabase.com)에서 새 프로젝트 생성 (리전: Northeast Asia (Seoul))
2. SQL Editor → `supabase/schema.sql` 전체를 붙여넣고 Run (테이블·권한 규칙·사진 버킷 생성)
   - 2026-11-22 이전 `schema.sql`로 만든 프로젝트는 `supabase/002_photo_delete_policy.sql`, `003_security_hardening.sql`도
     순서대로 한 번씩 실행 (사진 삭제 규칙, 수정 가능한 칸 제한·좌표 범위·계정당 개수 제한·업로드 경로 제한)
   - 회원 탈퇴 기능을 쓰려면 `supabase/004_delete_account.sql`도 실행 (새 프로젝트는 schema.sql에 포함)
   - 공개 서비스로 열 때는 Authentication → Attack Protection에서 가입 CAPTCHA와 요청 제한(rate limit)도 켜는 것을 권장
3. Authentication → URL Configuration: Site URL에 `https://jhb-0613.github.io/maptest/`, Redirect URLs에 `http://localhost:8080` 추가
4. **필수**: Authentication → Sign In / Providers → Email → **Confirm email 끄기** (아이디 가입은 메일을 받을 수 없어서, 켜져 있으면 가입이 끝나지 않는다. 비밀번호 찾기 메일도 쓸 수 없다)
5. Project Settings → API의 **Project URL**과 **anon public 키**를 `index.html` 맨 위 `SUPABASE_URL`, `SUPABASE_ANON_KEY`에 넣는다
   (anon 키는 공개돼도 되는 키다. **service_role 키는 절대 넣지 않는다**)

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

## 4. 핀 분류 체계

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

## 5. AI 대화 안내

실내 화면 하단 AI 입력창에서 질문하면 Vercel 백엔드(`https://subnote-ai.vercel.app/api/chat`)가 Gemini로 답한다.

* **통신 규격**: `schemas/ai-chat.v0.json` (현재 `schemaVersion` "0.5"). 요청에는 현재 층·모드, 분류 체계, 강남역 핀 목록(좌표·사진 제외)이 실린다.
* **강남역 질문**: 분류 체계와 핀 데이터에서 시설을 찾아 답하고, 핀 카드 표시·핀으로 이동·필터 전환 같은 동작(`actions`)을 함께 보낸다.
  비상 상황은 119·역무원 안내를 먼저 한다.
* **다른 역·외부 정보 질문**: Google 검색 그라운딩으로 답하고 출처와 Google 검색 제안을 함께 표시한다.
* **답변 형식**: 문단·번호 목록·표·주의 상자·핀 카드 블록으로 그리며, AI 글은 HTML로 해석하지 않고 텍스트로만 넣는다.
* **AI 없이 개발할 때**: `index.html`의 `AI_CHAT_URL`을 빈 문자열로 두면 키워드 매칭 목업(`mockAiChat`)이 답한다.
* **백엔드 배포**: `ai-backend` 폴더에서 `npx vercel deploy --prod --yes`. 환경변수 `GEMINI_API_KEY` 필요 (바꾸면 재배포).

---

## 6. 다른 컴퓨터에서 개발 및 실행 가이드

### 1) 저장소 클론 및 이동
```bash
git clone https://github.com/JHB-0613/maptest.git
cd maptest
```

### 2) 로컬 웹 서버 실행
Three.js 모델 파일(`.glb`)과 PWA 서비스 워커는 브라우저 보안 정책(CORS)으로 인해 `file://` 직접 실행 대신 로컬 HTTP 서버가 필요합니다.

> ⚠️ **반드시 8080 포트로 띄우세요.** AI 대화 백엔드는 `http://localhost:8080`과 GitHub Pages 주소에서 온 요청만 받습니다.
> 다른 포트(Live Server 기본 5500, `npx serve` 기본 3000 등)로 열면 AI 대화가 거절됩니다.

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
* **3D 모델 추가/교체**: `models/gangnam/` 폴더에 위치하며, 층별 높이는 레이캐스터(`getSurfaceHeightAt`)가 자동으로 계산하므로 모델의 Y축 오프셋을 임의로 변경하지 않아도 됩니다.

---

## 7. 주요 파일 구조

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
├── supabase/
│   ├── schema.sql      # 로그인·핀·즐겨찾기·메모 테이블과 권한(RLS) 규칙. 새 프로젝트는 이것만 실행
│   ├── 002_photo_delete_policy.sql   # 기존 프로젝트용 추가 규칙 (사진 삭제)
│   ├── 003_security_hardening.sql    # 기존 프로젝트용 추가 규칙 (보안 검토 반영)
│   └── 004_delete_account.sql        # 기존 프로젝트용 회원 탈퇴 함수
├── worker/
│   └── subnote-proxy.js # (사용 안 함) 예전 공공데이터 API 중계 Worker 코드 사본
├── ai-backend/         # AI 대화 백엔드 (Vercel)
│   ├── api/chat.js     # 진입점
│   ├── lib/ai-chat.js  # Gemini/OpenAI 호출·응답 변환 로직
│   ├── package.json
│   └── vercel.json     # 서울 리전(icn1), 최대 60초
└── README.md
```
