/**
 * sub note AI 대화 백엔드 로직 (규격: schemas/ai-chat.v0.json)
 *
 * 실행 환경과 무관한 순수 로직. Vercel 함수(api/chat.js)가 process.env를 env로 넘겨 호출한다.
 * Web 표준 Request/Response만 쓰므로 다른 서버리스 환경으로 옮겨도 그대로 쓸 수 있다.
 *
 * 왜 Vercel(서울 icn1)인가:
 *   Cloudflare Worker에서 호출하면 한국 요청이 홍콩(HKG) 경유로 판정돼
 *   Gemini가 "User location is not supported"로 거절했다(Placement·AI Gateway로도 해결 안 됨).
 *   OpenAI도 홍콩을 막으므로, AI 호출은 한국 리전에서 나가야 한다.
 *
 * 환경변수 (Vercel → Project → Settings → Environment Variables)
 *   AI_PROVIDER     (선택) "gemini" | "openai". 없으면 GEMINI_API_KEY가 있으면 gemini, 아니면 openai
 *   GEMINI_API_KEY  Google AI Studio API 키
 *   GEMINI_MODEL    (선택) 없으면 DEFAULT_GEMINI_MODEL
 *   OPENAI_API_KEY  OpenAI API 키
 *   OPENAI_MODEL    (선택) 없으면 DEFAULT_OPENAI_MODEL
 */

export const ALLOWED_ORIGINS = ["https://jhb-0613.github.io", "http://localhost:8080"];
const SCHEMA_VERSION = "0.2";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

// 비용·남용 방지 한도
const MAX_MESSAGE_CHARS = 500;
const MAX_HISTORY = 10;
const MAX_PINS = 300;
// AI 호출 1회당 제한 시간과 재시도 횟수.
// 평소 응답은 2~4초지만 Gemini가 가끔 응답 없이 멈춘다(45초 대기 후 타임아웃 사례).
// 1단계 15초 × 최대 2회 + 2단계(웹 검색) 25초 1회 = 55초로, vercel.json maxDuration(60초) 안에서 끝낸다.
const AI_TIMEOUT_MS = 15000;
const SEARCH_TIMEOUT_MS = 25000;
const AI_MAX_ATTEMPTS = 2;
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

export function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

// POST /api/chat 처리. OPTIONS(사전 요청)는 호출부에서 corsHeaders로 응답한다.
export async function handleChatRequest(request, env) {
  const cors = corsHeaders(request);
  const origin = request.headers.get("Origin") || "";
  // 우리 사이트가 아닌 브라우저에서 온 요청은 거절 (curl 등은 막지 못함 → AI 사용 한도도 꼭 설정)
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "forbidden" }, 403, cors);

  const provider = env.AI_PROVIDER || (env.GEMINI_API_KEY ? "gemini" : "openai");
  const hasKey = provider === "gemini" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
  if (!hasKey) return json(fallback(`서버에 AI 키(${provider})가 설정되지 않았습니다.`), 200, cors);

  let req;
  try { req = await request.json(); } catch { return json({ error: "invalid JSON" }, 400, cors); }
  if (!req || typeof req.message !== "string" || !req.message.trim()) {
    return json({ error: "message is required" }, 400, cors);
  }

  const message = req.message.slice(0, MAX_MESSAGE_CHARS);
  const history = Array.isArray(req.history) ? req.history.slice(-MAX_HISTORY) : [];
  const ctx = req.context || {};
  const pins = Array.isArray(ctx.pins) ? ctx.pins.slice(0, MAX_PINS) : [];

  // 웹 검색: 현재 Gemini만 지원 (Google 검색 그라운딩). GEMINI_WEB_SEARCH=off 로 끌 수 있다.
  const webSearch = provider === "gemini" && env.GEMINI_WEB_SEARCH !== "off";
  const system = buildSystemPrompt(ctx, pins, webSearch);
  const turns = [
    ...history
      .filter(h => h && (h.role === "user" || h.role === "assistant") && typeof h.text === "string")
      .map(h => ({ role: h.role, text: h.text.slice(0, 2000) })),
    { role: "user", text: message },
  ];

  // 1단계: JSON 형식 강제로 대상 역·의도·경로·핀·검색 필요 여부를 정한다 (빠름)
  let out;
  try {
    out = await withRetry(
      () => provider === "gemini" ? callGemini(env, system, turns) : callOpenAI(env, system, turns),
      provider);
  } catch (e) {
    console.log(`AI call failed (${provider})`, String(e));
    if (isRetryable(e)) {
      return json(fallback("AI 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요."), 200, cors);
    }
    return json(fallback(e.userMessage || "AI 응답을 처리하지 못했습니다. 잠시 후 다시 시도해주세요."), 200, cors);
  }

  // 2단계: 검색이 필요하다고 판단했으면 Google 검색으로 답변 글을 다시 만든다.
  // (형식 강제와 검색 도구를 한 번에 주면 Gemini가 검색을 건너뛰어서 나눈다.) 실패하면 1단계 답변을 그대로 쓴다.
  if (webSearch && out.needsWebSearch === true) {
    try {
      const found = await searchAnswer(env, ctx, turns, out);
      if (found.text) {
        out.replyText = found.text;
        out._sources = found.sources;
        out._searchSuggestionHtml = found.searchSuggestionHtml;
      }
    } catch (e) {
      console.log("AI web search failed (keep draft)", String(e));
    }
  }

  return json(toChatResponse(out, pins), 200, cors);
}

