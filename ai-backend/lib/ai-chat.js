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
const SCHEMA_VERSION = "0.5";
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

  // 길안내와 무관한 질문은 답하지 않고 다시 질문해달라고 한다 (웹 검색도 하지 않음).
  // 안내 글은 AI가 쓴 글이 아니라 서버가 정한 고정 문구를 쓴다.
  if (out && out.intent === "off_topic") {
    console.log("AI off_topic blocked");
    return json(offTopicResponse(), 200, cors);
  }

  // 안전장치: 강남역이 아닌 특정 역의 시설·역 정보 질문은 AI가 검색을 빼먹어도 검색한다 (추측 답변 방지).
  // 강남역은 핀 데이터로 답하고, 경로 계획·일반 질문(예: 응급 대처 안내)은 AI 판단을 따른다.
  if (webSearch && out.needsWebSearch !== true && out.aboutStation && !isGangnam(out.aboutStation)
      && (out.intent === "station_info" || out.intent === "pin_locate")) {
    console.log("AI force web search", out.aboutStation, out.intent);
    out.needsWebSearch = true;
  }

  // 2단계: 검색이 필요하다고 판단했으면 Google 검색으로 답변 글을 다시 만든다.
  // (형식 강제와 검색 도구를 한 번에 주면 Gemini가 검색을 건너뛰어서 나눈다.) 실패하면 1단계 답변을 그대로 쓴다.
  if (webSearch && out.needsWebSearch === true) {
    try {
      const found = await searchAnswer(env, ctx, turns, out);
      if (found.text) {
        // 검색 답변은 마크다운 일부(목록·표·굵게)로 받아 블록으로 바꾼다. 요약 글은 서식을 뺀 첫 문단.
        const blocks = markdownToBlocks(found.text);
        out.blocks = blocks;
        out.replyText = summarizeBlocks(blocks) || stripMarkdown(found.text);
        out._sources = found.sources;
        out._searchSuggestionHtml = found.searchSuggestionHtml;
      }
    } catch (e) {
      console.log("AI web search failed (keep draft)", String(e));
    }
  }

  return json(toChatResponse(out, pins, readCategoryGroups(ctx)), 200, cors);
}

/* ---------------- 답변 블록 (규격 0.4) ---------------- */

const MAX_BLOCKS = 6;
const MAX_ITEMS = 8;
const MAX_ROWS = 8;
const MAX_COLS = 4;
const clip = (v, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");

// 인라인 마크다운 정리: 링크는 글자만, 각주 [1] 삭제, **굵게**는 남긴다 (앱이 안전하게 렌더)
function cleanInline(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, "$1")
    .replace(/\s*\[\d+(?:,\s*\d+)*\]/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|[^*])\*(?!\*)([^*]+)\*(?!\*)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function stripMarkdown(s) {
  const noBold = String(s).replace(/\*\*/g, "");
  return cleanInline(noBold.replace(/^\s*(?:#+\s+|>\s?|[-*•]\s+|\d+[.)]\s+)/gm, "").replace(/\|/g, " "));
}

// 검색 답변(마크다운 일부) → 블록. 표·번호 목록·글머리 목록·'> ' 주의·문단만 인식한다.
function markdownToBlocks(md) {
  const lines = String(md).replace(/\r/g, "").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    const text = cleanInline(para.join(" "));
    if (text) blocks.push({ type: "paragraph", text });
    para = [];
  };
  const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => cleanInline(c));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); continue; }
    // 표: | a | b | 다음 줄이 |---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara();
      const columns = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      i--;
      blocks.push({ type: "table", columns, rows });
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ol || ul) {
      flushPara();
      const type = ol ? "steps" : "bullets";
      const last = blocks[blocks.length - 1];
      const item = cleanInline((ol || ul)[1]);
      if (last && last.type === type) last.items.push(item); else blocks.push({ type, items: [item] });
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) { flushPara(); blocks.push({ type: "callout", tone: "warning", text: cleanInline(q[1]) }); continue; }
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { flushPara(); para.push(`**${h[1]}**`); flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return blocks;
}

