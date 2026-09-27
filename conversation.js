// Hands-free conversation: the mic stays open, each pause ends an utterance, Jev's
// reply is spoken, and you can talk over it to interrupt. Follow-ups ("what about
// the second one?", "read it again", "go on") are rewritten into standalone requests
// using the conversation so far, then run through the normal pipeline.
//
// Audio lives in the offscreen document (offscreen.js: continuous STT, endpointing,
// echo filtering, barge-in). This module owns the conversation state and turn-taking.

import * as voice from "./voice.js";
import { chat } from "./lk.js";

const IDLE_MS = 120_000; // stop listening after 2 minutes of silence
const CONTROL = [
  ["end", /^(ok(ay)?[, ]+)?(stop listening|goodbye|bye|good ?night|that'?s all|that is all|end (the )?(conversation|chat)|we'?re done|i'?m done|thanks,? that'?s (it|all))\b/i],
  ["hush", /^(stop|pause|quiet|be quiet|shh+|hush|hold on|wait|enough|stop talking|cancel)\b[.!]?$/i],
  ["continue", /^(continue|go on|keep (reading|going)|resume|carry on|and then|what else)\b/i],
  ["repeat", /^(repeat( that)?|say (that|it) again|what did you say|come again|pardon|sorry\??)$/i],
];

export class Conversation {
  // deps: { loadSettings, startRun(goal, meta) → Promise<run>, abortRun(), continueReading() → Promise<bool>, log(kind, text), notify(state) }
  constructor(deps) {
    this.d = deps;
    this.active = false;
    this.history = []; // {role: "user"|"assistant", text}
    this.phase = "off"; // off | listening | thinking | speaking
    this.queue = [];
    this.lastAnswer = "";
  }

  state() {
    return { active: this.active, phase: this.phase, history: this.history.slice(-12) };
  }
  set(phase) {
    this.phase = phase;
    this.d.notify(this.state());
  }

  async start() {
    if (this.active) return this.state();
    const s = await this.d.loadSettings();
    this.s = s;
    this.active = true;
    this.history = [];
    this.lastAnswer = "";
    await voice.startListening(s, { continuous: true, endpointMs: 900 });
    this.touch();
    this.set("speaking");
    await voice.speak(s, "I'm listening.");
    return this.state();
  }

  async end(say = true) {
    if (!this.active) return this.state();
    this.active = false;
    clearTimeout(this.idle);
    await voice.stopListening();
    if (say) await voice.speak(this.s, "Okay, I'll stop listening.").catch(() => {});
    this.set("off");
    return this.state();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.active && this.phase !== "thinking") this.end(true); }, IDLE_MS);
  }

  // ---- events from the offscreen document ----
  async onEvent(ev) {
    if (!this.active) return;
    switch (ev.kind) {
      case "barge-in":
        // You started talking over the answer: remember where reading stopped.
        this.set("listening");
        break;
      case "tts-done":
        if (this.phase === "speaking") this.set("listening");
        break;
      case "tts-started":
        if (this.phase !== "thinking") this.set("speaking");
        break;
      case "stt-closed":
        // The service ended the stream (e.g. a session limit): reconnect.
        voice.startListening(this.s, { continuous: true, endpointMs: 900 }).catch((e) => this.d.log("warn", `Voice: ${e.message}`));
        break;
      case "stt-utterance":
        this.touch();
        this.queue.push(ev.text);
        if (this.phase !== "thinking") this.next();
        break;
    }
  }

  async next() {
    const text = this.queue.shift();
    if (!text) return;
    const said = text.trim();
    const kind = (CONTROL.find(([, re]) => re.test(said)) || [])[0];

    if (kind === "end") return this.end(true);
    if (kind === "hush") {
      this.d.abortRun();
      await voice.stopSpeaking();
      this.set("listening");
      return this.next();
    }
    if (kind === "repeat" && this.lastAnswer) {
      this.set("speaking");
      await voice.speak(this.s, this.lastAnswer);
      return this.next();
    }
    if (kind === "continue") {
      // Resume reading at the sentence that was playing when it stopped.
      this.set("speaking");
      if (await this.d.continueReading()) return this.next();
      // Nothing paused: don't send "continue" to the agent as a task.
      await voice.speak(this.s, this.history.length ? "That was everything. What next?" : "There's nothing to continue yet.");
      this.set("listening");
      return this.next();
    }

    // A real request: make it standalone, then run it and speak the answer.
    this.set("thinking");
    await voice.stopSpeaking();
    let goal = said;
    if (this.history.length) goal = await this.standalone(said).catch(() => said);
    this.history.push({ role: "user", text: said });
    const run = await this.d.startRun(goal, { heard: said, history: this.history.slice(-8) });
    const answer = run?.answer?.reading ? `(reading) ${run.answer.note || ""}` : run?.answer?.text || run?.log?.slice(-1)[0]?.text || "";
    if (answer) this.history.push({ role: "assistant", text: answer.slice(0, 600) });
    this.lastAnswer = run?.answer?.reading ? this.lastAnswer : answer;
    this.set(voice.state.speaking ? "speaking" : "listening");
    return this.next();
  }

  // "What about the second one?" → "Summarize the second post on the page".
  async standalone(said) {
    const convo = this.history.slice(-8).map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n");
    const out = await chat(this.s, [
      { role: "system", content: "You rewrite the user's latest message for a browser assistant that can read the current web page aloud, answer questions about it, and act on it. Using the conversation so far, rewrite the latest message as one standalone request with every reference resolved (which post, which item, which page). Keep it short. If it is already standalone, return it unchanged. Output only the request." },
      { role: "user", content: `Conversation so far:\n${convo}\n\nLatest message: ${said}` },
    ], { maxTokens: 80 });
    const goal = out.trim().replace(/^["']|["']$/g, "");
    if (goal && goal.toLowerCase() !== said.toLowerCase()) this.d.log("info", `Understood "${said}" as: ${goal}`);
    return goal || said;
  }
}
