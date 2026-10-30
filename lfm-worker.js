// LFM3-Omni, in the browser: a module worker (started by the offscreen document) that
// downloads the text decoder once, keeps it in Cache Storage, and writes text with
// ONNX Runtime Web on WebGPU. No server and no API key: nothing leaves the browser
// except the one-time download.
//
// Only the q4f16 decoder is used, so the vision, audio and speech graphs aren't downloaded.
// See the model card: https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX

import * as ort from "./vendor/lfm/ort.webgpu.min.mjs";
import { Tokenizer } from "./vendor/laya/tokenizers.min.mjs";

const REVISION = "7d6bd3fd59a0622e5ce7fefc141145a8bba1435a";
const BASE = `https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX/resolve/${REVISION}/`;
const CACHE = `lfm-${REVISION.slice(0, 16)}`;
const WEIGHTS = "decoder_q4f16.onnx_data";
const WEIGHTS_SIZE = 1413388288;
const PART_SIZE = 64 * 1048576;
const VOCAB = 128000;
const EOS = new Set([124900, 125014]);   // <|im_end|> and the end of text
const PREFILL_CHUNK = 1024;              // the model card's limit per decoder run on WebGPU
const MAX_PROMPT_TOKENS = 32000;         // long transcripts are about 25,000

let session = null, tokenizer = null, info = null;
let loading = null;  // Promise while loading
const aborted = new Set();

const post = (m) => self.postMessage(m);
const progress = (text, frac) => post({ type: "progress", text, frac });
const mb = (n) => Math.round(n / 1048576);