// 블록에서 대화 기록·호환용 한두 문장 요약을 뽑는다 (서식 제거)
function summarizeBlocks(blocks) {
  const first = blocks.find(b => b.type === "paragraph" || b.type === "callout");
  return first ? stripMarkdown(first.text).slice(0, 300) : "";
}

// AI가 만든 블록을 검사·정리한다. pins 블록은 강남역 질문의 실제 핀만 남긴다.
function sanitizeBlocks(raw, byId) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const b of raw) {
    if (!b || !BLOCK_TYPES.includes(b.type) || out.length >= MAX_BLOCKS) continue;
    const title = clip(b.title, 60) || undefined;
    if (b.type === "paragraph") {
      const text = cleanInline(clip(b.text, 600));
      if (text) out.push({ type: "paragraph", text });
    } else if (b.type === "callout") {
      const text = cleanInline(clip(b.text, 300));
      const tone = ["info", "warning", "emergency"].includes(b.tone) ? b.tone : "info";
      if (text) out.push({ type: "callout", tone, text, title });
    } else if (b.type === "steps" || b.type === "bullets") {
      const items = (Array.isArray(b.items) ? b.items : []).map(x => cleanInline(clip(x, 200))).filter(Boolean).slice(0, MAX_ITEMS);
      if (items.length) out.push({ type: b.type, title, items });
    } else if (b.type === "table") {
      const columns = (Array.isArray(b.columns) ? b.columns : []).map(x => cleanInline(clip(x, 40))).slice(0, MAX_COLS);
      const rows = (Array.isArray(b.rows) ? b.rows : [])
        .filter(Array.isArray)
        .slice(0, MAX_ROWS)
        .map(r => columns.map((_, i) => cleanInline(clip(r[i], 120))));
      if (columns.length >= 2 && rows.length) out.push({ type: "table", title, columns, rows });
    } else if (b.type === "pins") {
      const pinIds = [...new Set((Array.isArray(b.pinIds) ? b.pinIds : []).map(String))].filter(id => byId.has(id)).slice(0, 6);
      if (pinIds.length) out.push({ type: "pins", title, pinIds });
    }
  }
  return out;
}

// 강남역 핀을 안내(focus_pin)하는데 핀 카드 블록이 없으면 자동으로 붙인다.
// 안내 핀 + 같은 시설의 다른 핀(같은 층 우선), 최대 4개. 블록이 아예 없으면 요약 문단부터 만든다.
function ensurePinCards(blocks, actions, pins, summary) {
  const focus = actions.find(a => a.type === "focus_pin");
  if (!focus || blocks.some(b => b.type === "pins")) return blocks;
  const fp = pins.find(p => String(p.id) === focus.pinId);
  if (!fp) return blocks;
  // '기타'는 서로 다른 시설(고객안전실·수유실 등)을 모은 분류라 같은 시설로 묶지 않는다
  const same = fp.category === "기타" ? [] : pins
    .filter(p => p.category === fp.category && String(p.id) !== focus.pinId)
    .sort((a, b) => (a.floor === fp.floor ? 0 : 1) - (b.floor === fp.floor ? 0 : 1));
  const card = { type: "pins", pinIds: [focus.pinId, ...same.slice(0, 3).map(p => String(p.id))] };
  const result = blocks.length ? blocks.slice() : (summary ? [{ type: "paragraph", text: summary }] : []);
  // 맨 앞의 요약 문단·주의 상자 바로 뒤에 넣는다
  let at = 0;
  while (at < result.length && (result[at].type === "paragraph" || result[at].type === "callout") && at < 2) at++;
  result.splice(at, 0, card);
  return result.slice(0, MAX_BLOCKS);
}

