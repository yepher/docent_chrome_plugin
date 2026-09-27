// Offscreen document: plays LiveKit Inference TTS audio and captures the mic for
// LiveKit Inference STT. It lives outside the popup, so speech keeps playing after
// the popup closes. The service worker sets the gateway's Authorization header on
// these WebSockets with a declarativeNetRequest rule (browser WebSockets can't set
// headers themselves).

const emit = (kind, extra = {}) => chrome.runtime.sendMessage({ type: "voice:event", kind, ...extra }).catch(() => {});

function b64ToInt16(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}
function int16ToB64(i16) {
  const bytes = new Uint8Array(i16.buffer);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- TTS ----------
let tts = null;

function ttsStop(reason = "stopped") {
  if (!tts) return;
  const t = tts;
  tts = null;
  if (t.capture && !captures.get(t.capture)?.complete) captures.delete(t.capture);
  const played = t.next > 0 ? Math.min(1, Math.max(0, (t.ctx.currentTime - (t.startAt || 0)) / Math.max(0.01, t.next - (t.startAt || 0)))) : 0;
  lastSpoken = { words: t.words, until: Date.now() + 1500 };
  try { t.ws.close(); } catch (_) {}
  for (const src of t.sources) { try { src.stop(); } catch (_) {} }
  t.ctx.close().catch(() => {});
  clearInterval(t.doneTimer);
  clearInterval(t.segTimer);
  emit("tts-done", { reason, played: reason === "finished" ? 1 : played, seg: t.seg, sentences: t.segs.length > 0, sid: t.sid || null });
}

// Words Docent is saying (or just said), to tell its own voice coming back through the
// mic apart from you talking.
let lastSpoken = { words: new Set(), until: 0 };
const wordsOf = (t) => (t.toLowerCase().match(/[a-z0-9']+/g) || []);
function isEcho(text) {
  const w = wordsOf(text);
  if (!w.length) return true;
  const ref = tts ? tts.words : Date.now() < lastSpoken.until ? lastSpoken.words : null;
  if (!ref || !ref.size) return false;
  const hit = w.filter((x) => ref.has(x)).length;
  return hit / w.length >= 0.7;
}
const ttsPlaying = () => !!(tts && !tts.paused && tts.ctx.currentTime < tts.next);

// Pause / resume: suspending the AudioContext freezes its clock, so scheduled audio, the
// read-along sentence timer and the "finished" check all hold exactly where they are.
async function ttsPause() {
  if (!tts || tts.paused) return;
  tts.paused = true;
  await tts.ctx.suspend().catch(() => {});
  emit("tts-paused");
}
async function ttsResume() {
  if (!tts || !tts.paused) return;
  tts.paused = false;
  await tts.ctx.resume().catch(() => {});
  emit("tts-resumed");
}

function ttsStart({ url, create, sampleRate, sid, capture }) {
  ttsStop("replaced");
  const ctx = new AudioContext({ sampleRate });
  const t = { sid, capture, ws: new WebSocket(url), ctx, next: 0, queue: [], sources: [], gotDone: false, bytes: 0, flushed: false, words: new Set(), segs: [], chars: 0, seg: -1 };
  // Read-along: which sentence is playing now. Sentence start times are estimated in
  // proportion to their length over the audio produced (exact total once "done").
  t.segTimer = setInterval(() => {
    if (tts !== t || !t.segs.length || t.startAt === undefined) return;
    const played = ctx.currentTime - t.startAt;
    if (played < 0) return;
    const produced = t.next - t.startAt;
    const total = t.gotDone ? produced : Math.max(produced, t.chars * 0.068);
    let acc = 0, cur = t.segs[0].idx;
    for (const sg of t.segs) {
      if ((acc / t.chars) * total > played) break;
      cur = sg.idx;
      acc += sg.chars;
    }
    if (cur !== t.seg) { t.seg = cur; emit("tts-seg", { idx: cur }); }
  }, 120);
  tts = t;
  if (capture) startCapture(capture);
  const send = (obj) => (t.ws.readyState === 1 ? t.ws.send(JSON.stringify(obj)) : t.queue.push(obj));
  t.send = send;
  t.ws.onopen = () => {
    t.ws.send(JSON.stringify(create));
    for (const m of t.queue.splice(0)) t.ws.send(JSON.stringify(m));
    emit("tts-started");
  };
  t.ws.onmessage = (ev) => {
    if (tts !== t) return;
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }
    if (data.type === "output_audio" && data.audio) {
      const pcm = b64ToInt16(data.audio);
      t.bytes += pcm.length * 2;
      if (t.capture) captures.get(t.capture)?.chunks.push(pcm);
      const buf = ctx.createBuffer(1, pcm.length, sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, t.next);
      if (t.startAt === undefined) t.startAt = at;
      src.start(at);
      t.next = at + buf.duration;
      t.sources.push(src);
      if (t.sources.length > 400) t.sources.splice(0, 200);
    } else if (data.type === "done") {
      t.gotDone = true;
      if (t.capture && captures.has(t.capture)) captures.get(t.capture).complete = true;
      // Wait for the scheduled audio to finish playing.
      t.doneTimer = setInterval(() => {
        if (tts === t && ctx.currentTime >= t.next - 0.02) {
          emit("tts-played", { seconds: Math.round(t.next * 10) / 10, bytes: t.bytes });
          ttsStop("finished");
        }
      }, 150);
    } else if (data.type === "error") {
      emit("tts-error", { message: data.message || JSON.stringify(data).slice(0, 300) });
      ttsStop("error");
    }
  };
  t.ws.onerror = () => { if (tts === t) { emit("tts-error", { message: "Couldn't connect to LiveKit Inference TTS (check the API key/secret and that Inference is enabled)." }); ttsStop("error"); } };
  t.ws.onclose = (ev) => { if (tts === t && !t.gotDone && t.paused && t.flushed) { t.gotDone = true; t.doneTimer = setInterval(() => { if (tts === t && !t.paused && ctx.currentTime >= t.next - 0.02) ttsStop("finished"); }, 150); return; }
  if (tts === t && !t.gotDone) { emit("tts-error", { message: `TTS connection closed (${ev.code}${ev.reason ? ": " + ev.reason : ""}).` }); ttsStop("error"); } };
}

// ---------- STT ----------
let stt = null;

async function sttStart({ url, create, continuous, endpointMs }) {
  await sttStop(true);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    emit("mic-denied", { message: e.name === "NotAllowedError" ? "Microphone permission needed." : e.message });
    return;
  }
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const s = { ws: new WebSocket(url), ctx, stream, proc, source, queue: [], finals: [], ended: false, continuous: !!continuous, endpointMs: endpointMs || 900, timer: null };
  stt = s;
  const send = (obj) => (s.ws.readyState === 1 ? s.ws.send(JSON.stringify(obj)) : s.queue.push(obj));
  s.send = send;
  s.ws.onopen = () => {
    s.ws.send(JSON.stringify(create));
    for (const m of s.queue.splice(0)) s.ws.send(JSON.stringify(m));
    emit("stt-started");
  };
  s.ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (_) { return; }
    const text = data.transcript || data.text || "";
    const speech = data.type === "interim_transcript" || data.type === "preflight_transcript" || data.type === "final_transcript";
    if (speech && s.continuous) {
      // Conversation mode: drop Docent's own voice, let you interrupt it, and cut the
      // stream into utterances at pauses.
      if (!text.trim() || isEcho(text)) return;
      if (ttsPlaying() && wordsOf(text).length >= 2) { ttsStop("barge-in"); emit("barge-in", { text }); }
      clearTimeout(s.timer);
      if (data.type === "final_transcript") {
        s.finals.push(text.trim());
        s.lastFinal = Date.now();
      }
      const heard = [...s.finals, data.type === "final_transcript" ? "" : text].join(" ").trim();
      emit(data.type === "final_transcript" ? "stt-final" : "stt-interim", { text: heard });
      if (s.finals.length) {
        s.timer = setTimeout(() => {
          const said = s.finals.join(" ").trim();
          s.finals = [];
          if (said) emit("stt-utterance", { text: said });
        }, s.endpointMs);
      }
      return;
    }
    if (data.type === "interim_transcript" || data.type === "preflight_transcript") {
      emit("stt-interim", { text: [...s.finals, text].join(" ").trim() });
    } else if (data.type === "final_transcript") {
      if (text.trim()) s.finals.push(text.trim());
      s.lastFinal = Date.now();
      emit("stt-final", { text: s.finals.join(" ") });
    } else if (data.type === "error") {
      emit("stt-error", { message: data.message || JSON.stringify(data).slice(0, 300) });
    }
  };
  s.ws.onerror = () => emit("stt-error", { message: "Couldn't connect to LiveKit Inference STT." });
  // Long conversations: if the service closes the stream, say so and the service worker reconnects.
  s.ws.onclose = () => { if (stt === s && !s.ended && s.continuous) { sttStop(true); emit("stt-closed"); } };
  let level = 0, lastLevelEmit = 0;
  proc.onaudioprocess = (e) => {
    if (stt !== s || s.ended) return;
    const f = e.inputBuffer.getChannelData(0);
    const i16 = new Int16Array(f.length);
    let peak = 0;
    for (let i = 0; i < f.length; i++) {
      const v = Math.max(-1, Math.min(1, f[i]));
      i16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      peak = Math.max(peak, Math.abs(v));
    }
    level = Math.max(peak, level * 0.8);
    if (Date.now() - lastLevelEmit > 200) { lastLevelEmit = Date.now(); emit("mic-level", { level }); }
    send({ type: "input_audio", audio: int16ToB64(i16) });
  };
  source.connect(proc);
  proc.connect(ctx.destination);
}

async function sttStop(silent) {
  if (!stt) return;
  const s = stt;
  s.ended = true;
  try { s.proc.disconnect(); s.source.disconnect(); } catch (_) {}
  s.stream.getTracks().forEach((t) => t.stop());
  if (s.ws.readyState === 1) {
    s.ws.send(JSON.stringify({ type: "session.finalize" }));
    // Give the service a moment to return the last final transcript.
    const t0 = Date.now();
    while (Date.now() - t0 < 1500 && !(s.lastFinal && Date.now() - s.lastFinal > 300)) await new Promise((r) => setTimeout(r, 100));
    try { s.ws.send(JSON.stringify({ type: "session.close" })); } catch (_) {}
  }
  try { s.ws.close(); } catch (_) {}
  s.ctx.close().catch(() => {});
  if (stt === s) stt = null;
  if (!silent) emit("stt-stopped", { text: s.finals.join(" ").trim() });
}

// ---------- podcast audio: keep what was played, render the rest, export an MP3 ----------
// Each podcast turn's audio is kept as it arrives (key "podcastId:turn"), so exporting
// only has to synthesize the turns you haven't heard yet.
const captures = new Map();
let capturePod = null;
function startCapture(key) {
  const pod = key.split(":")[0];
  if (capturePod !== pod) { captures.clear(); capturePod = pod; }
  captures.set(key, { chunks: [], complete: false });
}

// Synthesize one turn without playing it: collect the audio until "done".
function renderTurn({ url, create, text, gen }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const chunks = [];
    let done = false;
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error("TTS timed out")); }, 90_000);
    ws.onopen = () => {
      ws.send(JSON.stringify(create));
      ws.send(JSON.stringify({ type: "input_transcript", transcript: text + " ", generation_config: gen || {}, extra: {} }));
      ws.send(JSON.stringify({ type: "session.flush" }));
    };
    ws.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.type === "output_audio" && d.audio) chunks.push(b64ToInt16(d.audio));
      else if (d.type === "done") { done = true; clearTimeout(timer); try { ws.close(); } catch (_) {} resolve(chunks); }
      else if (d.type === "error") { clearTimeout(timer); try { ws.close(); } catch (_) {} reject(new Error(d.message || "TTS error")); }
    };
    ws.onerror = () => { if (!done) { clearTimeout(timer); reject(new Error("Couldn't connect to LiveKit Inference TTS.")); } };
    ws.onclose = () => { if (!done) { clearTimeout(timer); reject(new Error("TTS connection closed early.")); } };
  });
}

