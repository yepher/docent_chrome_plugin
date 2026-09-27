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
  try { t.ws.close(); } catch (_) {}
  for (const src of t.sources) { try { src.stop(); } catch (_) {} }
  t.ctx.close().catch(() => {});
  clearInterval(t.doneTimer);
  emit("tts-done", { reason });
}

function ttsStart({ url, create, sampleRate }) {
  ttsStop("replaced");
  const ctx = new AudioContext({ sampleRate });
  const t = { ws: new WebSocket(url), ctx, next: 0, queue: [], sources: [], gotDone: false, bytes: 0, flushed: false };
  tts = t;
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
      const buf = ctx.createBuffer(1, pcm.length, sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime + 0.03, t.next);
      src.start(at);
      t.next = at + buf.duration;
      t.sources.push(src);
      if (t.sources.length > 400) t.sources.splice(0, 200);
    } else if (data.type === "done") {
      t.gotDone = true;
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
  t.ws.onclose = (ev) => { if (tts === t && !t.gotDone) { emit("tts-error", { message: `TTS connection closed (${ev.code}${ev.reason ? ": " + ev.reason : ""}).` }); ttsStop("error"); } };
}

// ---------- STT ----------
let stt = null;

async function sttStart({ url, create }) {
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
  const s = { ws: new WebSocket(url), ctx, stream, proc, source, queue: [], finals: [], ended: false };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  switch (msg.type) {
    case "tts:start": ttsStart(msg); break;
    case "tts:append": tts?.send({ type: "input_transcript", transcript: msg.text, generation_config: msg.generation_config || {}, extra: {} }); break;
    case "tts:end": if (tts && !tts.flushed) { tts.flushed = true; tts.send({ type: "session.flush" }); } break;
    case "tts:stop": ttsStop("stopped"); break;
    case "stt:start": sttStart(msg); break;
    case "stt:stop": sttStop(false); break;
  }
  sendResponse({ ok: true });
});
