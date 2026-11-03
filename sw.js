// 캐시 이름 정의
const CACHE_NAME = 'subnote-v1';

// 서비스 워커 설치
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// 서비스 워커 활성화
self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// 네트워크 요청 처리 (기본 캐시 패스스루)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});