// 2단계: Google 검색 그라운딩으로 일반 글 답변을 받는다 (형식 강제 없음)
async function searchAnswer(env, ctx, turns, draft) {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const system = [
    "너는 서울 지하철 안내 앱 'sub note'의 도우미다. 사용자의 마지막 질문에 Google 검색으로 최신 정보를 확인해 답한다.",
    "한국어 존댓말로, 모바일 화면에서 한눈에 읽히게 쓴다. URL·각주 번호·제목(#)은 쓰지 않는다.",
    "형식: 첫 줄은 핵심을 1~2문장으로 요약한다. 그 아래는 내용에 맞게 다음 서식만 쓴다.",
    "- 순서가 있는 방법·동선은 '1. ' 번호 목록 (최대 6개)",
    "- 여러 장소·선택지는 '- ' 글머리 목록 (최대 6개), 각 항목은 한 줄로",
    "- 2개 이상을 같은 기준(위치·운영시간·요금 등)으로 비교할 때만 마크다운 표 (열 4개, 행 6개 이하)",
    "- 꼭 알아야 할 주의 사항은 '> ' 로 시작하는 한 줄",
    "- 중요한 단어는 **굵게**. 그 밖의 마크다운은 쓰지 않는다. 전체 분량은 짧게 유지한다.",
    "확인되지 않은 내용은 단정하지 말고, 바뀔 수 있는 정보(운영 시간 등)는 방문 전 확인을 권한다.",
    "생명·안전이 걸린 상황이면 첫 줄에 119 신고와 역무원 호출을 안내한다.",
    draft.aboutStation ? `질문 대상: ${draft.aboutStation}` : "",
    draft.route ? "경로 단계는 화면에 따로 표시되므로 번호 목록으로 다시 쓰지 말고, 들를 곳 정보와 주의 사항 위주로 쓴다." : "",
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

// 앱이 보낸 분류 체계 (층 → 상황 그룹 → 시설). 형식이 이상하면 빈 배열
function readCategoryGroups(ctx) {
  const groups = Array.isArray(ctx.categoryGroups) ? ctx.categoryGroups : [];
  return groups
    .filter(g => g && typeof g.id === "string" && typeof g.label === "string" && Array.isArray(g.categories))
    .slice(0, 20)
    .map(g => ({ id: g.id, label: g.label, categories: g.categories.filter(c => typeof c === "string").slice(0, 40) }));
}

// 핀 목록을 상황 그룹 → 시설 → 핀(층) 순서로 정리한 글. 핀이 없는 시설도 "등록된 핀 없음"으로 적는다.
function formatPinsByCategory(groups, pins) {
  const line = p => `    - id=${p.id} | ${p.floor} | ${p.title}${p.desc ? " | " + p.desc : ""}`;
  if (!groups.length) {
    return pins.map(p => `- id=${p.id} | ${p.floor} | ${p.category} | ${p.title}${p.desc ? " | " + p.desc : ""}`).join("\n");
  }
  const out = [];
  const used = new Set();
  for (const g of groups) {
    out.push(`[${g.label}] (group=${g.id})`);
    for (const c of g.categories) {
      const list = pins.filter(p => p.category === c);
      list.forEach(p => used.add(p));
      out.push(list.length ? `  · ${c} (${list.length}개)` : `  · ${c}: 등록된 핀 없음`);
      list.sort((a, b) => String(a.floor).localeCompare(String(b.floor))).forEach(p => out.push(line(p)));
    }
  }
  const rest = pins.filter(p => !used.has(p));
  if (rest.length) { out.push("[분류 없음]"); rest.forEach(p => out.push(line(p))); }
  return out.join("\n");
}

function buildSystemPrompt(ctx, pins, webSearch) {
  const station = ctx.currentStation || "(선택 안 함)";
  const indoor = ctx.indoor ? `실내 지도 ${ctx.indoor.activeFloor}층, ${ctx.indoor.mode} 화면` : "노선도 화면";
  const groups = readCategoryGroups(ctx);
  const taxonomy = groups.map(g => `- ${g.label} (group=${g.id}): ${g.categories.join(", ")}`).join("\n");
  // 웹 검색은 이 단계에서 직접 하지 않는다. needsWebSearch=true면 서버가 2단계(searchAnswer)에서 검색해 답변 글을 바꾼다.
  const research = webSearch
    ? "needsWebSearch를 true로 하고, replyText에는 아는 범위의 짧은 초안을 쓴다(검색 후 서버가 교체한다)."
    : "일반적으로 알려진 정보로 답한다.";

  return [
    "너는 서울 지하철 실내 내비게이션 앱 'sub note'의 안내 도우미다. 한국어 존댓말로 짧고 명확하게 답한다.",
    "",
    "[질문 범위: 가장 먼저 판단한다]",
    "- 답하는 질문(길안내 관련): 지하철 경로·환승·소요 시간, 역 찾기·출구, 역 안과 역 주변 시설 위치(화장실·엘리베이터·가게 등),",
    "  이동 중 들를 곳(예: 가는 길에 꽃집), 요금·운행·막차 등 지하철 이용, 역 안 비상 상황 대처.",
    "- 이전 대화에 이어지는 짧은 질문(예: '거기서 몇 분 걸려?', '엘리베이터는?')은 이전 대화 주제를 따라 판단한다.",
    "- 그 밖의 질문(날씨, 상식·학습, 코딩, 번역, 잡담·인사, 길안내와 무관한 추천 등)은 답하지 않는다:",
    "  intent=off_topic, aboutStation=null, needsWebSearch=false, replyText='', blocks=[], route=null, actions=[] 로만 낸다.",
    "- 길안내와 조금이라도 관련 있으면 off_topic으로 막지 않는다.",
    "",
    "[질문 대상 역 판단]",
    "- 먼저 질문이 어느 역에 대한 것인지 판단해 aboutStation에 역 이름(예: '강남역', '잠실역')을 쓴다. 특정 역이 아니면 null.",
    "- 사용자가 지금 강남역 실내 지도를 보고 있어도, 질문이 다른 역(예: '잠실역 가는 중')에 관한 것이면 그 역이 대상이다.",
    "- 사용자가 강남역 실내 지도를 보면서 역 이름 없이 시설을 물으면(예: '화장실 어디야?') 강남역 질문이다.",
    "",
    "[처리 경로는 두 가지다. aboutStation으로 먼저 고른다]",
    "- A. 강남역 질문 → 아래 분류 체계와 [강남역 시설 데이터]의 핀에서 찾는다.",
    "- B. 다른 역 질문 → 분류 체계·핀·A의 절차를 전혀 쓰지 않는다. 웹 검색으로 답한다(아래 [다른 역 질문]).",
    "",
    "[A. 강남역 시설 분류 체계: 층 → 상황 → 시설] (강남역 질문에만 사용)",
    taxonomy || "(분류 정보 없음)",
    "",
    "[A. 강남역 시설 찾기 절차] (강남역 질문에만 적용)",
    "1) 상황·시설로 바꾸기: 질문 속 필요를 위 분류의 상황 그룹과 시설로 바꾼다. 시설 이름을 직접 말하지 않아도 추론한다.",
    "   예) 사람이 쓰러짐·심정지 → 비상시>AED / 불·연기 → 비상시>소화전 / 정전·어두움 → 비상시>휴대용 비상손전등 /",
    "       다침·응급처치 → 비상시>구호용품 보관함 / 위급 신고 → 비상시>비상전화 / 목마름·음료 → 상가·음식>자판기 또는 상가 /",
    "       짐 맡기기 → 편의시설>물품보관함 / 휴대폰 배터리 → 편의시설>충전기 / 쉬고 싶음 → 편의시설>벤치 /",
    "       휠체어·유모차·큰 짐 → 이동·탑승>엘리베이터 / 표·교통카드 충전 → 표·금융>표사는 곳 / 현금 → 표·금융>ATM기",
    "2) 층으로 거르기: 사용자가 층을 말했으면 그 층, 아니면 지금 보고 있는 층의 핀을 먼저 고르고, 없으면 가까운 층(B1↔B2↔B3↔B4)에서 고른다.",
    "3) 답하기: 가장 알맞은 핀 하나를 actions에 focus_pin(pinId)으로 넣고, 답변에 층과 세부 위치 설명을 구체적으로 쓴다. intent=pin_locate.",
    "   같은 시설 핀이 2개 이상이면 actions에 show_category(group, category)도 넣어 지도에 그 시설을 모두 보여준다.",
    "4) 해당 시설 핀이 없으면: '아직 앱에 등록되지 않았다'고 말하고, 같은 상황 그룹의 다른 시설 핀이 있으면 대안으로 안내한다(focus_pin).",
    `   비상 상황이 아니면 ${research}`,
    "5) 강남역 비상시 질문: 생명·안전이 걸리면 119 신고와 가까운 역무원·비상전화 이용을 가장 먼저 짧게 안내한 뒤 핀 위치를 알려준다. 속도가 중요하므로 needsWebSearch=false.",
    "",
    "[B. 다른 역 질문 / 일반 질문]",
    "- 강남역 분류 체계·데이터·핀은 절대 쓰지 않는다. actions는 빈 배열이다.",
    "- 다른 역의 시설 위치·출구·주변 가게·운영 정보 질문은 비상시 시설(AED 등)이라도 항상 needsWebSearch=true. 추측으로 위치를 말하지 않는다.",
    "- 생명·안전이 걸린 상황이면 replyText 첫 문장에 119 신고와 역무원 호출을 안내한다.",
    `- 그 밖의 정보도 ${research}`,
    "- 특정 가게·시설 위치, 운영 시간처럼 바뀔 수 있는 정보는 확인한 범위에서 말하고, 확실하지 않으면 그렇다고 밝힌다.",
    "",
    "[경로 계획]",
    "- 출발역·도착역·중간 들를 곳이 있으면 intent=route_plan으로 route.steps를 순서대로 채운다.",
    "- kind는 ride(열차 탑승), transfer(환승), walk(도보), stop(들를 곳) 중 하나다. 각 step의 text에 사람이 읽을 한 줄 설명을 쓴다.",
    "- 환승이 적고 단순한 경로를 우선한다. 소요 시간·실시간 운행은 확실하지 않으면 단정하지 않는다.",
    "",
    "[웹 검색 필요 여부 needsWebSearch]",
    "- true: 강남역 데이터로 답할 수 없는 사실 정보가 필요할 때 (다른 역의 시설·출구·주변 가게, 운영 시간, 요금, 최근 운행 소식 등).",
    "- false: 강남역 데이터로 답하는 질문, 강남역 비상시 질문, 단순한 경로 계획, 인사나 간단한 일반 질문.",
    "",
    "[답변 형식: replyText + blocks]",
    "- replyText: 핵심을 1~2문장으로 요약한 일반 글 (서식 없이). 화면에는 blocks가 있으면 blocks를 보여준다.",
    "- blocks: 모바일 화면에서 한눈에 읽히도록 내용을 나눠 담는다. 최대 5개, 짧게. 내용에 맞는 것만 쓴다.",
    "  · paragraph(text): 요약·설명 한두 문장. 보통 맨 앞에 하나.",
    "  · steps(title, items): 순서가 있는 방법·동선 (예: '개찰구 통과 → 왼쪽 통로 → 엘리베이터'). 항목은 한 줄씩.",
    "  · bullets(title, items): 순서 없는 여러 선택지·특징.",
    "  · table(title, columns, rows): 2개 이상을 같은 기준(층·위치·특징 등)으로 비교할 때. 열 4개·행 6개 이하. rows의 각 행은 columns 순서대로.",
    "  · callout(tone, text): 꼭 알아야 할 한 줄. tone=emergency(생명·안전, 119 안내), warning(주의), info(참고).",
    "  · pins(title, pinIds): 강남역 질문에서 안내하는 핀들을 카드(아이콘·층·위치)로 보여준다. 여러 후보면 가까운 순으로 최대 4개.",
    "- 강남역 시설 질문 예: [paragraph 요약] → [pins 후보] → 필요하면 [steps 가는 방법]. 비상시는 [callout emergency]를 맨 앞에.",
    "- 경로 계획은 route에 담으면 화면이 따로 단계별로 그리므로, blocks에 같은 단계를 반복하지 않는다(요약 paragraph와 주의 callout 정도만).",
    "- 각 블록에서 쓰지 않는 필드는 null. 중요한 단어만 **굵게** 표시할 수 있다. 다른 마크다운은 쓰지 않는다.",
    "",
    "[출력 규칙]",
    "- actions 항목: focus_pin은 pinId만, show_category는 group(분류 체계의 group 값)과 category(시설 이름, 그룹 전체면 null)만 채우고 나머지는 null.",
    "- pinId는 반드시 [강남역 시설 데이터]의 id를 그대로 쓴다. 없는 id를 만들지 않는다.",
    "- 경로 질문이 아니면 route는 null, 지도 이동이 필요 없으면 actions는 빈 배열로 둔다.",
    "- step에서 해당 없는 필드는 null로 둔다. replyText에는 URL이나 각주 번호, 핀 id를 넣지 않는다.",
    "",
    `[현재 상태] 선택한 역: ${station}, 화면: ${indoor}`,
    "",
    "[강남역 시설 데이터] (강남역 질문에만 사용. 상황 > 시설 > id | 층 | 이름 | 설명)",
    formatPinsByCategory(groups, pins) || "(없음)",
  ].join("\n");
}

// 강남역에 대한 답일 때만 핀을 쓴다 (강남구청역은 제외)
function isGangnam(aboutStation) {
  return typeof aboutStation === "string" && aboutStation.includes("강남") && !aboutStation.includes("강남구청");
}

// OpenAI strict 모드용 응답 스키마 (모든 필드 required, 없으면 null)
const nullableStr = { type: ["string", "null"] };
const nullableStrArr = { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] };
// 답변 블록 종류 (규격 0.4). 앱은 모르는 type을 무시한다.
const BLOCK_TYPES = ["paragraph", "steps", "bullets", "table", "callout", "pins"];
const OPENAI_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aboutStation", "needsWebSearch", "intent", "replyText", "blocks", "route", "actions"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "text", "tone", "items", "columns", "rows", "pinIds"],
        properties: {
          type: { type: "string", enum: BLOCK_TYPES },
          title: nullableStr, text: nullableStr,
          tone: { anyOf: [{ type: "string", enum: ["info", "warning", "emergency"] }, { type: "null" }] },
          items: nullableStrArr, columns: nullableStrArr, pinIds: nullableStrArr,
          rows: { anyOf: [{ type: "array", items: { type: "array", items: { type: "string" } } }, { type: "null" }] },
        },
      },
    },
    aboutStation: nullableStr,
    needsWebSearch: { type: "boolean" },
    intent: { type: "string", enum: ["route_plan", "station_info", "pin_locate", "general", "off_topic"] },
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
        required: ["type", "pinId", "group", "category"],
        properties: {
          type: { type: "string", enum: ["focus_pin", "show_category"] },
          pinId: nullableStr, group: nullableStr, category: nullableStr,
        },
      },
    },
  },
};

