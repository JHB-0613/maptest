// 캐시 이름 정의
const CACHE_NAME = 'subnote-v2';

// 서비스 워커 설치
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// 서비스 워커 활성화
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// 네트워크 요청 처리 (기본 캐시 패스스루)
// 페이지(index.html) 요청은 브라우저 HTTP 캐시(GitHub Pages는 10분)를 거치지 않고 서버에 새로 확인한다.
// 그러지 않으면 설치한 앱이 푸시 후에도 한동안 예전 코드로 열린다.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req);
  event.respondWith(fresh.catch(() => caches.match(req)));
});
