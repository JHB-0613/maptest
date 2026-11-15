// Vercel 함수: POST /api/chat  (실제 로직은 ../lib/ai-chat.js)
import { handleChatRequest, corsHeaders } from "../lib/ai-chat.js";

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function POST(request) {
  return handleChatRequest(request, process.env);
}
