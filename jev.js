// Minimal client for the TypeSafe System One endpoint (POST /v1/systemone).
// Docs: https://docs.typesafe.ai/api

export class JevError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

export async function systemOne({ apiBase, apiKey, model, state, questions, signal, retries = 3 }) {
  const url = apiBase.replace(/\/+$/, "") + "/v1/systemone";
  const body = JSON.stringify({ state, model, questions });
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal,
      });
    } catch (e) {
      if (signal?.aborted || attempt >= retries) throw new JevError(`Network error: ${e.message}`, 0);
      await sleep(backoff(attempt++), signal);
      continue;
    }
    if (res.ok) return res.json();
    const text = await res.text().catch(() => "");
    if (RETRYABLE.has(res.status) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : backoff(attempt++), signal);
      continue;
    }
    const hint =
      res.status === 401 ? "Invalid or missing API key (check Settings)." :
      res.status === 422 ? "Request rejected by the API (validation error)." :
      `HTTP ${res.status}`;
    throw new JevError(`${hint} ${text.slice(0, 300)}`.trim(), res.status, text);
  }
}

function backoff(n) {
  return Math.min(8000, 500 * 2 ** n) + Math.random() * 250;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

// Question builders
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
export const noul = (instructions, criteria) =>
  criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