async function cachedBytes(cache, url, fetchIt) {
  try { const hit = cache && (await cache.match(url)); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch (_) {}
  const bytes = await fetchIt();
  try { if (cache) await cache.put(url, new Response(bytes)); } catch (_) { /* quota: just don't cache */ }
  return bytes;
}

async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// The weights are one 1.4 GB file, so they're fetched and cached in parts: an interrupted
// download picks up at the last finished part.
async function fetchWeights(cache) {
  const url = `${BASE}onnx/${WEIGHTS}`;
  const out = new Uint8Array(WEIGHTS_SIZE);
  for (let off = 0; off < WEIGHTS_SIZE; off += PART_SIZE) {
    const end = Math.min(off + PART_SIZE, WEIGHTS_SIZE);
    const bytes = await cachedBytes(cache, `${url}?part=${off / PART_SIZE}`, async () => {
      const res = await fetch(url, { headers: { Range: `bytes=${off}-${end - 1}` } });
      if (res.status !== 206) throw new Error(`${WEIGHTS}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    if (bytes.length !== end - off) throw new Error("The model download is incomplete. Delete the download and try again.");
    out.set(bytes, off);
    progress(`Getting LFM3-Omni: ${mb(end)} of ${mb(WEIGHTS_SIZE)} MB`, end / WEIGHTS_SIZE);
  }
  return out;
}

async function load() {
  if (session) return info;
  const adapter = await self.navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) throw new Error("LFM3-Omni needs WebGPU, which isn't available in this browser.");

  const t0 = performance.now();
  ort.env.wasm.wasmPaths = new URL("./vendor/lfm/", self.location.href).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (_) {}
  progress("Getting LFM3-Omni…", 0);
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const [tj, tc, graph] = await Promise.all(["tokenizer.json", "tokenizer_config.json", "onnx/decoder_q4f16.onnx"]
    .map((f) => cachedBytes(cache, BASE + f, () => fetchFile(BASE + f))));
  tokenizer = new Tokenizer(decode(tj), decode(tc));
  const data = await fetchWeights(cache);
  progress("Starting LFM3-Omni…", 1);
  session = await ort.InferenceSession.create(graph, {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "disabled",
    preferredOutputLocation: "gpu-buffer", // the caches stay on the GPU between steps
    externalData: [{ path: WEIGHTS, data }],
  });
  info = { sizeMB: mb(WEIGHTS_SIZE), loadMs: Math.round(performance.now() - t0) };
  progress("LFM3-Omni ready.", 1);
  return info;
}

// Renders the parts of the model's chat template that text needs. Page text is untrusted,
// and the tokenizer turns "<|im_end|>" written in it into the real control token, so "<|"
// is broken up: a page can't end its turn or write one for the system.
function promptFor(messages) {
  const clean = (t) => String(t ?? "").replaceAll("<|", "< |");
  const system = messages.filter((m) => m.role === "system").map((m) => clean(m.content)).join("\n\n");
  let p = "<|startoftext|>";
  if (system) p += `<|im_start|>system\n${system}<|im_end|>\n`;
  for (const m of messages) if (m.role !== "system") p += `<|im_start|>${m.role}\n${clean(m.content)}<|im_end|>\n`;
  return `${p}<|im_start|>assistant\n<think></think>`;
}

const emptyCaches = () => {
  const past = {};
  for (const m of session.inputMetadata) {
    if (!m.name.startsWith("past_")) continue;
    const dims = m.shape.map((d) => (d === "batch_size" ? 1 : d === "past_sequence_length" ? 0 : d));
    past[m.name] = new ort.Tensor("float16", new Uint16Array(dims.reduce((a, b) => a * b, 1)), dims);
  }
  return past;
};
const noMedia = () => ({
  image_features: new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  video_features: new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  audio_features: new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  audio_out_codes: new ort.Tensor("int64", new BigInt64Array(0), [0, 12]),
  logits_to_keep: new ort.Tensor("int64", BigInt64Array.from([1n]), [1]),
});

// One decoder run over `ids`, after `seen` tokens already in the caches. Frees the old caches.
async function step(ids, past, seen) {
  const total = seen + ids.length;
  const out = await session.run({
    ...noMedia(), ...past,
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    attention_mask: new ort.Tensor("int64", new BigInt64Array(total).fill(1n), [1, total]),
    position_ids: new ort.Tensor("int64", BigInt64Array.from(ids, (_, i) => BigInt(seen + i)), [1, ids.length]),
  });
  for (const t of Object.values(past)) t.dispose();
  const next = {};
  for (const [k, t] of Object.entries(out)) {
    if (k.startsWith("present_conv.")) next[k.replace("present_conv.", "past_conv.")] = t;
    else if (k.startsWith("present.")) next[k.replace("present.", "past_key_values.")] = t;
  }
  out.hidden_states?.dispose();
  return { past: next, logits: out.logits };
}

async function greedy(logits) {
  const v = await logits.getData(), off = v.length - VOCAB;
  let best = 0;
  for (let i = 1; i < VOCAB; i++) if (v[off + i] > v[off + best]) best = i;
  return best;
}

async function generate({ reqId, messages, maxTokens }) {
  const ids = tokenizer.encode(promptFor(messages), { add_special_tokens: false }).ids;
  if (ids.length > MAX_PROMPT_TOKENS) throw new Error(`That's too much text for LFM3-Omni (${ids.length} tokens, limit ${MAX_PROMPT_TOKENS}).`);
  const stopped = () => aborted.has(reqId);
  let past = emptyCaches(), seen = 0, logits = null;
  const out = [];
  let text = "";
  try {
    for (let i = 0; i < ids.length && !stopped(); i += PREFILL_CHUNK) {
      const part = ids.slice(i, i + PREFILL_CHUNK);
      logits?.dispose();
      ({ past, logits } = await step(part, past, seen));
      seen += part.length;
    }
    while (!stopped() && out.length < maxTokens) {
      const next = await greedy(logits);
      if (EOS.has(next)) break;
      out.push(next);
      // A character split across tokens decodes to U+FFFD until the rest of it arrives.
      const sofar = tokenizer.decode(out, { skip_special_tokens: true });
      if (!sofar.endsWith("�")) { text = sofar; post({ type: "delta", reqId, text }); }
      logits.dispose();
      ({ past, logits } = await step([next], past, seen));
      seen++;
    }
  } finally {
    logits?.dispose();
    for (const t of Object.values(past)) t.dispose();
  }
  return text;
}

// Jobs run one at a time (the model is single-session), but a stop is heard straight away.
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "load") {
    loading = (loading || Promise.resolve()).then(load);
    loading.then((i) => post({ type: "result", id: m.id, info: i }), (e) => post({ type: "result", id: m.id, error: e.message || String(e) }))
      .finally(() => { loading = null; });
  } else if (m.type === "chat") {
    queue = queue.then(async () => {
      try {
        if (aborted.has(m.reqId)) return post({ type: "result", id: m.id, text: "", aborted: true });
        await (loading || load());
        const text = await generate(m);
        post({ type: "result", id: m.id, text, aborted: aborted.has(m.reqId) });
      } catch (e) {
        post({ type: "result", id: m.id, error: e.message || String(e) });
      } finally {
        aborted.delete(m.reqId);
      }
    });
  } else if (m.type === "abort") {
    aborted.add(m.reqId);
    post({ type: "result", id: m.id, ok: true });
  } else if (m.type === "status") {
    post({ type: "result", id: m.id, info, loading: !!loading });
  } else if (m.type === "clear") {
    (async () => {
      let n = 0;
      for (const k of await caches.keys()) if (k.startsWith("lfm-")) { await caches.delete(k); n++; }
      await session?.release().catch(() => {});
      session = null; tokenizer = null; info = null;
      post({ type: "result", id: m.id, cleared: n });
    })();
  }
};
