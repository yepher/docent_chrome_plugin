// Voice via LiveKit Inference: TTS (read aloud, spoken answers) and STT (voice questions).
// The audio itself lives in the offscreen document (offscreen.js); this module sets up
// auth, sessions and the text that gets spoken.

import { mintToken, gatewayUrl } from "./lk.js";

export const SUGGESTED_VOICES = [
  ["cartesia/sonic-3:9626c31c-bec5-4cca-baa8-f8ba9e84c8bc", "Jacqueline · Cartesia (US female)"],
  ["cartesia/sonic-3:a167e0f3-df7e-4d52-a9c3-f949145efdab", "Blake · Cartesia (US male)"],
  ["cartesia/sonic-3:f31cc6a7-c1e8-4764-980c-60a361443dd1", "Robyn · Cartesia (AU female)"],
  ["deepgram/aura-2:athena", "Athena · Deepgram (US female)"],
  ["deepgram/aura-2:odysseus", "Odysseus · Deepgram (US male)"],
  ["deepgram/aura-2:apollo", "Apollo · Deepgram (US male, casual)"],
  ["deepgram/aura-2:theia", "Theia · Deepgram (AU female)"],
  ["fishaudio/s2.1-pro:e3cd384158934cc9a01029cd7d278634", "Laura · Fish Audio (narrator)"],
  ["fishaudio/s2.1-pro:536d3a5e000945adb7038665781a4aca", "Ethan · Fish Audio (explainer)"],
];
export const STT_MODELS = [
  ["deepgram/nova-3", "Deepgram Nova-3"],
  ["deepgram/flux-general-en", "Deepgram Flux (English)"],
  ["assemblyai/universal-streaming", "AssemblyAI Universal-Streaming"],
  ["cartesia/ink-whisper", "Cartesia Ink Whisper"],
];
export const DEFAULT_VOICE = SUGGESTED_VOICES[0][0];
export const DEFAULT_STT = "deepgram/nova-3";
const TTS_RATE = 24000;

const splitModel = (s) => {
  const i = s.lastIndexOf(":");
  return i > 0 && s.indexOf("/") < i ? [s.slice(0, i), s.slice(i + 1)] : [s, ""];
};
const wsBase = (s) => gatewayUrl(s).replace(/^http/, "ws");
const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: "offscreen", ...msg }).catch(() => {});

export async function ensureOffscreen() {
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "WORKERS"],
      justification: "Play LiveKit Inference text-to-speech, capture the microphone for voice questions, and run the in-browser Laya decision model in a worker.",
    });
  } catch (e) {
    if (!/single offscreen|already/i.test(e.message)) throw e;
  }
}

// Browser WebSockets can't send an Authorization header, so a session rule adds it
// to the gateway's WebSocket handshake. Token lives 10 minutes; refreshed per session.
async function setAuth(s) {
  const token = await mintToken(s.lkApiKey, s.lkApiSecret, 600);
  const host = new URL(gatewayUrl(s)).hostname;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [7101],
    addRules: [{
      id: 7101,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "Authorization", operation: "set", value: `Bearer ${token}` }] },
      condition: { urlFilter: `||${host}`, resourceTypes: ["websocket"] },
    }],
  });
}