async function podExport({ pod, turns, sampleRate, gapMs = 350 }) {
  const parts = [];
  const gap = new Int16Array(Math.round((sampleRate * gapMs) / 1000));
  let rendered = 0;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const got = captures.get(`${pod}:${t.idx}`);
    let chunks = got?.complete ? got.chunks : null;
    for (let attempt = 0; !chunks && attempt < 3; attempt++) {
      try { chunks = await renderTurn(t); rendered++; } catch (e) { if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 800)); }
    }
    parts.push(...chunks, gap);
    emit("pod-export-progress", { done: i + 1, total: turns.length });
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const pcm = new Int16Array(total);
  let o = 0;
  for (const p of parts) { pcm.set(p, o); o += p.length; }
  let blob, ext;
  try {
    const { Mp3Encoder } = await import("./vendor/lamejs.mjs");
    const enc = new Mp3Encoder(1, sampleRate, 64);
    const out = [];
    for (let i = 0; i < pcm.length; i += 1152 * 20) {
      const b = enc.encodeBuffer(pcm.subarray(i, i + 1152 * 20));
      if (b.length) out.push(new Uint8Array(b));
      if (i % (1152 * 400) === 0) await new Promise((r) => setTimeout(r, 0)); // stay responsive
    }
    const end = enc.flush();
    if (end.length) out.push(new Uint8Array(end));
    blob = new Blob(out, { type: "audio/mpeg" }); ext = "mp3";
  } catch (e) {
    blob = wavBlob(pcm, sampleRate); ext = "wav"; // encoder unavailable: plain WAV
  }
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
  return { url, ext, bytes: blob.size, seconds: Math.round(pcm.length / sampleRate), rendered };
}