// 2단계: Google 검색 그라운딩으로 일반 글 답변을 받는다 (형식 강제 없음)
async function searchAnswer(env, ctx, turns, draft) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const system = [
    "너는 서울 지하철 안내 앱 'sub note'의 도우미다. 사용자의 마지막 질문에 Google 검색으로 최신 정보를 확인해 답한다.",
    "한국어 존댓말로 2~4문장, 핵심만 쓴다. 마크다운·목록 기호·URL·각주 번호는 쓰지 않는다.",
    "확인되지 않은 내용은 단정하지 말고, 바뀔 수 있는 정보(운영 시간 등)는 방문 전 확인을 권한다.",
    draft.aboutStation ? `질문 대상: ${draft.aboutStation}` : "",
    draft.route ? "경로 안내는 별도로 화면에 표시되므로, 경로 단계는 간단히만 언급한다." : "",
  ].filter(Boolean).join("\n");

  let t = turns;
  while (t.length > 1 && t[0].role !== "user") t = t.slice(1);
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: t.map(x => ({ role: x.role === "assistant" ? "model" : "user", parts: [{ text: x.text }] })),
      tools: [{ google_search: {} }],
      generationConfig: { thinkingConfig: { thinkingLevel: env.GEMINI_THINKING_LEVEL || "low" } },
    }),
  });
  if (!res.ok) throw httpError("Gemini search", res.status, await res.text());
  const data = await res.json();
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter(p => !p.thought).map(p => p.text || "").join("").trim();
  const meta = cand && cand.groundingMetadata;
  console.log("AI search", JSON.stringify({ queries: (meta && meta.webSearchQueries) || [], chunks: ((meta && meta.groundingChunks) || []).length }));
  return {
    text,
    sources: extractGeminiSources(meta),
    // Google 약관: 검색 그라운딩 결과를 쓰면 이 '검색 제안'을 화면에 표시해야 한다
    searchSuggestionHtml: (meta && meta.searchEntryPoint && meta.searchEntryPoint.renderedContent) || null,
  };
}

// 시간 초과·일시적 서버 오류(429/5xx)면 한 번 더 시도한다. 그 외(키 오류, 형식 오류 등)는 바로 실패.
function isRetryable(e) {
  return e && (e.name === "TimeoutError" || RETRYABLE_STATUS.includes(e.status));
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= AI_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === AI_MAX_ATTEMPTS) break;
      console.log(`AI retry (${label}) attempt ${attempt} failed:`, String(e));
    }
  }
  throw lastErr;
}

