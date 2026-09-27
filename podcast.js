// Podcast mode: the text model turns an article, post or thread into a short two-host
// discussion, and two different LiveKit Inference voices perform it. The script is
// streamed: the first host starts talking as soon as the first line is written.

import { chat, DEFAULT_MODEL } from "./lk.js";
import * as voice from "./voice.js";
import * as expr from "./expressive.js";

const labelOf = (id) => (voice.SUGGESTED_VOICES.find(([v]) => v === id) || [])[1] || "";
const nameOf = (id, fallback) => labelOf(id).split(" · ")[0] || fallback;
const genderOf = (id) => (/\bfemale\b/i.test(labelOf(id)) ? "f" : /\bmale\b/i.test(labelOf(id)) ? "m" : "");
const providerOf = (id) => id.split("/")[0];

// The second voice: your choice in Settings, or a contrasting voice from the same provider.
function secondVoice(v1) {
  const g = genderOf(v1);
  const others = voice.SUGGESTED_VOICES.map(([id]) => id).filter((id) => id !== v1);
  const contrast = (id) => !g || (genderOf(id) && genderOf(id) !== g);
  return others.find((id) => providerOf(id) === providerOf(v1) && contrast(id))
    || others.find((id) => providerOf(id) === providerOf(v1))
    || others.find(contrast) || others[0];
}

export function hostsFor(s) {
  const v1 = s.ttsVoice || voice.DEFAULT_VOICE;
  const v2 = s.podcastVoice2 && s.podcastVoice2 !== v1 ? s.podcastVoice2 : secondVoice(v1);
  const a = nameOf(v1, "Alex");
  let b = nameOf(v2, "Sam");
  if (b === a) b = a === "Sam" ? "Alex" : "Sam";
  return [{ name: a, voice: v1 }, { name: b, voice: v2 }];
}

// How long: "a 5 minute podcast" → about 150 spoken words a minute; default about 3 minutes.
export function targetWords(goal) {
  const m = /(\d+)\s*-?\s*(min|minute)/i.exec(goal || "");
  if (m) return Math.min(1500, Math.max(200, Number(m[1]) * 150));
  if (/\b(long|detailed|deep dive|in depth|in-depth)\b/i.test(goal || "")) return 1000;
  if (/\b(quick|brief|short)\b/i.test(goal || "")) return 300;
  return 450;
}

export class Podcast {
  // deps: { settings, hosts, onUpdate(podcast), log(kind, text) }
  constructor(deps) {
    this.d = deps;
    this.turns = [];      // { host: 0|1, text }
    this.idx = 0;         // turn being spoken (or next to speak)
    this.scriptDone = false;
    this.stopped = false;
    this.paused = false;
    this.waiting = null;  // resolves when the current turn's audio ends
    this.more = null;     // resolves when a new turn is written
    this.playing = false;
    this.id = String(Date.now());
  }