function wavBlob(pcm, rate) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); h.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); str(36, "data"); h.setUint32(40, pcm.length * 2, true);
  return new Blob([h.buffer, pcm.buffer], { type: "audio/wav" });
}

// ---------- Laya: the in-browser decision model runs in a worker (laya-worker.js) ----------
let layaWorker = null, layaSeq = 0;
const layaPending = new Map();
function layaCall(msg) {
  if (!layaWorker) {
    layaWorker = new Worker("laya-worker.js", { type: "module" });
    layaWorker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "progress") chrome.runtime.sendMessage({ type: "laya:progress", text: m.text, frac: m.frac }).catch(() => {});
      else if (m.type === "result") { const p = layaPending.get(m.id); layaPending.delete(m.id); p?.(m); }
    };
    layaWorker.onerror = (e) => {
      for (const p of layaPending.values()) p({ error: `The Laya worker failed${e.message ? `: ${e.message}` : ""}.` });
      layaPending.clear();
      layaWorker = null;
    };
  }
  const id = ++layaSeq;
  return new Promise((resolve) => { layaPending.set(id, resolve); layaWorker.postMessage({ ...msg, id }); });
}

// ---------- PDF: Chrome's PDF viewer can't be scripted, so read the file with pdf.js ----------
let pdfjs = null;
async function pdfExtract({ url, maxPages = 80 }) {
  if (!pdfjs) {
    pdfjs = await import("./vendor/pdfjs/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
  }
  let res;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch (e) {
    throw new Error(url.startsWith("file:")
      ? "Can't open local PDFs yet: in chrome://extensions → Docent → Details, turn on \"Allow access to file URLs\"."
      : `Couldn't download the PDF (${e.message}).`);
  }
  if (!res.ok) throw new Error(`Couldn't download the PDF (HTTP ${res.status}).`);
  const data = new Uint8Array(await res.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data, isEvalSupported: false, cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"), cMapPacked: true,
  }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const pages = Math.min(doc.numPages, maxPages);
  const paras = [];
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    paras.push(...pdfParagraphs(tc.items, n));
    page.cleanup();
  }
  const title = (meta?.info?.Title || "").trim();
  doc.destroy();
  return { title, numPages: doc.numPages, pagesRead: pages, paras };
}