// Gemini responseSchema (OpenAPI 부분집합: 대문자 type, nullable 사용)
const gStr = { type: "STRING", nullable: true };
const GEMINI_REPLY_SCHEMA = {
  type: "OBJECT",
  required: ["aboutStation", "needsWebSearch", "intent", "replyText", "blocks", "route", "actions"],
  propertyOrdering: ["aboutStation", "needsWebSearch", "intent", "replyText", "blocks", "route", "actions"],
  properties: {
    blocks: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["type"],
        properties: {
          type: { type: "STRING", enum: BLOCK_TYPES },
          title: gStr, text: gStr,
          tone: { type: "STRING", enum: ["info", "warning", "emergency"], nullable: true },
          items: { type: "ARRAY", items: { type: "STRING" }, nullable: true },
          columns: { type: "ARRAY", items: { type: "STRING" }, nullable: true },
          rows: { type: "ARRAY", items: { type: "ARRAY", items: { type: "STRING" } }, nullable: true },
          pinIds: { type: "ARRAY", items: { type: "STRING" }, nullable: true },
        },
      },
    },
    aboutStation: gStr,
    needsWebSearch: { type: "BOOLEAN" },
    intent: { type: "STRING", enum: ["route_plan", "station_info", "pin_locate", "general", "off_topic"] },
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
        required: ["type"],
        properties: {
          type: { type: "STRING", enum: ["focus_pin", "show_category"] },
          pinId: gStr, group: gStr, category: gStr,
        },
      },
    },
  },
};