function httpError(provider, status, body) {
  const e = new Error(`${provider} HTTP ${status}: ${body.slice(0, 500)}`);
  e.status = status;
  return e;
}

// AI 공급자 호출. 둘 다 { intent, replyText, route, actions } 객체를 돌려준다.
async function callOpenAI(env, system, turns) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      messages: [{ role: "system", content: system }, ...turns.map(t => ({ role: t.role, content: t.text }))],
      response_format: { type: "json_schema", json_schema: { name: "subnote_reply", strict: true, schema: OPENAI_REPLY_SCHEMA } },
    }),
  });
  if (!res.ok) throw httpError("OpenAI", res.status, await res.text());
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice || choice.message.refusal) throw userError("이 질문에는 답변할 수 없습니다.");
  return parseJsonText(choice.message.content);
}

async function callGemini(env, system, turnsIn) {
  let turns = turnsIn;
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  // Gemini 대화는 user 차례로 시작해야 하므로 앞쪽 assistant 기록은 버린다
  while (turns.length > 1 && turns[0].role !== "user") turns = turns.slice(1);
  const res = await fetch(`${GEMINI_BASE_URL}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map(t => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] })),
      // ⚠️ 여기에 google_search 도구를 같이 주면 형식 강제 때문에 검색을 건너뛴다 → 검색은 searchAnswer(2단계)에서
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_REPLY_SCHEMA,
        // 답하기 전 사고(thinking)를 짧게 → 응답 속도 우선. 변수 GEMINI_THINKING_LEVEL로 조정 (low|medium|high)
        thinkingConfig: { thinkingLevel: env.GEMINI_THINKING_LEVEL || "low" },
      },
    }),
  });
  if (!res.ok) throw httpError("Gemini", res.status, await res.text());
  const data = await res.json();
  if (data.promptFeedback && data.promptFeedback.blockReason) throw userError("이 질문에는 답변할 수 없습니다.");
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  // 사고 과정(thought) 파트가 섞여 오면 제외하고 본문만 합친다
  const text = (parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  if (!text) throw new Error("Gemini empty response: " + JSON.stringify(data).slice(0, 500));
  return parseJsonText(text);
}

// 검색 그라운딩에 쓰인 웹 출처 (중복 제거, 최대 5개)
function extractGeminiSources(meta) {
  const chunks = (meta && Array.isArray(meta.groundingChunks)) ? meta.groundingChunks : [];
  const seen = new Set();
  const sources = [];
  for (const c of chunks) {
    const w = c && c.web;
    if (!w || typeof w.uri !== "string" || !/^https?:\/\//.test(w.uri) || seen.has(w.uri)) continue;
    seen.add(w.uri);
    sources.push({ title: String(w.title || w.uri).slice(0, 100), url: w.uri });
    if (sources.length >= 5) break;
  }
  return sources;
}

// ```json ... ``` 으로 감싸 오거나 앞뒤에 글이 붙어도 가장 바깥 { ... } 를 찾아 파싱
function parseJsonText(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch (e) {
    const s = cleaned.indexOf("{"), t = cleaned.lastIndexOf("}");
    if (s >= 0 && t > s) return JSON.parse(cleaned.slice(s, t + 1));
    throw e;
  }
}

function userError(msg) {
  const e = new Error(msg);
  e.userMessage = msg;
  return e;
}

function buildSystemPrompt(ctx, pins, webSearch) {
  const station = ctx.currentStation || "(선택 안 함)";
  const indoor = ctx.indoor ? `실내 지도 ${ctx.indoor.activeFloor}층, ${ctx.indoor.mode} 화면` : "노선도 화면";
  const pinLines = pins
    .map(p => `- id=${p.id} | ${p.floor} | ${p.category} | ${p.title}${p.desc ? " | " + p.desc : ""}`)
    .join("\n");
  // 웹 검색은 이 단계에서 직접 하지 않는다. needsWebSearch=true면 서버가 2단계(searchAnswer)에서 검색해 답변 글을 바꾼다.
  const research = webSearch
    ? "needsWebSearch를 true로 하고, replyText에는 아는 범위의 짧은 초안을 쓴다(검색 후 서버가 교체한다)."
    : "일반적으로 알려진 정보로 답한다.";

  return [
    "너는 서울 지하철 실내 내비게이션 앱 'sub note'의 안내 도우미다. 한국어 존댓말로 짧고 명확하게 답한다.",
    "",
    "[질문 대상 역 판단]",
    "- 먼저 질문이 어느 역에 대한 것인지 판단해 aboutStation에 역 이름(예: '강남역', '잠실역')을 쓴다. 특정 역이 아니면 null.",
    "- 사용자가 지금 강남역 실내 지도를 보고 있어도, 질문이 다른 역(예: '잠실역 가는 중')에 관한 것이면 그 역이 대상이다.",
    "",
    "[강남역 질문]",
    "- 아래 [강남역 시설 데이터]를 가장 우선하는 근거로 쓴다. 데이터의 세부 위치 설명을 활용해 일반적으로 잘 알려지지 않은 구체적인 정보까지 알려준다.",
    "- 데이터에 해당 시설이 있으면 intent=pin_locate(또는 station_info)로 하고, 가장 알맞은 핀 하나를 actions에 focus_pin으로 넣는다.",
    `- 데이터에 없는 시설이면 그렇다고 말한 뒤, ${research} 이때는 actions를 비운다.`,
    "",
    "[다른 역 질문 / 일반 질문]",
    `- [강남역 시설 데이터]와 핀은 절대 쓰지 않는다. actions는 빈 배열이다. ${research}`,
    "- 특정 가게·시설 위치, 운영 시간처럼 바뀔 수 있는 정보는 확인한 범위에서 말하고, 확실하지 않으면 그렇다고 밝힌다.",
    "",
    "[경로 계획]",
    "- 출발역·도착역·중간 들를 곳이 있으면 intent=route_plan으로 route.steps를 순서대로 채운다.",
    "- kind는 ride(열차 탑승), transfer(환승), walk(도보), stop(들를 곳) 중 하나다. 각 step의 text에 사람이 읽을 한 줄 설명을 쓴다.",
    "- 환승이 적고 단순한 경로를 우선한다. 소요 시간·실시간 운행은 확실하지 않으면 단정하지 않는다.",
    "",
    "[웹 검색 필요 여부 needsWebSearch]",
    "- true: 강남역 데이터로 답할 수 없는 사실 정보가 필요할 때 (다른 역의 시설·출구·주변 가게, 운영 시간, 요금, 최근 운행 소식 등).",
    "- false: 강남역 데이터로 답하는 질문, 단순한 경로 계획, 인사나 간단한 일반 질문.",
    "",
    "[출력 규칙]",
    "- pinId는 반드시 [강남역 시설 데이터]의 id 중 하나를 그대로 쓴다. 없는 id를 만들지 않는다.",
    "- 경로 질문이 아니면 route는 null, 지도 이동이 필요 없으면 actions는 빈 배열로 둔다.",
    "- step에서 해당 없는 필드는 null로 둔다. replyText에는 URL이나 각주 번호를 넣지 않는다.",
    "",
    `[현재 상태] 선택한 역: ${station}, 화면: ${indoor}`,
    "",
    "[강남역 시설 데이터] (강남역 질문에만 사용. id | 층 | 카테고리 | 이름 | 설명)",
    pinLines || "(없음)",
  ].join("\n");
}

// 강남역에 대한 답일 때만 핀을 쓴다 (강남구청역은 제외)
function isGangnam(aboutStation) {
  return typeof aboutStation === "string" && aboutStation.includes("강남") && !aboutStation.includes("강남구청");
}

// OpenAI strict 모드용 응답 스키마 (모든 필드 required, 없으면 null)
const nullableStr = { type: ["string", "null"] };
const OPENAI_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aboutStation", "needsWebSearch", "intent", "replyText", "route", "actions"],
  properties: {
    aboutStation: nullableStr,
    needsWebSearch: { type: "boolean" },
    intent: { type: "string", enum: ["route_plan", "station_info", "pin_locate", "general"] },
    replyText: { type: "string" },
    route: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["from", "to", "steps"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "line", "from", "to", "place", "near", "pinId", "text"],
                properties: {
                  kind: { type: "string", enum: ["ride", "transfer", "walk", "stop"] },
                  line: nullableStr, from: nullableStr, to: nullableStr,
                  place: nullableStr, near: nullableStr, pinId: nullableStr,
                  text: { type: "string" },
                },
              },
            },
          },
        },
      ],
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "pinId"],
        properties: {
          type: { type: "string", enum: ["focus_pin"] },
          pinId: { type: "string" },
        },
      },
    },
  },
};

// Gemini responseSchema (OpenAPI 부분집합: 대문자 type, nullable 사용)
const gStr = { type: "STRING", nullable: true };
const GEMINI_REPLY_SCHEMA = {
  type: "OBJECT",
  required: ["aboutStation", "needsWebSearch", "intent", "replyText", "route", "actions"],
  propertyOrdering: ["aboutStation", "needsWebSearch", "intent", "replyText", "route", "actions"],
  properties: {
    aboutStation: gStr,
    needsWebSearch: { type: "BOOLEAN" },
    intent: { type: "STRING", enum: ["route_plan", "station_info", "pin_locate", "general"] },
    replyText: { type: "STRING" },
    route: {
      type: "OBJECT",
      nullable: true,
      required: ["from", "to", "steps"],
      properties: {
        from: { type: "STRING" },
        to: { type: "STRING" },
        steps: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            required: ["kind", "text"],
            properties: {
              kind: { type: "STRING", enum: ["ride", "transfer", "walk", "stop"] },
              line: gStr, from: gStr, to: gStr, place: gStr, near: gStr, pinId: gStr,
              text: { type: "STRING" },
            },
          },
        },
      },
    },
    actions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["type", "pinId"],
        properties: {
          type: { type: "STRING", enum: ["focus_pin"] },
          pinId: { type: "STRING" },
        },
      },
    },
  },
};

// AI 출력 → 규격(ChatResponse)으로 변환. 없는 pinId는 지우고, floor는 우리 데이터에서 채운다.
// 강남역이 아닌 질문이면 핀(actions, step.pinId)을 모두 버린다.
function toChatResponse(out, allPins) {
  const pins = isGangnam(out.aboutStation) ? allPins : [];
  const byId = new Map(pins.map(p => [String(p.id), p]));
  const route = (out.route && typeof out.route === "object") ? {
    from: String(out.route.from || ""),
    to: String(out.route.to || ""),
    steps: (Array.isArray(out.route.steps) ? out.route.steps : []).filter(s => s && typeof s === "object").map(s => {
      const step = {};
      for (const [k, v] of Object.entries(s)) if (v !== null && v !== undefined) step[k] = v;
      if (step.pinId && !byId.has(step.pinId)) delete step.pinId;
      return step;
    }),
  } : null;
  const actions = (Array.isArray(out.actions) ? out.actions : [])
    .filter(a => a && a.type === "focus_pin" && byId.has(String(a.pinId)))
    .map(a => ({ type: "focus_pin", pinId: String(a.pinId), floor: byId.get(String(a.pinId)).floor }));

  const reply = { text: typeof out.replyText === "string" && out.replyText ? out.replyText : "답변이 비어 있습니다." };
  if (Array.isArray(out._sources) && out._sources.length) reply.sources = out._sources;
  if (typeof out._searchSuggestionHtml === "string" && out._searchSuggestionHtml) reply.searchSuggestionHtml = out._searchSuggestionHtml;

  return {
    schemaVersion: SCHEMA_VERSION,
    intent: typeof out.intent === "string" ? out.intent : "general",
    aboutStation: typeof out.aboutStation === "string" ? out.aboutStation : null,
    reply,
    route,
    actions,
  };
}

function fallback(text) {
  return { schemaVersion: SCHEMA_VERSION, intent: "general", reply: { text }, route: null, actions: [] };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}
