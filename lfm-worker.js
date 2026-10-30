// LFM3-Omni, in the browser: a module worker (started by the offscreen document) that
// downloads the model once, keeps it in Cache Storage, and writes, speaks and listens with
// ONNX Runtime Web on WebGPU. No server and no API key: nothing leaves the browser
// except the one-time download.
//
// Text needs only the q4f16 decoder. The speech graphs are about 1 GB more, so they're
// fetched the first time voice is used, and the vision graphs never are.
// See the model card: https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX

import * as ort from "./vendor/lfm/ort.webgpu.min.mjs";
import { Tokenizer } from "./vendor/laya/tokenizers.min.mjs";
import { assess } from "./lfm-check.js";
import { logMel, Istft } from "./lfm-audio.js";

const REVISION = "7d6bd3fd59a0622e5ce7fefc141145a8bba1435a";
const BASE = `https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX/resolve/${REVISION}/`;
const CACHE = `lfm-${REVISION.slice(0, 16)}`;
const WEIGHTS = "decoder_q4f16.onnx_data";
const WEIGHTS_SIZE = 1413388288;
const VOICE_GRAPHS = { depth_decoder: 335597568, codec_decoder: 179046408, audio_encoder: 510351360 }; // name: weights size
const VOICE_SIZE = Object.values(VOICE_GRAPHS).reduce((a, b) => a + b, 0);
const PART_SIZE = 64 * 1048576;
const VOCAB = 128000;
const EOS = new Set([124900, 125014]);   // <|im_end|> and the end of text
const PREFILL_CHUNK = 1024;              // the model card's limit per decoder run on WebGPU
const MAX_PROMPT_TOKENS = 32000;         // long transcripts are about 25,000
const AUDIO_START = 125012, AUDIO_OUT = 125032, AUDIO_IN = 125031;   // tokens
const AUDIO_EOS = 2016, CODEBOOKS = 12, CODES = 2017, DEPTH_PASSES = 3;
const AUDIO_TEMPERATURE = 0.4, AUDIO_PENALTY = 1.2, AUDIO_PENALTY_WINDOW = 64;   // the model card's values
const STFT_PER_FRAME = 6, FRAME_SECONDS = 0.08, CHUNK_FRAMES = 12, MAX_FRAMES = 500;
const SPEECH_LANGUAGES = new Set(["Arabic", "Danish", "German", "Greek", "Finnish", "French", "Hebrew", "Italian", "Japanese", "Korean", "Dutch", "Polish", "Portuguese", "Spanish", "Swedish", "Turkish", "Chinese"]);