// AI 출력 → 규격(ChatResponse)으로 변환. 없는 pinId는 지우고, floor는 우리 데이터에서 채운다.
// 강남역이 아닌 질문이면 핀(actions, step.pinId)을 모두 버린다.
function toChatResponse(out, allPins, groups = []) {
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
  const rawActions = Array.isArray(out.actions) ? out.actions : [];
  const actions = rawActions
    .filter(a => a && a.type === "focus_pin" && byId.has(String(a.pinId)))
    .slice(0, 1)
    .map(a => ({ type: "focus_pin", pinId: String(a.pinId), floor: byId.get(String(a.pinId)).floor }));
  // show_category: 강남역 질문이고, 앱이 보낸 분류 체계에 있는 그룹/시설일 때만 (최대 1개)
  if (pins.length) {
    const show = rawActions.find(a => a && a.type === "show_category" && groups.some(g =>
      g.id === a.group && (!a.category || g.categories.includes(a.category))));
    if (show) {
      // AI가 그룹만 주고 시설을 비웠으면, 안내하는 핀의 시설로 좁힌다 (같은 그룹일 때만)
      let category = show.category || null;
      const focusPin = actions.length ? byId.get(actions[0].pinId) : null;
      const group = groups.find(g => g.id === show.group);
      if (!category && focusPin && group.categories.includes(focusPin.category)) category = focusPin.category;
      actions.push({ type: "show_category", group: show.group, category });
    }
  }

  const reply = { text: typeof out.replyText === "string" && out.replyText ? stripMarkdown(out.replyText) : "답변이 비어 있습니다." };
  let blocks = sanitizeBlocks(out.blocks, byId);
  // 경로가 있으면 화면이 route를 단계별로 따로 그리므로, 같은 내용의 번호 목록 블록은 뺀다
  if (route && route.steps.length) blocks = blocks.filter(b => b.type !== "steps");
  blocks = ensurePinCards(blocks, actions, pins, reply.text);
  // 119 안내가 있는데 비상 상자가 없으면, 첫 문단을 비상 상자로 바꿔 눈에 띄게 한다
  if (/119/.test(reply.text) && !blocks.some(b => b.type === "callout" && b.tone === "emergency")) {
    const i = blocks.findIndex(b => b.type === "paragraph" && /119/.test(b.text));
    if (i >= 0) blocks[i] = { type: "callout", tone: "emergency", text: blocks[i].text };
    else blocks.unshift({ type: "callout", tone: "emergency", text: reply.text });
    blocks = blocks.slice(0, MAX_BLOCKS);
  }
  if (blocks.length) reply.blocks = blocks;
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

// 길안내와 무관한 질문에 대한 고정 응답 (규격 0.5: intent=off_topic)
function offTopicResponse() {
  const text = "sub note는 지하철 길안내와 역 시설 안내만 도와드릴 수 있어요. 길안내와 관련된 내용으로 다시 질문해주세요.";
  return {
    schemaVersion: SCHEMA_VERSION,
    intent: "off_topic",
    aboutStation: null,
    reply: {
      text,
      blocks: [
        { type: "callout", tone: "info", text },
        { type: "bullets", title: "이렇게 물어보세요", items: [
          "건대입구역에서 판교역까지 어떻게 가?",
          "강남역 화장실 어디 있어?",
          "엘리베이터 있는 출구 알려줘",
        ] },
      ],
    },
    route: null,
    actions: [],
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