// Make text sound right: drop markdown, URLs and bullet markers.
// Pronunciations: words the voices say wrong, respelled just before speaking (the page,
// transcript and read-along highlight keep the real spelling). One per line, "word = say as";
// the user's list from Settings, with LiveKit ("Live" as in "life") built in.
export const DEFAULT_PRONUNCIATIONS = "LiveKit = Lyve Kit";
const lexiconCache = new Map();
function lexicon(list) {
  const src = list == null ? DEFAULT_PRONUNCIATIONS : String(list);
  if (!lexiconCache.has(src)) {
    const rules = src.split(/\n+/).map((l) => l.split("=")).filter((p) => p.length === 2 && p[0].trim() && p[1].trim())
      .map(([w, say]) => [new RegExp(`(?<![\\p{L}\\p{N}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), say.trim()]);
    lexiconCache.set(src, rules);
  }
  return lexiconCache.get(src);
}
export function pronounce(text, list) {
  let t = String(text);
  for (const [re, say] of lexicon(list)) t = t.replace(re, say);
  return t;
}

export function forSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s*(?=\S)/gm, "")
    .replace(/([.!?:;,])\s*\n+\s*/g, "$1 ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Sentence-sized pieces (TTS providers do best with whole sentences).
export function sentences(text, max = 400) {
  const out = [];
  for (const part of String(text).split(/(?<=[.!?…])\s+/)) {
    let p = part.trim();
    while (p.length > max) {
      const cut = p.lastIndexOf(" ", max) > 50 ? p.lastIndexOf(" ", max) : max;
      out.push(p.slice(0, cut));
      p = p.slice(cut).trim();
    }
    if (p) out.push(p);
  }
  return out;
}

export const state = { speaking: false, listening: false, paused: false };

// Start a TTS session; push text as it arrives (e.g. while the LLM streams), then end().
export async function speakStream(s, opts = {}) {
  await ensureOffscreen();
  await setAuth(s);
  const [model, voice] = splitModel(s.ttsVoice || DEFAULT_VOICE);
  const gen = { model, ...(voice ? { voice } : {}) };
  await toOffscreen({
    type: "tts:start",
    url: `${wsBase(s)}/tts?model=${encodeURIComponent(model)}`,
    sampleRate: TTS_RATE,
    create: { type: "session.create", sample_rate: String(TTS_RATE), encoding: "pcm_s16le", model, ...(voice ? { voice } : {}), extra: {} },
    ...(opts.sid ? { sid: opts.sid } : {}),
    ...(opts.capture ? { capture: opts.capture } : {}),
  });
  state.speaking = true;
  let buffer = "";
  const flush = (all) => {
    const parts = sentences(buffer);
    // Keep an unfinished last sentence back until more text arrives.
    const keep = !all && parts.length && !/[.!?…]$/.test(buffer.trim()) ? parts.pop() : "";
    for (const p of parts) {
      // raw: text already prepared for this voice (e.g. expressive markup) — don't clean it
      const clean = pronounce(opts.raw ? p.trim() : forSpeech(p), s.pronunciations);
      if (clean) toOffscreen({ type: "tts:append", text: clean + " ", generation_config: gen });
    }
    buffer = keep;
  };
  return {
    push(text) { buffer += text; if (/[.!?…]\s|\n/.test(buffer)) flush(false); },
    end() { flush(true); toOffscreen({ type: "tts:end" }); },
  };
}

// Speak a list of sentences, tagging each with its index so the offscreen player can
// report which one is playing (read-along highlight, "continue from here").
export async function speakSentences(s, list, offset = 0) {
  await ensureOffscreen();
  await setAuth(s);
  const [model, voiceId] = splitModel(s.ttsVoice || DEFAULT_VOICE);
  const gen = { model, ...(voiceId ? { voice: voiceId } : {}) };
  await toOffscreen({
    type: "tts:start",
    url: `${wsBase(s)}/tts?model=${encodeURIComponent(model)}`,
    sampleRate: TTS_RATE,
    create: { type: "session.create", sample_rate: String(TTS_RATE), encoding: "pcm_s16le", model, ...(voiceId ? { voice: voiceId } : {}), extra: {} },
  });
  state.speaking = true;
  list.forEach((raw, i) => {
    const clean = pronounce(forSpeech(raw), s.pronunciations);
    if (clean) toOffscreen({ type: "tts:append", text: clean + " ", idx: offset + i, generation_config: gen });
  });
  await toOffscreen({ type: "tts:end" });
}

// opts.sid tags the session, so its "tts-done" event can be told apart from others.
export async function speak(s, text, opts = {}) {
  const st = await speakStream(s, opts);
  st.push(text);
  st.end();
}

// Everything needed to open a TTS session for one voice (used to render podcast audio).
export async function ttsSpec(s, voiceId) {
  await ensureOffscreen();
  await setAuth(s);
  const [model, v] = splitModel(voiceId || s.ttsVoice || DEFAULT_VOICE);
  return {
    url: `${wsBase(s)}/tts?model=${encodeURIComponent(model)}`,
    create: { type: "session.create", sample_rate: String(TTS_RATE), encoding: "pcm_s16le", model, ...(v ? { voice: v } : {}), extra: {} },
    gen: { model, ...(v ? { voice: v } : {}) },
    sampleRate: TTS_RATE,
  };
}

// Pause / resume whatever is being spoken (page reading, podcast, answers).
export function pauseSpeaking() {
  if (!state.speaking) return Promise.resolve();
  state.paused = true;
  return toOffscreen({ type: "tts:pause" });
}
export function resumeSpeaking() {
  state.paused = false;
  return toOffscreen({ type: "tts:resume" });
}

export function stopSpeaking() {
  state.speaking = false;
  state.paused = false;
  return toOffscreen({ type: "tts:stop" });
}

export async function startListening(s, opts = {}) {
  await ensureOffscreen();
  await setAuth(s);
  const model = s.sttModel || DEFAULT_STT;
  state.listening = true;
  await toOffscreen({
    type: "stt:start",
    continuous: !!opts.continuous,
    endpointMs: opts.endpointMs || 900,
    url: `${wsBase(s)}/stt?model=${encodeURIComponent(model)}`,
    create: { type: "session.create", model, settings: { sample_rate: "16000", encoding: "pcm_s16le", language: "en", extra: {} } },
  });
}

export function stopListening() {
  state.listening = false;
  return toOffscreen({ type: "stt:stop" });
}