let session = null, tokenizer = null, info = null;
let voice = null;    // { depth_decoder, codec_decoder, audio_encoder } sessions
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
async function fetchWeights(cache, name, size, onPart) {
  const url = `${BASE}onnx/${name}`;
  const out = new Uint8Array(size);
  for (let off = 0; off < size; off += PART_SIZE) {
    const end = Math.min(off + PART_SIZE, size);
    const bytes = await cachedBytes(cache, `${url}?part=${off / PART_SIZE}`, async () => {
      const res = await fetch(url, { headers: { Range: `bytes=${off}-${end - 1}` } });
      if (res.status !== 206) throw new Error(`${name}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
    if (bytes.length !== end - off) throw new Error("The model download is incomplete. Delete the download and try again.");
    out.set(bytes, off);
    onPart(end);
  }
  return out;
}

const cachedParts = async (cache, name) => (await cache.keys()).filter((r) => r.url.includes(`/onnx/${name}?part=`)).length;

// What the GPU and disk can do. A finished download needs no more space.
async function hardware(withVoice) {
  const webgpu = !!self.navigator.gpu;
  const adapter = await self.navigator.gpu?.requestAdapter().catch(() => null);
  const gpu = adapter?.info;
  const files = { [WEIGHTS]: WEIGHTS_SIZE, ...(withVoice ? Object.fromEntries(Object.entries(VOICE_GRAPHS).map(([n, size]) => [`${n}.onnx_data`, size])) : {}) };
  const left = await (async () => {
    const cache = await caches.open(CACHE);
    let n = 0;
    for (const [name, size] of Object.entries(files)) n += Math.max(0, size - (await cachedParts(cache, name)) * PART_SIZE);
    return n;
  })().catch(() => Object.values(files).reduce((a, b) => a + b, 0));
  const { quota, usage } = await self.navigator.storage.estimate().catch(() => ({}));
  return {
    webgpu, adapter: !!adapter,
    software: !!gpu?.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${gpu?.description} ${gpu?.architecture}`),
    vendor: gpu?.vendor, architecture: gpu?.architecture, description: gpu?.description,
    shaderF16: !!adapter?.features.has("shader-f16"),
    maxBufferSize: adapter?.limits.maxBufferSize, maxStorageBufferBindingSize: adapter?.limits.maxStorageBufferBindingSize,
    freeBytes: quota == null ? null : quota - usage, neededBytes: left,
  };
}

async function load() {
  if (session) return info;
  const check = assess(await hardware());
  if (!check.ok) throw new Error(check.problems.join(" "));

  const t0 = performance.now();
  ort.env.wasm.wasmPaths = new URL("./vendor/lfm/", self.location.href).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (_) {}
  progress("Getting LFM3-Omni…", 0);
  const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
  const [tj, tc, graph] = await Promise.all(["tokenizer.json", "tokenizer_config.json", "onnx/decoder_q4f16.onnx"]
    .map((f) => cachedBytes(cache, BASE + f, () => fetchFile(BASE + f))));
  tokenizer = new Tokenizer(decode(tj), decode(tc));
  const data = await fetchWeights(cache, WEIGHTS, WEIGHTS_SIZE, (got) => progress(`Getting LFM3-Omni: ${mb(got)} of ${mb(WEIGHTS_SIZE)} MB`, got / WEIGHTS_SIZE));
  progress("Starting LFM3-Omni…", 1);
  session = await ort.InferenceSession.create(graph, {
    executionProviders: ["webgpu"],
    graphOptimizationLevel: "disabled",
    preferredOutputLocation: "gpu-buffer", // the caches stay on the GPU between steps
    externalData: [{ path: WEIGHTS, data }],
  }).catch((e) => { throw new Error(`LFM3-Omni couldn't start on this GPU, which may not have enough memory free (${e.message || e}).`); });
  info = { sizeMB: mb(WEIGHTS_SIZE), loadMs: Math.round(performance.now() - t0) };
  progress("LFM3-Omni ready.", 1);
  return info;
}

// The speech graphs, and how fast this GPU speaks (over 1 keeps up with playback).
async function loadVoice() {
  await load();
  if (voice) return info;
  const check = assess(await hardware(true));
  if (!check.ok) throw new Error(check.problems.join(" "));
  const t0 = performance.now();
  const cache = await caches.open(CACHE).catch(() => null);
  const sessions = {};
  let before = 0;
  for (const [name, size] of Object.entries(VOICE_GRAPHS)) {
    const url = `${BASE}onnx/${name}.onnx`;
    const graph = await cachedBytes(cache, url, () => fetchFile(url));
    const file = `${name}.onnx_data`;
    const data = await fetchWeights(cache, file, size, (got) => progress(`Getting LFM3-Omni speech: ${mb(before + got)} of ${mb(VOICE_SIZE)} MB`, (before + got) / VOICE_SIZE));
    before += size;
    progress("Starting LFM3-Omni speech…", 1);
    sessions[name] = await ort.InferenceSession.create(graph, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all", // over 4 times faster for the depth decoder
      externalData: [{ path: file, data }],
    }).catch((e) => { throw new Error(`LFM3-Omni speech couldn't start on this GPU, which may not have enough memory free (${e.message || e}).`); });
  }
  voice = sessions;
  const voiceLoadMs = Math.round(performance.now() - t0);
  // The first run compiles the GPU's shaders, so only the second one says how fast it is.
  const sample = "This is a short test of how quickly this computer can speak.";
  await speak({ reqId: "warm-up", text: sample, onChunk: () => {} });
  const t1 = performance.now();
  let frames = 0;
  await speak({ reqId: "speed-test", text: sample, onChunk: (pcm) => { frames += pcm.length / 1920; } });
  info = { ...info, speechSpeed: +((frames * FRAME_SECONDS) / ((performance.now() - t1) / 1000)).toFixed(2), voiceLoadMs };
  progress("LFM3-Omni speech ready.", 1);
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
const media = ({ audio, codes } = {}) => ({
  image_features: new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  video_features: new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  audio_features: audio || new ort.Tensor("float32", new Float32Array(0), [0, 2048]),
  audio_out_codes: codes || new ort.Tensor("int64", new BigInt64Array(0), [0, CODEBOOKS]),
  logits_to_keep: new ort.Tensor("int64", BigInt64Array.from([1n]), [1]),
});

// One decoder run over `ids`, after `seen` tokens already in the caches. Frees the old caches.
async function step(ids, past, seen, extra) {
  const total = seen + ids.length;
  const out = await session.run({
    ...media(extra), ...past,
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
  return { past: next, logits: out.logits, hidden: out.hidden_states };
}

// Feeds a whole prompt in chunks; audio holds the features of its AUDIO_IN tokens, in order.
async function prefill(ids, stopped, audio) {
  let past = emptyCaches(), seen = 0, logits = null, hidden = null, used = 0;
  for (let i = 0; i < ids.length && !stopped(); i += PREFILL_CHUNK) {
    const part = ids.slice(i, i + PREFILL_CHUNK), n = audio ? part.filter((t) => t === AUDIO_IN).length : 0;
    logits?.dispose();
    hidden?.dispose();
    ({ past, logits, hidden } = await step(part, past, seen, n ? { audio: new ort.Tensor("float32", audio.slice(used * 2048, (used + n) * 2048), [n, 2048]) } : undefined));
    seen += part.length;
    used += n;
  }
  return { past, logits, hidden, seen };
}
const release = (...tensors) => { for (const t of tensors) t?.dispose(); };

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
  let { past, logits, hidden, seen } = await prefill(ids, stopped);
  const out = [];
  let text = "";
  try {
    while (!stopped() && out.length < maxTokens) {
      await hearUrgent();
      const next = await greedy(logits);
      if (EOS.has(next)) break;
      out.push(next);
      // A character split across tokens decodes to U+FFFD until the rest of it arrives.
      const sofar = tokenizer.decode(out, { skip_special_tokens: true });
      if (!sofar.endsWith("�")) { text = sofar; post({ type: "delta", reqId, text }); }
      release(logits, hidden);
      ({ past, logits, hidden } = await step([next], past, seen));
      seen++;
    }
  } finally {
    release(logits, hidden, ...Object.values(past));
  }
  return text;
}

// ---------- speech ----------
function sampleCode(logits, off, history) {
  const s = new Float64Array(CODES);
  for (let i = 0; i < CODES; i++) s[i] = logits[off + i];
  for (const h of new Set(history)) s[h] = s[h] < 0 ? s[h] * AUDIO_PENALTY : s[h] / AUDIO_PENALTY;
  let top = -Infinity, sum = 0;
  for (let i = 0; i < CODES; i++) { s[i] /= AUDIO_TEMPERATURE; if (s[i] > top) top = s[i]; }
  for (let i = 0; i < CODES; i++) { s[i] = Math.exp(s[i] - top); sum += s[i]; }
  let r = Math.random() * sum;
  for (let i = 0; i < CODES; i++) { r -= s[i]; if (r <= 0) return i; }
  return AUDIO_EOS;
}

// One speech frame from a hidden state: the codebooks are revealed in random order over
// the depth decoder's passes. Returns null at the end of the speech.
async function sampleFrame(hiddenState, frames) {
  const hidden = new ort.Tensor("float32", hiddenState, [1, 2048]);
  const codes = new Array(CODEBOOKS).fill(0), revealed = new Array(CODEBOOKS).fill(false);
  const order = [...codes.keys()];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const perPass = CODEBOOKS / DEPTH_PASSES;
  for (let pass = 0; pass < DEPTH_PASSES; pass++) {
    const { logits } = await voice.depth_decoder.run({
      hidden_states: hidden,
      codes: new ort.Tensor("int64", BigInt64Array.from(codes, BigInt), [1, CODEBOOKS]),
      masked: new ort.Tensor("bool", Uint8Array.from(revealed, (r) => (r ? 0 : 1)), [1, CODEBOOKS]),
    });
    for (const i of order.slice(pass * perPass, (pass + 1) * perPass)) {
      codes[i] = sampleCode(logits.data, i * CODES, frames.slice(-AUDIO_PENALTY_WINDOW).map((f) => f[i]));
      if (codes[i] === AUDIO_EOS) return null;
      revealed[i] = true;
    }
  }
  return codes;
}

async function decodeFrames(frames) {
  const n = frames.length, flat = new BigInt64Array(CODEBOOKS * n);
  for (let f = 0; f < n; f++) for (let q = 0; q < CODEBOOKS; q++) flat[q * n + f] = BigInt(frames[f][q]);
  const { stft_features: features } = await voice.codec_decoder.run({ audio_codes: new ort.Tensor("int64", flat, [1, CODEBOOKS, n]) });
  return features.data;
}

function speechLanguage(code) {
  if (/^en-(gb|au|ie|nz)/i.test(code || "")) return "British English";
  let name = "";
  try { name = new Intl.DisplayNames(["en"], { type: "language" }).of(String(code || "").split("-")[0]); } catch (_) {}
  return SPEECH_LANGUAGES.has(name) ? name : "American English";
}

// Says one piece of text, handing over 24 kHz samples as they're ready.
async function speak({ reqId, text, voiceName = "female", language, onChunk }) {
  const prompt = promptFor([{ role: "system", content: `Perform TTS in ${speechLanguage(language)} using a ${voiceName === "male" ? "male" : "female"} voice.` }, { role: "user", content: text }]);
  const ids = [...tokenizer.encode(prompt, { add_special_tokens: false }).ids, AUDIO_START];
  const stopped = () => aborted.has(reqId);
  let { past, logits, hidden, seen } = await prefill(ids, stopped);
  const frames = [], istft = new Istft(MAX_FRAMES * STFT_PER_FRAME);
  let chunked = 0;
  try {
    while (!stopped() && frames.length < MAX_FRAMES) {
      await hearUrgent();
      const state = await hidden.getData();
      const codes = await sampleFrame(state.slice(-2048), frames);
      if (!codes) break;
      frames.push(codes);
      if (frames.length - chunked >= CHUNK_FRAMES) {
        chunked = frames.length;
        const pcm = istft.push(await decodeFrames(frames), chunked * STFT_PER_FRAME, false);
        if (pcm.length) onChunk(pcm);
      }
      release(logits, hidden);
      ({ past, logits, hidden } = await step([AUDIO_OUT], past, seen, { codes: new ort.Tensor("int64", BigInt64Array.from(codes, BigInt), [1, CODEBOOKS]) }));
      seen++;
    }
    if (!stopped() && frames.length) {
      const pcm = istft.push(await decodeFrames(frames), frames.length * STFT_PER_FRAME, true);
      if (pcm.length) onChunk(pcm);
    }
  } finally {
    release(logits, hidden, ...Object.values(past));
  }
}

// ---------- hearing ----------
async function transcribe({ pcm, language }) {
  await loading;
  await loadVoice();
  const { data, frames } = logMel(Float32Array.from(pcm, (v) => v / 32768));
  const { audio_features: features } = await voice.audio_encoder.run({ input_features: new ort.Tensor("float32", data, [1, 128, frames]) });
  const n = features.dims[0], audio = await features.getData();
  const lang = (() => { try { return new Intl.DisplayNames(["en"], { type: "language" }).of(String(language || "en").split("-")[0]); } catch (_) { return "English"; } })();
  const prompt = promptFor([{ role: "system", content: `Perform ASR in ${lang}.` }, { role: "user", content: "AUDIO" }]).replace("AUDIO", `<|vision_start|>${"<|audio|>".repeat(n)}<|vision_end|>`);
  const ids = tokenizer.encode(prompt, { add_special_tokens: false }).ids;
  let { past, logits, hidden, seen } = await prefill(ids, () => false, audio);
  const out = [];
  try {
    while (out.length < 400) {
      const next = await greedy(logits);
      if (EOS.has(next)) break;
      out.push(next);
      release(logits, hidden);
      ({ past, logits, hidden } = await step([next], past, seen));
      seen++;
    }
  } finally {
    release(logits, hidden, ...Object.values(past));
  }
  return tokenizer.decode(out, { skip_special_tokens: true }).trim();
}

// Hearing can't wait for a long answer or sentence to finish (that's how you interrupt
// Docent), so it runs between the steps of whatever else is going on.
const urgent = [];
async function hearUrgent() {
  while (urgent.length) {
    const m = urgent.shift();
    try {
      post({ type: "result", id: m.id, text: await transcribe(m) });
    } catch (e) {
      post({ type: "result", id: m.id, error: e.message || String(e) });
    }
  }
}

// Jobs run one at a time (the model is single-session), but a stop is heard straight away.
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "load") {
    loading = (loading || Promise.resolve()).then(m.voice ? loadVoice : load);
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
  } else if (m.type === "tts") {
    queue = queue.then(async () => {
      try {
        if (!aborted.has(m.reqId)) {
          await loading;
          await loadVoice();
          await speak({ ...m, onChunk: (pcm) => self.postMessage({ type: "audio", reqId: m.reqId, pcm }, [pcm.buffer]) });
        }
        post({ type: "result", id: m.id, ok: true });
      } catch (e) {
        post({ type: "result", id: m.id, error: e.message || String(e) });
      } finally {
        aborted.delete(m.reqId);
      }
    });
  } else if (m.type === "asr") {
    urgent.push(m);
    queue = queue.then(hearUrgent);
  } else if (m.type === "abort") {
    aborted.add(m.reqId);
    post({ type: "result", id: m.id, ok: true });
  } else if (m.type === "hardware") {
    hardware(m.voice).then((facts) => post({ type: "result", id: m.id, facts }), (e) => post({ type: "result", id: m.id, error: e.message || String(e) }));
  } else if (m.type === "status") {
    post({ type: "result", id: m.id, info, loading: !!loading });
  } else if (m.type === "clear") {
    (async () => {
      let n = 0;
      for (const k of await caches.keys()) if (k.startsWith("lfm-")) { await caches.delete(k); n++; }
      await session?.release().catch(() => {});
      for (const v of Object.values(voice || {})) await v.release().catch(() => {});
      session = null; tokenizer = null; info = null; voice = null;
      post({ type: "result", id: m.id, cleared: n });
    })();
  }
};
