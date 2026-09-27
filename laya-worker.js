// Laya, in the browser: a module worker (started by the offscreen document) that
// downloads the Laya decision model once, keeps it in Cache Storage, and answers
// typed questions with ONNX Runtime Web (WebGPU when available, else CPU/WASM).
// No server and no API key: nothing leaves the browser except the one-time download.
//
// The model files are the layaForWeb builds (https://github.com/vishalmysore/layaForWeb),
// hosted on Hugging Face; laya-core.js is that project's port of Laya's system_one.

import * as ort from "./vendor/laya/ort.min.mjs";
import { Tokenizer } from "./vendor/laya/tokenizers.min.mjs";
import { Laya } from "./vendor/laya/laya-core.js";

export const MODEL_BASES = {
  "laya-typed": "https://huggingface.co/VishalMysore/layaForWebTrained/resolve/main/",
  "laya": "https://huggingface.co/VishalMysore/layaForWeb/resolve/main/",
};

let laya = null;
let loaded = null;   // { key: "checkpoint/build/device", info }
let loading = null;  // Promise while loading

const post = (m) => self.postMessage(m);
const progress = (text, frac) => post({ type: "progress", text, frac });

async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.split("/").pop()}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes?.(got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Weights come in <= 24 MiB parts; each part is cached (keyed by the file's hash) so
// the model downloads once.
async function fetchWeights(base, entry) {
  let cache = null;
  try { cache = await caches.open("laya-" + entry.sha256.slice(0, 16)); } catch (_) {}
  const out = new Uint8Array(entry.size);
  let off = 0, fromCache = 0;
  const mb = (n) => Math.round(n / 1048576);
  for (const part of entry.parts) {
    const url = base + part;
    let bytes = null;
    try { const hit = cache && (await cache.match(url)); if (hit) { bytes = new Uint8Array(await hit.arrayBuffer()); fromCache++; } } catch (_) {}
    if (!bytes) {
      bytes = await fetchBytes(url, (got) => progress(`Downloading the Laya model: ${mb(off + got)} of ${mb(entry.size)} MB`, (off + got) / entry.size));
      try { if (cache) await cache.put(url, new Response(bytes)); } catch (_) { /* quota: just don't cache */ }
    }
    if (off + bytes.length > entry.size) throw new Error("Model weights are larger than expected.");
    out.set(bytes, off);
    off += bytes.length;
    progress(fromCache === entry.parts.length ? "Loading the Laya model from the cache…" : `Downloading the Laya model: ${mb(off)} of ${mb(entry.size)} MB`, off / entry.size);
  }
  if (off !== entry.size) throw new Error(`Model weights incomplete (${off} of ${entry.size} bytes).`);
  return { data: out, fromCache: fromCache === entry.parts.length };
}

async function hasWebGPU() {
  try { return !!self.navigator.gpu && !!(await self.navigator.gpu.requestAdapter()); } catch (_) { return false; }
}

async function load({ checkpoint = "laya", build = "q4e8", device = "auto", base: baseOverride = "" }) {
  const base = baseOverride ? baseOverride.replace(/\/?$/, "/") : MODEL_BASES[checkpoint] || MODEL_BASES["laya-typed"];
  const gpu = await hasWebGPU();
  // ONNX Runtime's WebGPU kernel for these weights only supports the 4-bit build.
  let want = device === "auto" ? (gpu && build === "q4e8" ? "webgpu" : "wasm") : device;
  if (want === "webgpu" && (!gpu || build !== "q4e8")) want = "wasm";
  const key = `${base}/${build}/${want}`;
  if (loaded?.key === key && laya) return loaded.info;
  laya = null;
  loaded = null;

  ort.env.wasm.wasmPaths = new URL("./vendor/laya/", self.location.href).href;
  const cores = navigator.hardwareConcurrency || 2;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, cores > 4 ? cores - 1 : cores) : 1;

  progress("Fetching the Laya model manifest…", 0);
  const manifest = await (await fetch(base + "manifest.json")).json();
  const v = manifest.variants[build] || manifest.variants.q4e8;
  const [tj, tc, cfg] = await Promise.all(["tokenizer.json", "tokenizer_config.json", "rl_agent_config.json"].map(async (f) => {
    const r = await fetch(base + f);
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  }));
  const tokenizer = new Tokenizer(tj, tc);
  const t0 = performance.now();
  const graph = await fetchBytes(base + v.onnx);
  const { data, fromCache } = await fetchWeights(base, v.data);
  progress("Starting the Laya model…", 1);
  const t1 = performance.now();
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: want === "webgpu" ? ["webgpu", "wasm"] : ["wasm"],
    graphOptimizationLevel: "all",
    externalData: [{ path: v.data.name, data }],
  });
  laya = new Laya(ort, session, tokenizer, cfg);
  await laya.systemOne("warm up", { w: { type: "noul", instructions: "This is a warm-up call" } });
  const info = {
    checkpoint, build, device: want,
    threads: want === "wasm" ? ort.env.wasm.numThreads : null,
    isolated: !!self.crossOriginIsolated,
    maxLen: cfg.max_len ?? 512, headMaxLen: cfg.head_max_len ?? 192,
    sizeMB: Math.round(v.data.size / 1048576), fromCache,
    loadMs: Math.round(performance.now() - t0), startMs: Math.round(performance.now() - t1),
  };
  loaded = { key, info };
  progress(`Laya ready (${want === "webgpu" ? "WebGPU" : `CPU, ${info.threads} thread${info.threads === 1 ? "" : "s"}`}).`, 1);
  return info;
}

// Jobs run one at a time (the model is single-session).
let queue = Promise.resolve();
self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === "load") {
    loading = (loading || Promise.resolve()).then(() => load(m.opts || {}));
    loading.then((info) => post({ type: "result", id: m.id, info }), (e) => post({ type: "result", id: m.id, error: e.message || String(e) }))
      .finally(() => { loading = null; });
  } else if (m.type === "run") {
    queue = queue.then(async () => {
      try {
        if (loading) await loading;
        if (!laya) await load(m.opts || {});
        const t0 = performance.now();
        const res = await laya.systemOne(m.state, m.questions);
        post({ type: "result", id: m.id, answers: res.answers, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        post({ type: "result", id: m.id, error: e.message || String(e) });
      }
    });
  } else if (m.type === "runMany") {
    // Several small questions, each with its own state (e.g. one per page item).
    queue = queue.then(async () => {
      try {
        if (loading) await loading;
        if (!laya) await load(m.opts || {});
        const out = [];
        for (const job of m.jobs) out.push((await laya.systemOne(job.state, job.questions)).answers);
        post({ type: "result", id: m.id, results: out });
      } catch (e) {
        post({ type: "result", id: m.id, error: e.message || String(e) });
      }
    });
  } else if (m.type === "status") {
    post({ type: "result", id: m.id, info: loaded?.info || null, loading: !!loading });
  } else if (m.type === "clear") {
    (async () => {
      let n = 0;
      for (const k of await caches.keys()) if (k.startsWith("laya-")) { await caches.delete(k); n++; }
      laya = null; loaded = null;
      post({ type: "result", id: m.id, cleared: n });
    })();
  }
};
