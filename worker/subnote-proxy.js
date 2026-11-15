/**
 * sub note 공공데이터 중계 (Cloudflare Worker: subnote-proxy)
 *
 * 이 파일은 Cloudflare 대시보드의 Worker 코드와 같은 내용을 보관하는 사본이다.
 * 수정하면 대시보드 → subnote-proxy → Edit code에 붙여넣고 Deploy 해야 반영된다.
 *
 * 경로
 *   GET /facility/getFc...  공공데이터포털 편의시설 API 중계
 *
 * 환경변수 (Settings → Variables and Secrets)
 *   API_KEY  Secret  공공데이터포털 인증키
 *
 * AI 대화는 여기 없다 → ai-backend/ (Vercel 서울 리전). Cloudflare에서는 Gemini가 지역 제한으로 막힌다.
 */

const ALLOWED_ORIGINS = ["https://jhb-0613.github.io", "http://localhost:8080"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Vary": "Origin",
    };

    // 편의시설 API(getFc...)만 중계
    const m = url.pathname.match(/^\/facility\/(getFc[A-Za-z]+)$/);
    if (!m || request.method !== "GET") return new Response("Not found", { status: 404, headers: cors });
    if (!env.API_KEY) return new Response("Not configured", { status: 503, headers: cors });

    const target = new URL(`https://apis.data.go.kr/B553766/facility/${m[1]}`);
    url.searchParams.forEach((v, k) => { if (k !== "serviceKey") target.searchParams.set(k, v); });
    target.searchParams.set("serviceKey", env.API_KEY); // 키는 여기서만 붙음

    const res = await fetch(target);
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, "Content-Type": res.headers.get("Content-Type") || "application/json" },
    });
  },
};