// Rebuild lines and paragraphs from pdf.js text items: items on the same baseline form a
// line; a bigger vertical gap, a jump back up (next column) or a font-size change starts a
// new paragraph. Rotated text (e.g. arXiv's side stamp) and bare page numbers are dropped;
// words hyphenated across lines are joined again.
function pdfParagraphs(items, page) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const t = it.transform;
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // rotated
    const h = Math.abs(t[3]) || it.height || 10;
    const x = t[4], y = t[5];
    if (!it.str.trim()) { if (cur && it.hasEOL) cur = null; else if (cur && !cur.text.endsWith(" ")) cur.text += " "; continue; }
    if (!cur || Math.abs(y - cur.y) > h * 0.5) {
      cur = { y, x, h, xEnd: x, text: "" };
      lines.push(cur);
    } else if (cur.text && !cur.text.endsWith(" ") && x > cur.xEnd + h * 0.12) {
      cur.text += " ";
    }
    cur.text += it.str;
    cur.xEnd = x + (it.width || 0);
    cur.h = Math.max(cur.h, h);
    if (it.hasEOL) cur = null;
  }
  const ls = lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text && !/^\d{1,4}$/.test(l.text));
  if (!ls.length) return [];
  const gaps = [];
  for (let i = 1; i < ls.length; i++) { const g = ls[i - 1].y - ls[i].y; if (g > 0 && g < ls[i].h * 3) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : ls[0].h * 1.2;
  const hs = ls.map((l) => l.h).sort((a, b) => a - b);
  const bodyH = hs[Math.floor(hs.length / 2)];
  const out = [];
  let para = null;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i], prev = ls[i - 1];
    const brk = !prev || prev.y - l.y > gap * 1.45 || prev.y - l.y < -gap * 0.5 || Math.abs(l.h - prev.h) > bodyH * 0.15;
    if (brk) { para = { page, lines: [l], h: l.h }; out.push(para); }
    else para.lines.push(l);
  }
  return out.map((p) => {
    let text = "";
    for (const l of p.lines) {
      if (/[a-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text;
      else text += (text ? " " : "") + l.text;
    }
    const heading = p.lines.length <= 2 && text.length < 100 && !/[.:,;]$/.test(text) &&
      (p.h > bodyH * 1.12 || /^(\d+(\.\d+)*\.?|[A-Z]\.?|[IVX]+\.)\s+[A-Z]/.test(text) || /^(abstract|introduction|conclusions?|references|acknowledg)/i.test(text));
    return { page, text, heading };
  }).filter((p) => (p.text.match(/[\p{L}\p{N}]/gu) || []).length >= 2);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "pdf:extract") {
    pdfExtract(msg).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (typeof msg.type === "string" && msg.type.startsWith("laya:")) {
    const { target, type, ...rest } = msg;
    layaCall({ ...rest, type: type.slice(5) }).then(sendResponse);
    return true;
  }
  if (msg.type === "pod:export") {
    podExport(msg).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  switch (msg.type) {
    case "tts:start": ttsStart(msg); break;
    case "tts:append":
      if (tts) {
        for (const w of wordsOf(msg.text)) tts.words.add(w);
        if (msg.idx != null) { tts.segs.push({ idx: msg.idx, chars: msg.text.length }); tts.chars += msg.text.length; }
        tts.send({ type: "input_transcript", transcript: msg.text, generation_config: msg.generation_config || {}, extra: {} });
      }
      break;
    case "tts:end": if (tts && !tts.flushed) { tts.flushed = true; tts.send({ type: "session.flush" }); } break;
    case "tts:stop": ttsStop("stopped"); break;
    case "tts:pause": ttsPause(); break;
    case "tts:resume": ttsResume(); break;
    case "stt:start": sttStart(msg); break;
    case "stt:stop": sttStop(false); break;
  }
  sendResponse({ ok: true });
});
