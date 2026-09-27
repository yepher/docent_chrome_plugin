// LiveKit Inference client: an OpenAI-compatible gateway in front of many LLMs.
// Auth is a short-lived LiveKit access token (HS256 JWT) carrying an
// `inference.perform` grant, minted here from your API key and secret, the same
// way the LiveKit Agents SDK does it (livekit/agents inference/_utils.py).

export const PROD_GATEWAY = "https://agent-gateway.livekit.cloud/v1";
export const STAGING_GATEWAY = "https://agent-gateway.staging.livekit.cloud/v1";

// Fallback list if the gateway's /models can't be read (from the Agents SDK's model literals).
export const KNOWN_MODELS = [
  "openai/gpt-4.1-mini", "openai/gpt-4.1-nano", "openai/gpt-4.1", "openai/gpt-4o-mini", "openai/gpt-4o",
  "openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-5", "openai/gpt-5.1", "openai/gpt-5.2",
  "openai/gpt-5.4-mini", "openai/gpt-5.4-nano", "openai/gpt-5.4", "openai/gpt-5.5", "openai/gpt-oss-120b",
  "google/gemini-2.5-flash-lite", "google/gemini-2.5-flash", "google/gemini-2.5-pro",
  "google/gemini-3-flash", "google/gemini-3.1-flash-lite", "google/gemini-3.1-pro", "google/gemini-3.5-flash",
  "moonshotai/kimi-k2.5", "moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v3", "deepseek-ai/deepseek-v3.2",
  "zai/glm-5.1", "xai/grok-4-1-fast-non-reasoning", "xai/grok-4.3", "xai/grok-4.5",
];
export const DEFAULT_MODEL = "openai/gpt-4.1-mini";

export function lkConfigured(s) {
  return !!(s.lkApiKey && s.lkApiSecret && (s.lkUrl || s.lkInferenceUrl));
}

export function gatewayUrl(s) {
  if (s.lkInferenceUrl) return s.lkInferenceUrl.replace(/\/+$/, "");
  return /\.staging\.livekit\.cloud/i.test(s.lkUrl || "") ? STAGING_GATEWAY : PROD_GATEWAY;
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function mintToken(apiKey, apiSecret, ttlSeconds = 600) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ inference: { perform: true }, sub: "jev-chrome", iss: apiKey, nbf: now, exp: now + ttlSeconds });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(apiSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

async function authHeaders(s) {
  return {
    Authorization: `Bearer ${await mintToken(s.lkApiKey, s.lkApiSecret)}`,
    "Content-Type": "application/json",
  };
}

function explain(status, text) {
  const hint =
    status === 401 || status === 403 ? "LiveKit rejected the credentials (check API key and secret, and that Inference is enabled on the project)." :
    status === 404 ? "Model or endpoint not found (check the model name)." :
    status === 429 ? "LiveKit Inference rate limit or quota reached." :
    `HTTP ${status}`;
  return new Error(`${hint} ${String(text).slice(0, 300)}`.trim());
}

export async function listModels(s) {
  const res = await fetch(`${gatewayUrl(s)}/models`, { headers: await authHeaders(s) });
  if (!res.ok) throw explain(res.status, await res.text().catch(() => ""));
  const data = await res.json();
  const ids = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
  return ids.length ? ids.sort() : KNOWN_MODELS;
}

// Streams a chat completion. onDelta(textSoFar) is called as tokens arrive. Returns the full text.
// Reasoning models (OpenAI gpt-5*, o1/o3/o4…) think before answering, and the thinking
// counts against max_completion_tokens. With a small limit they can spend it all and
// return an empty answer, so ask for low effort and leave room for the thinking.
export const isReasoningModel = (model) => /(^|\/)(gpt-5|o1|o3|o4)(\b|[-.])/i.test(model || "");
const REASONING_HEADROOM = 4000;

export async function chat(s, messages, opts = {}) {
  const text = await chatOnce(s, messages, opts, false);
  // Still empty because the limit ran out while thinking: try once more with no limit.
  if (!text.trim() && chat.lastFinish === "length" && !opts.signal?.aborted) return chatOnce(s, messages, opts, true);
  return text;
}

async function chatOnce(s, messages, { onDelta, signal, maxTokens = 800 } = {}, unlimited) {
  const model = s.lkModel || DEFAULT_MODEL;
  const reasoning = isReasoningModel(model);
  const body = { model, messages, stream: true };
  if (maxTokens && !unlimited) body.max_completion_tokens = maxTokens + (reasoning ? REASONING_HEADROOM : 0);
  if (reasoning) body.reasoning_effort = "low";
  let res = await fetch(`${gatewayUrl(s)}/chat/completions`, { method: "POST", headers: await authHeaders(s), body: JSON.stringify(body), signal });
  if (res.status === 400 && (body.reasoning_effort || body.max_completion_tokens)) {
    // Some providers reject reasoning_effort or max_completion_tokens; retry without them.
    delete body.reasoning_effort;
    delete body.max_completion_tokens;
    res = await fetch(`${gatewayUrl(s)}/chat/completions`, { method: "POST", headers: await authHeaders(s), body: JSON.stringify(body), signal });
  }
  if (!res.ok) throw explain(res.status, await res.text().catch(() => ""));
  chat.lastFinish = null;

  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("event-stream")) {
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    chat.lastFinish = data.choices?.[0]?.finish_reason || null;
    onDelta?.(text);
    return text;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return text;
      try {
        const choice = JSON.parse(payload).choices?.[0];
        if (choice?.finish_reason) chat.lastFinish = choice.finish_reason;
        const delta = choice?.delta?.content;
        if (delta) { text += delta; onDelta?.(text); }
      } catch (_) { /* partial or non-JSON line */ }
    }
  }
  return text;
}