  // Write the script with the text model, streaming turns into the queue.
  async write({ title, url, text, goal, signal, cited }) {
    const [a, b] = this.d.hosts;
    const words = targetWords(goal);
    const model = this.d.settings.lkModel || DEFAULT_MODEL;
    this.d.log?.("info", `${model} is writing a ${Math.round(words / 150)}-minute script for ${a.name} and ${b.name}…`);
    let buf = "", spokenUpTo = 0;
    const take = (all) => {
      const lines = buf.split("\n");
      const done = all ? lines : lines.slice(0, -1);
      for (const raw of done.slice(spokenUpTo)) this.addLine(raw);
      spokenUpTo = done.length;
    };
    const out = await chat(this.d.settings, [
      { role: "system", content: [
        `You write scripts for a short two-host podcast that discusses one article, post or thread from the web.`,
        `Hosts: ${a.name} leads and explains the piece; ${b.name} is a curious co-host who asks the questions a listener would, reacts, and occasionally pushes back.`,
        `Stay faithful to the source: don't invent facts, numbers or quotes; attribute opinions to the author. If the text is thin, keep it short.`,
        `Open with a one-line hook that names what the piece is, cover the main points in a natural back-and-forth, and end with a one-line takeaway.`,
        `About ${words} words in total. Each turn is 1 to 3 short sentences of natural spoken English.`,
        `No stage directions, sound effects, music cues, markdown or emojis. Don't say "welcome to the podcast" or name the show.`,
        `Format: one turn per line, exactly "${a.name}: …" or "${b.name}: …".`,
        ...(this.d.expressive ? [
          `Put the delivery markers inside each line, after the "Name:" prefix, e.g. "${b.name}: <expr type=\"expression\" label=\"curious\"/> Wait, really?" Make it sound like a lively, natural conversation: react to each other, vary the energy, and let genuine surprise, amusement or doubt come through.`,
          expr.scriptInstructions(this.d.hosts),
        ] : []),
        ...(cited ? [
          `The source is split into numbered blocks: text blocks like [p12] and images, charts or videos like [m3] (with their alt text and caption).`,
          `End every line with the ids of the blocks that line is about, in square brackets, e.g. "${b.name}: So sales doubled in a year? [p14, m2]". Use the ids exactly as given; never say them aloud.`,
          `When the piece has a chart or image that matters, have a host point it out ("take a look at the chart here") and cite its [m] id, describing it only from its caption or alt text.`,
        ] : []),
      ].join("\n") },
      { role: "user", content: `Title: ${title}\nURL: ${url}\n${goal ? `Listener's request: ${goal}\n` : ""}\nSource text:\n${text}` },
    ], {
      signal,
      maxTokens: Math.round(words * (this.d.expressive ? 3.6 : 2.2)) + 200,
      onDelta: (t) => { buf = t; take(false); },
    });
    buf = out;
    take(true);
    this.scriptDone = true;
    this.wake();
    return this.turns.length;
  }

  addLine(raw) {
    const line = raw.replace(/[*_#`]+/g, "").trim();
    if (!line) return;
    const [a, b] = this.d.hosts;
    // Cited blocks: "… [p14, m2]" at the end of the line (and any stray [p3] inside it).
    let refs = [];
    const tail = /\s*\[((?:[pm]\d+)(?:\s*,\s*[pm]\d+)*)\]\s*$/i.exec(line);
    let body = tail ? line.slice(0, tail.index) : line;
    if (tail) refs = tail[1].split(/\s*,\s*/).map((x) => x.toLowerCase());
    body = body.replace(/\s*\[(?:[pm]\d+)(?:\s*,\s*[pm]\d+)*\]/gi, (m0) => { refs.push(...m0.replace(/[\[\]\s]/g, "").toLowerCase().split(",")); return ""; }).trim();
    const m = /^([A-Za-z][\w .'-]{0,24}?)\s*:\s*(.+)$/.exec(body);
    let host, text;
    if (m) {
      const who = m[1].trim().toLowerCase();
      host = who === b.name.toLowerCase() || who === "host b" || who === "b" ? 1
        : who === a.name.toLowerCase() || who === "host a" || who === "a" ? 0
        : this.turns.length % 2;
      text = m[2].trim();
    } else if (this.turns.length) {
      // A continuation line: same speaker.
      const last = this.turns[this.turns.length - 1];
      last.text += " " + body;
      last.refs.push(...refs);
      this.d.onUpdate?.(this);
      return;
    } else {
      host = 0; text = body;
    }
    text = text.replace(/\[[^\]]*\]|\([^)]*(laugh|music|pause|sigh)[^)]*\)/gi, "").trim();
    if (!text) return;
    this.turns.push({ host, text, refs: [...new Set(refs)] });
    this.d.onUpdate?.(this);
    this.wake();
  }

  wake() { const w = this.more; this.more = null; w?.(); }

  // Speak the turns in order, one TTS session per turn with that host's voice.
  async play() {
    if (this.playing) return;
    this.playing = true;
    this.paused = false;
    try {
      while (!this.stopped) {
        if (this.idx >= this.turns.length) {
          if (this.scriptDone) break;
          await new Promise((r) => (this.more = r));
          continue;
        }
        const t = this.turns[this.idx];
        const host = this.d.hosts[t.host];
        this.d.onUpdate?.(this);
        this.d.onTurn?.(t);
        this.sid = `pod-${Date.now()}-${this.idx}`;
        const done = new Promise((r) => (this.waiting = r));
        // Expressive markers are lowered to this host's voice markup (or stripped).
        const said = this.d.expressive ? expr.forVoice(host.voice, t.text) : t.text;
        await voice.speak({ ...this.d.settings, ttsVoice: host.voice }, said, { sid: this.sid, capture: `${this.id}:${this.idx}`, raw: this.d.expressive });
        const reason = await done;
        if (this.stopped) break;
        if (reason !== "finished") { this.paused = true; break; } // interrupted: "continue" resumes this turn
        this.idx++;
      }
    } finally {
      this.playing = false;
      if (!this.paused) this.d.onEnd?.();
      this.d.onUpdate?.(this);
    }
  }

  // From the service worker's voice events.
  onVoiceEvent(ev) {
    if (!this.waiting) return;
    // Only this turn's session counts; anything else speaking over it ("replaced") pauses the show.
    if ((ev.kind === "tts-done" && ev.sid === this.sid) || ev.kind === "tts-error") {
      const w = this.waiting;
      this.waiting = null;
      w(ev.kind === "tts-error" ? "error" : ev.reason);
    }
  }

  stop() {
    this.stopped = true;
    this.wake();
    const w = this.waiting;
    this.waiting = null;
    w?.("stopped");
  }

  // Render the whole show to one audio file (turns already played are reused).
  async exportAudio(onProgress) {
    const specs = {};
    for (const h of this.d.hosts) specs[h.voice] = await voice.ttsSpec(this.d.settings, h.voice);
    const turns = this.turns.map((t, idx) => {
      const sp = specs[this.d.hosts[t.host].voice];
      const v = this.d.hosts[t.host].voice;
      return { idx, url: sp.url, create: sp.create, gen: sp.gen, text: this.d.expressive ? expr.forVoice(v, t.text) : voice.forSpeech(t.text) };
    });
    const sampleRate = Object.values(specs)[0].sampleRate;
    return chrome.runtime.sendMessage({ target: "offscreen", type: "pod:export", pod: this.id, turns, sampleRate });
  }

  get finished() { return this.scriptDone && this.idx >= this.turns.length; }

  transcript() {
    return this.turns.map((t, i) => `${i === this.idx && this.playing ? "▶ " : ""}${this.d.hosts[t.host].name}: ${expr.strip(t.text)}`).join("\n\n");
  }
}
