// Agent loop. Code stays in control; Jev makes narrow, typed decisions each step:
//   action   – which kind of step comes next (click / type / select / scroll / back / open URL / done)
//   *_target – which indexed page element to act on
//   text     – which span of the user's prompt to type (Jev doesn't generate text), or
//              "compose", which hands the writing to the optional LiveKit Inference text model
//   submit   – whether to press Enter after typing
// All of these are asked together in one request per step (speculative fan-out).

import { choice, noul } from "./jev.js";
import { decide, isLaya, deciderReady, deciderName, layaLoad, layaStatus, layaClear, layaJudge } from "./decider.js";
import { textCandidates, urlCandidates } from "./candidates.js";
import { snapshotPage, performAction, highlightElements, pageText, readableText } from "./page.js";
import * as voice from "./voice.js";
import { Conversation } from "./conversation.js";
import { Podcast, hostsFor } from "./podcast.js";
import { supportsExpressive, strip as stripExpr } from "./expressive.js";
import { prepareReadAlong, highlightSentence, clearReadAlong, nextReadingChunk, loadMoreBelow } from "./karaoke.js";
import { podcastSource, showPodcastRefs, clearPodcastRefs } from "./podsource.js";
import { pdfFor, pdfText, pdfChunks, endOfBody, bodyStart, goToPage } from "./pdfdoc.js";
import { chat, lkConfigured, DEFAULT_MODEL } from "./lk.js";
import { focusRef, clearMarks, getSelectionText } from "./items.js";
import { pickTarget as pickTargetFromOutline } from "./targets.js";
import { modeFor, runFilter, applyRules, reapplyRules, getRules, saveRule, updateRule, deleteRule, forgetTab } from "./rules.js";

export const DEFAULTS = {
  apiKey: "",
  model: "jev-latest",
  apiBase: "https://api.typesafe.ai",
  // Decision model: "jev" (TypeSafe API), or Laya in the browser: "laya-typed" / "laya"
  decider: "jev",      // "jev" | "laya" (general) | "laya-typed"
  layaBuild: "q4e8",   // q4e8 (290 MB, WebGPU-capable) or q8e8 (440 MB, CPU, closer to the original)
  layaDevice: "auto",  // auto | webgpu | wasm
  layaModelBase: "",   // advanced: self-hosted model folder (default: the layaForWeb builds on Hugging Face)
  maxSteps: 15,
  minConfidence: 0.3,
  confirmRisky: true,
  // Optional text model via LiveKit Inference
  lkUrl: "",
  lkApiKey: "",
  lkApiSecret: "",
  lkModel: DEFAULT_MODEL,
  lkInferenceUrl: "",
  iconOpens: "popup", // or "panel"
  // Voice (LiveKit Inference TTS/STT; uses the same LiveKit credentials)
  ttsVoice: voice.DEFAULT_VOICE,
  sttModel: voice.DEFAULT_STT,
  speakAnswers: false,
  podcastVoice2: "", // "" = pick a contrasting voice automatically
  podcastExpressive: true,
  pronunciations: voice.DEFAULT_PRONUNCIATIONS, // "word = say as", one per line // emotion / laughs / pauses markup for voices that support it (see expressive.js)
};
const loadSettings = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) });
const MAX_ELEMENTS = 150;
const PAGE_TEXT_CHARS = 1500;
const NONE = "none";
const COMPOSE = "compose";

let run = null; // the one active (or last) run

// "Read the clipboard aloud", "summarize what I copied": the clipboard's text stands in
// for the selection. It is only read when the request mentions it.
const CLIPBOARD = /\b(clipboard|pasteboard)\b|\bwhat i('ve| have)?( just)? copied\b/i;
const CLIPBOARD_CHARS = 60000;
async function useClipboard(r) {
  await voice.ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", type: "clipboard:read" });
  if (!res || res.error) throw new Error(res?.error || "Couldn't read the clipboard (the offscreen document isn't available).");
  const text = (res.text || "").trim();
  if (!text) throw new Error("The clipboard has no text in it.");
  r.selection = text.slice(0, CLIPBOARD_CHARS);
  r.source = "clipboard";
  log("info", `Using the clipboard: ${text.length.toLocaleString()} characters.`, text.length > CLIPBOARD_CHARS ? `Long text: using the first ${CLIPBOARD_CHARS.toLocaleString()} characters.` : undefined);
}
const fromClipboard = (r) => r.source === "clipboard";

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false; // for the offscreen document, not us
  (async () => {
    switch (msg?.type) {
      case "jev:get":
        return publicRun();
      case "jev:start":
        if (run?.status === "running" || run?.status === "confirm") return { error: "A task is already running." };
        startRun(msg.goal, msg.tabId, msg.selection || "", { voice: !!msg.voice, read: !!msg.read, podcast: !!msg.podcast });
        return publicRun();
      case "jev:followup": {
        // A clicked suggestion: stop whatever is being read out, then run it.
        if (run?.status === "running" || run?.status === "confirm") return { error: "A task is already running." };
        const sg = (run?.suggestions || [])[msg.index];
        if (!sg) return { error: "That suggestion is gone." };
        if (sg.mode === "download") { downloadPodcast(); return publicRun(); }
        const keepSel = run.tabId === msg.tabId ? run.selection || "" : "";
        stopReadingOut();
        await voice.stopSpeaking();
        startRun(sg.goal, msg.tabId, keepSel, { read: sg.mode === "read", podcast: sg.mode === "podcast" });
        return publicRun();
      }
      // ---- voice ----
      case "voice:state":
        return { ...voice.state };
      case "voice:stop":
        stopReadingOut();
        await voice.stopSpeaking();
        return { ...voice.state };
      case "jev:podcastDownload":
        return downloadPodcast();
      // ---- Laya (in-browser decision model) ----
      case "laya:progress":
        onLayaProgress(msg);
        return { ok: true };
      case "laya:load":
        return layaLoad({ ...(await loadSettings()), ...(msg.settings || {}) }).then((info) => ({ info }), (e) => ({ error: e.message }));
      case "laya:status":
        return layaStatus().catch((e) => ({ error: e.message }));
      case "laya:clear":
        return layaClear().catch((e) => ({ error: e.message }));
      case "voice:pause":
        await voice.pauseSpeaking();
        return { ...voice.state };
      case "voice:resume":
        await voice.resumeSpeaking();
        return { ...voice.state };
      case "voice:togglePause":
        await (voice.state.paused ? voice.resumeSpeaking() : voice.pauseSpeaking());
        return { ...voice.state };
      case "voice:speakText": {
        const s = await loadSettings();
        if (!lkConfigured(s)) return { error: "Set up LiveKit in Settings to use voice." };
        // Settings can preview unsaved choices (a voice, the pronunciation list).
        await voice.speak({ ...s, ...(msg.ttsVoice ? { ttsVoice: msg.ttsVoice } : {}), ...(msg.pronunciations != null ? { pronunciations: msg.pronunciations } : {}) }, msg.text);
        return { ...voice.state };
      }
      case "voice:listen": {
        const s = await loadSettings();
        if (!lkConfigured(s)) return { error: "Set up LiveKit in Settings to use voice." };
        await voice.stopSpeaking();
        voice.state.listenFor = { tabId: msg.tabId, selection: msg.selection || "" };
        await voice.startListening(s);
        return { ...voice.state };
      }
      case "voice:stopListening":
        await voice.stopListening();
        return { ...voice.state };
      // ---- conversation (hands-free) ----
      case "conv:start": {
        const s = await loadSettings();
        if (!lkConfigured(s)) return { error: "Conversation uses LiveKit Inference. Add your LiveKit URL, key and secret in Settings." };
        return convo.start();
      }
      case "conv:end":
        return convo.end(false);
      case "conv:toggle":
        return convo.active ? convo.end(false) : convo.start();
      case "conv:state":
        return convo.state();
      case "voice:event":
        convo.onEvent(msg).catch(() => {});
        onReadAlongEvent(msg);
        podcast?.onVoiceEvent(msg);
        if (msg.kind === "pod-export-progress") lastPodcast?.onProgress?.(msg.done, msg.total);
        if (["tts-done", "tts-error"].includes(msg.kind)) voice.state.speaking = voice.state.paused = false;
        if (msg.kind === "tts-started") { voice.state.speaking = true; voice.state.paused = false; }
        if (["stt-stopped", "stt-error", "mic-denied"].includes(msg.kind)) voice.state.listening = false;
        if (msg.kind === "mic-denied" && convo.active) convo.end(false);
        if (msg.kind === "mic-denied") chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
        if (msg.kind === "stt-stopped" && msg.text?.trim() && voice.state.listenFor?.tabId != null) {
          const { tabId, selection } = voice.state.listenFor;
          voice.state.listenFor = null;
          if (!(run?.status === "running" || run?.status === "confirm")) startRun(msg.text.trim(), tabId, selection, { voice: true });
        }
        if (msg.kind === "tts-error" && run && run.status === "done") log("warn", `Voice: ${msg.message}`);
        return { ok: true };
      case "jev:focus":
        return { ok: await inject(msg.tabId, focusRef, [msg.ref.attr, msg.ref.val]).catch(() => false) };
      case "jev:clearMarks":
        return { cleared: await inject(msg.tabId, clearMarks, [msg.mode || null]).catch(() => 0) };
      case "jev:rules":
        return { rules: await getRules() };
      case "jev:saveRule": {
        const rules = await saveRule(msg.rule);
        if (msg.tabId) applyRules(await loadSettings(), msg.tabId, true).catch(() => {});
        return { rules };
      }
      case "jev:updateRule": {
        const rules = await updateRule(msg.id, msg.patch);
        if (msg.tabId) await reapplyRules(await loadSettings(), msg.tabId).catch(() => {});
        return { rules };
      }
      case "jev:deleteRule": {
        const rules = await deleteRule(msg.id);
        if (msg.tabId) await reapplyRules(await loadSettings(), msg.tabId).catch(() => {});
        return { rules };
      }
      case "jev:mutated":
        if (sender.tab?.id != null) applyRules(await loadSettings(), sender.tab.id, true).catch(() => {});
        return { ok: true };
      case "jev:stop":
        if (run) { run.abort.abort(); run.confirm?.(false); finish("stopped", "Stopped by you."); }
        return publicRun();
      case "jev:confirm":
        run?.confirm?.(!!msg.approve);
        return publicRun();
      case "jev:clear":
        // Clear history: the log, answer card and suggestions, plus the conversation so far.
        if (run && run.status !== "running" && run.status !== "confirm") { run = null; publish(); }
        convo.clearHistory();
        return publicRun();
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

function publicRun() {
  if (!run) return { run: null };
  const { goal, tabId, status, log, pending, step, answer, selection, speak, heard, suggestions } = run;
  return { run: { goal, tabId, status, log, pending, step, answer, heard, suggestions, speak: !!speak, selection: selection ? selection.slice(0, 300) : "" } };
}

function publish() {
  const data = publicRun();
  chrome.storage.session.set({ jevRun: data.run }).catch(() => {});
  chrome.runtime.sendMessage({ type: "jev:update", ...data }).catch(() => {});
  const badge = !run ? "" : run.status === "running" ? "…" : run.status === "confirm" ? "?" : "";
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: run?.status === "confirm" ? "#d97706" : "#4f46e5" }).catch(() => {});
}

function log(kind, text, detail) {
  run.log.push({ kind, text, detail, t: Date.now() });
  publish();
}

function finish(status, text) {
  if (!run || ["done", "stopped", "error"].includes(run.status)) return;
  run.status = status;
  run.pending = null;
  clearInterval(run.keepAlive);
  log(status === "done" ? "done" : status === "error" ? "error" : "warn", text);
  // Voice replies: speak the answer (or the outcome) unless it was already streamed.
  if (run.speak && run.settings && lkConfigured(run.settings) && !run.answer?.spoken) {
    const said = run.answer ? spokenAnswer(run.answer) : text;
    if (said) voice.speak(run.settings, said).catch((e) => log("warn", `Voice: ${e.message}`));
  }
  if (status === "done") suggestNext(run).catch(() => {});
}

function spokenAnswer(a) {
  const items = (a.items || []).map((x) => x.text).filter(Boolean);
  const list = items.length && items.length <= 12 ? `: ${items.join(", ")}` : "";
  return `${a.text}${list}.`;
}

// ---------- the loop ----------
async function startRun(goal, tabId, selection, opts = {}) {
  run = { goal, tabId, selection, speak: !!opts.voice, read: !!opts.read, podcast: !!opts.podcast, kind: opts.read ? "read" : opts.podcast ? "podcast" : "", heard: opts.heard || "", history: opts.history || null, status: "running", log: [], pending: null, step: 0, abort: new AbortController() };
  // Extension API calls keep the MV3 service worker alive during long waits (e.g. confirmation).
  run.keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  publish();
  try {
    await agentLoop(run);
  } catch (e) {
    if (run.abort.signal.aborted) return;
    finish("error", e?.message || String(e));
  }
}

async function agentLoop(r) {
  const s = await loadSettings();
  r.settings = s;
  if (s.speakAnswers && lkConfigured(s)) r.speak = true;
  if (CLIPBOARD.test(r.goal)) {
    await useClipboard(r);
    // Clear-cut wordings don't need the decision model (or a readable page).
    const quick = lkConfigured(s) && !r.read && !r.podcast ? (QUICK_KINDS.find(([, re, needsLlm]) => needsLlm && re.test(r.goal.trim())) || [])[0] : null;
    if (quick === "read") r.read = true;
    if (quick === "podcast") r.podcast = true;
    if (quick === "explain") {
      r.kind = "explain";
      if (WANTS_VOICE.test(r.goal)) r.speak = true;
      return writtenAnswer(r, s);
    }
  }
  // A PDF in Chrome's viewer: read the file itself (pdf.js) and work from its text.
  const tab0 = await chrome.tabs.get(r.tabId);
  r.pdf = await pdfFor(tab0, (f, a) => inject(r.tabId, f, a)).catch((e) => { throw new Error(`This looks like a PDF, but ${e.message.replace(/^./, (c) => c.toLowerCase())}`); });
  if (r.pdf) log("info", `PDF: "${r.pdf.title.slice(0, 80)}", ${r.pdf.numPages} page${r.pdf.numPages === 1 ? "" : "s"}, ${r.pdf.paras.length} paragraphs.`, r.pdf.pagesRead < r.pdf.numPages ? `Read the first ${r.pdf.pagesRead} pages.` : "Read with pdf.js.");
  if (r.read) {
    if (!lkConfigured(s)) throw new Error("Reading aloud uses LiveKit Inference TTS. Add your LiveKit URL, key and secret in Settings.");
    return readAloud(r, s);
  }
  if (r.podcast) return makePodcast(r, s);
  if (!deciderReady(s)) throw new Error("No TypeSafe API key. Open Settings and paste your key, or choose Laya (runs in your browser, no key needed).");
  const ask = (state, questions) => decide(s, { state, questions, signal: r.abort.signal });
  if (isLaya(s)) await ensureLaya(r, s);

  // Selected text (from the right-click menu) is the likeliest thing to type.
  const texts = [...new Set([...(r.selection ? [r.selection.slice(0, 500)] : []), ...textCandidates(r.goal)])].slice(0, 250);
  const urls = urlCandidates(r.goal);
  const history = []; // human-readable, fed back to Jev
  const keys = [];    // for loop detection
  let scrolls = 0;

  if (r.heard) log("info", `🎙 You: "${r.heard}"`);
  log("info", `Goal: ${r.goal}`, r.selection ? `with ${fromClipboard(r) ? "clipboard" : "selected"} text: "${r.selection.slice(0, 100)}${r.selection.length > 100 ? "…" : ""}"` : undefined);

  // Is this a question about the page, or something to do?
  await settle(r.tabId);
  const llm = lkConfigured(s) ? s : null;
  const kind = await classifyPrompt(r, ask, llm);
  r.kind = kind;
  if (r.pdf && ["task", "find", "hide"].includes(kind)) {
    return finish("stopped", kind === "task"
      ? "This is a PDF in Chrome's viewer, which extensions can't click or type into. I can read it aloud, answer questions about it, summarize it or make a podcast of it."
      : "Chrome's PDF viewer can't be highlighted or filtered. Try asking a question instead, e.g. \"which sections talk about …?\"");
  }
  if (kind === "read") return readAloud(r, s);
  if (kind === "podcast") return makePodcast(r, s);
  if (kind !== "task") return answerQuestion(r, ask, kind, llm, s);

  let waits = 0;

  for (r.step = 1; r.step <= s.maxSteps; r.step++) {
    if (r.abort.signal.aborted) return;
    await settle(r.tabId);

    let snap;
    try {
      snap = await inject(r.tabId, snapshotPage, [isLaya(s) ? 60 : MAX_ELEMENTS, isLaya(s) ? 600 : PAGE_TEXT_CHARS]);
    } catch (e) {
      throw new Error(`Can't read this page (${e.message}). Chrome blocks extensions on chrome:// pages, the Web Store and some viewers.`);
    }
    if (!snap) throw new Error("Couldn't read the page.");

    const els = Object.fromEntries(snap.elements.map((e) => [e.id, e]));
    const ofKind = (k) => snap.elements.filter((e) => e.kind === k);
    const clickables = ofKind("click"), fields = ofKind("type"), selects = ofKind("select");

    // --- action options (only the ones possible right now) ---
    const actions = {};
    if (clickables.length) actions.click = "Click a link, button, tab, checkbox or other clickable element listed in `page_elements`";
    if (fields.length && (texts.length || llm)) {
      actions.type = llm
        ? "Type text into a text field, search box or message box listed in `page_elements` (text from the goal, or text that needs to be written)"
        : "Type text from the goal into a text field or search box listed in `page_elements`";
    }
    if (selects.length) actions.select = "Choose an option in a dropdown listed in `page_elements`";
    if (!snap.atBottom) actions.scroll_down = "Scroll down, because the element needed next is not in `page_elements` yet";
    if (!snap.atTop) actions.scroll_up = "Scroll up to find an element above the current view";
    if (history.length) actions.go_back = "Go back to the previous page because the last step led somewhere wrong";
    if (urls.length) actions.open_url = "Open a web address that is written in the goal, because we are not on that site yet";
    actions.wait = "Wait a few seconds, because the page is still loading or updating, or the other side is taking its turn";
    actions.done = "The goal is fully accomplished and nothing is left to do, judging by `actions_taken_so_far` and `current_page`. For an ongoing activity such as playing a game, it is done only when the activity has finished";

    const state = {
      goal: r.goal,
      actions_taken_so_far: history.length ? history : "none yet",
      current_page: { url: snap.url, title: snap.title, visible_text: snap.text },
      ...(r.selection ? { selected_text: r.selection.slice(0, 1500) } : {}),
      page_elements: snap.elements.map((e) => `${e.id}: ${e.desc}`),
    };
    const targetQ = (verb, list) =>
      choice(
        `Which element in \`page_elements\` should be ${verb} as the next step toward the \`goal\`?`,
        { ...Object.fromEntries(list.map((e) => [e.id, e.desc])), [NONE]: "None of these elements helps with the goal" }
      );

    const questions = {
      action: choice(
        "What is the single next browser step that makes progress toward the `goal`? Don't repeat steps in `actions_taken_so_far` that already worked.",
        actions
      ),
    };
    if (actions.click) questions.click_target = targetQ("clicked", clickables);
    if (actions.type) {
      questions.type_target = targetQ("typed into", fields);
      const textOptions = Object.fromEntries(texts.map((t) => [t, null]));
      if (llm) textOptions[COMPOSE] = "The text isn't written in the goal and has to be composed, for example a reply, message, comment, review, description or answer";
      textOptions[NONE] = "The goal doesn't say what text to type";
      questions.text = choice(
        "Which exact text should be typed into the field to make progress toward the `goal`? Pick just the text itself, without instruction words like 'search for' or 'type'.",
        textOptions
      );
      questions.submit = noul("After typing the text, should Enter be pressed to submit it, for example to run a search or send the form?");
    }
    if (actions.select) questions.select_target = targetQ("changed (dropdown)", selects);
    if (actions.open_url) questions.url = choice("Which web address from the goal should be opened?", Object.fromEntries(urls.map((u) => [u, null])));

    let res;
    if (isLaya(s)) res = await layaStep(ask, r, state, questions, { clickables, fields, selects, actions, texts, urls });
    else res = await ask(state, questions);
    const A = res.answers;
    const act = A.action;
    const top = topN(act.probabilities, 3);

    if (act.confidence < s.minConfidence) {
      finish("stopped", `Not confident what to do next (${pct(act.confidence)}). Top options: ${top}. Try a more specific prompt.`);
      return;
    }

    let step; // {type, id?, text?, submit?, value?, url?, label}
    const pickTarget = (qid, verb) => {
      const a = A[qid];
      if (!a || a.choice === NONE || !els[a.choice]) return { err: `${deciderName(s)} didn't find an element to ${verb}.` };
      if (a.confidence < s.minConfidence) {
        return { err: `Not confident which element to ${verb} (${pct(a.confidence)}): ${topN(a.probabilities, 3, els)}.` };
      }
      return { el: els[a.choice], conf: a.confidence };
    };

    switch (act.choice) {
      case "done":
        finish("done", `Done (${pct(act.confidence)} sure the goal is complete).`);
        return;
      case "click": {
        const t = pickTarget("click_target", "click");
        if (t.err) return finish("stopped", t.err);
        step = { type: "click", id: t.el.id, label: `Click ${t.el.desc}`, conf: Math.min(act.confidence, t.conf) };
        break;
      }
      case "type": {
        const t = pickTarget("type_target", "type into");
        if (t.err) return finish("stopped", t.err);
        const tx = A.text;
        let text = tx?.choice, textConf = tx?.confidence ?? 1;
        if (llm && (!tx || text === COMPOSE || text === NONE)) {
          text = await composeText(r, llm, snap, t.el, history);
          if (!text) return finish("stopped", "The text model returned nothing to type.");
          textConf = 1;
        } else if (!tx || text === NONE || text === COMPOSE) {
          return finish("stopped", "Couldn't tell what text to type. Put the exact text in quotes in your prompt, or set up a text model in Settings.");
        }
        const submit = (A.submit?.noul ?? 0) >= 0.5;
        const shown = text.length > 80 ? text.slice(0, 77) + "…" : text;
        step = {
          type: "type", id: t.el.id, text, submit,
          label: `Type "${shown}" into ${t.el.desc}${submit ? " and press Enter" : ""}`,
          conf: Math.min(act.confidence, t.conf, textConf),
        };
        break;
      }
      case "select": {
        const t = pickTarget("select_target", "change");
        if (t.err) return finish("stopped", t.err);
        const opts = (t.el.options || []).filter(Boolean);
        if (!opts.length) return finish("stopped", "That dropdown has no options.");
        const uniq = [...new Set(opts)];
        const o = (await ask(state, {
          option: choice(`Which option should be chosen in the dropdown "${t.el.desc}" to make progress toward the \`goal\`?`,
            Object.fromEntries(uniq.map((x) => [x, null]))),
        })).answers.option;
        step = { type: "select", id: t.el.id, value: o.choice, label: `Choose "${o.choice}" in ${t.el.desc}`, conf: Math.min(act.confidence, t.conf, o.confidence) };
        break;
      }
      case "open_url":
        step = { type: "open_url", url: A.url.choice, label: `Open ${A.url.choice}`, conf: act.confidence };
        break;
      case "scroll_down":
      case "scroll_up":
        if (++scrolls > 6) return finish("stopped", "Scrolled too many times without finding what's needed.");
        step = { type: act.choice, label: act.choice === "scroll_down" ? "Scroll down" : "Scroll up", conf: act.confidence };
        break;
      case "go_back":
        step = { type: "go_back", label: "Go back", conf: act.confidence };
        break;
      case "wait":
        if (++waits > 10) return finish("stopped", "Waited too long for the page to change.");
        log("info", "Waiting for the page…", `confidence ${pct(act.confidence)}`);
        await sleep(2500);
        r.step--; // waiting doesn't use up a step
        continue;
      default:
        return finish("error", `Unexpected action ${act.choice}`);
    }
    if (step.type !== "scroll_down" && step.type !== "scroll_up") scrolls = 0;
    waits = 0;

    // Loop guard: the same step three times means we're stuck.
    const key = `${snap.url}|${step.type}|${step.id ? els[step.id].desc : ""}|${step.text ?? step.value ?? step.url ?? ""}`;
    if (keys.filter((k) => k === key).length >= 2) return finish("stopped", `Stuck repeating: ${step.label}.`);
    keys.push(key);

    // Safety gate: confirm hard-to-undo actions before doing them.
    if (s.confirmRisky && (step.type === "click" || (step.type === "type" && step.submit))) {
      const risk = (await ask(
        { goal: r.goal, page: { url: snap.url, title: snap.title }, proposed_action: step.label },
        { risky: noul("Would doing `proposed_action` place an order or payment, delete something, send or publish a message or post, change account settings, or cause another hard-to-undo change?") }
      )).answers.risky.noul;
      if (risk >= 0.5) {
        r.status = "confirm";
        r.pending = { label: step.label, risk };
        log("confirm", `Waiting for your OK: ${step.label}`, `risk ${pct(risk)}`);
        const ok = await new Promise((resolve) => (r.confirm = resolve));
        r.confirm = null;
        r.pending = null;
        if (r.abort.signal.aborted) return;
        if (!ok) return finish("stopped", "You declined the action.");
        r.status = "running";
        publish();
      }
    }

    log("step", `${r.step}. ${step.label}`, `confidence ${pct(step.conf)}`);

    // --- perform ---
    let result = { ok: true };
    if (step.type === "open_url") {
      await chrome.tabs.update(r.tabId, { url: step.url });
    } else if (step.type === "go_back") {
      await chrome.tabs.goBack(r.tabId).catch(() => inject(r.tabId, performAction, [{ type: "go_back" }]));
    } else {
      try {
        result = (await inject(r.tabId, performAction, [step])) ?? { ok: true };
      } catch (e) {
        // The page navigating away mid-script is expected after a click or submit.
        if (!/(unloaded|removed|closed|navigat)/i.test(e.message)) throw e;
      }
    }
    if (!result.ok) log("warn", `Couldn't do that: ${result.note}`);

    history.push(`${step.label}${result.ok ? "" : ` (failed: ${result.note})`} [on ${snap.title || snap.url}]`);
    await sleep(step.type.startsWith("scroll") ? 300 : 800);
  }
  finish("stopped", `Reached the ${s.maxSteps}-step limit. Raise it in Settings if the task needs more steps.`);
}

// Laya picks the next step better from a list of concrete steps ("click link 'Sign in'",
// "type \"red shoes\" into text field 'Search'") than from Jev's action-then-target
// questions. The pick is mapped back to the same answers the loop uses; for a typing
// step the text and Enter questions follow. Laya's confidence runs lower than Jev's, so
// the probability of the chosen step is used as its confidence.
async function layaStep(ask, r, state, questions, { clickables, fields, selects, actions, texts }) {
  const say = (t) => (t.length > 40 ? `"${t.slice(0, 37)}…"` : `"${t}"`);
  const opts = {};
  for (const e of fields) if (actions.type) opts[`type:${e.id}`] = `type ${texts[0] ? say(texts[0]) : "text"} into ${e.desc}`;
  for (const e of clickables) opts[`click:${e.id}`] = `click ${e.desc}`;
  for (const e of selects) opts[`select:${e.id}`] = `choose an option in ${e.desc}`;
  if (actions.scroll_down) opts.scroll_down = "scroll down to see more of the page";
  if (actions.go_back) opts.go_back = "go back to the previous page";
  if (actions.open_url) opts.open_url = "open the web address written in the goal";
  opts.wait = "wait for the page to finish loading";
  opts.done = "nothing: the goal is already complete";
  const res = await ask(
    { goal: state.goal, steps_done: state.actions_taken_so_far, current_page: { url: state.current_page.url, title: state.current_page.title } },
    { next: choice("Which is the single next browser step toward `goal`, given `steps_done`? Don't repeat a step that already worked.", opts) }
  );
  const a = res.answers.next;
  const [kind, id] = a.choice.split(":");
  const p = a.probabilities[a.choice] ?? a.confidence;
  const byKind = {};
  for (const [k, v] of Object.entries(a.probabilities)) byKind[k.split(":")[0]] = (byKind[k.split(":")[0]] || 0) + v;
  const answers = { action: { choice: kind, probabilities: byKind, confidence: p } };
  const target = { choice: id, probabilities: { [id]: p }, confidence: p };
  if (kind === "click") answers.click_target = target;
  if (kind === "select") answers.select_target = target;
  if (kind === "type") {
    answers.type_target = target;
    const more = await ask(state, { text: questions.text, submit: questions.submit });
    Object.assign(answers, more.answers);
  }
  if (kind === "open_url" && questions.url) Object.assign(answers, (await ask(state, { url: questions.url })).answers);
  return { answers };
}

// ---------- questions about the page ----------
const PROMPT_KINDS = {
  task: "An instruction to do something in the browser: click, type, search, navigate, open, fill in, change, buy or send something",
  yes_no: "A question about the current page that is answered with yes or no",
  count: "A question asking how many of something there are on the current page",
  list: "A question asking which items or things on the current page match a description (there may be several)",
  lookup: "A question asking for one specific value, name, number or piece of text shown on the current page",
  find: "A request to find, highlight or show where certain things are on the page, e.g. 'highlight reviews that mention battery life'",
  hide: "A request to hide, remove, filter out, dim or fade certain things on the page, e.g. 'hide sponsored results'",
};

const EXPLAIN_KIND = "A request for a written answer about the current page: summarize, explain, describe, compare, translate, or an open question that isn't yes/no, a count, a list or one value";

// Laya is weaker than Jev at sorting prompts into many kinds, so with Laya: clear-cut
// phrasings are sorted by rules, then the text model (if set up), then Laya.
const QUICK_KINDS = [
  ["podcast", /\bpodcast\b|\b(discussion|conversation) (i|we) can listen/i, true],
  ["read", /^(please )?(read|narrate)\b(?!.*\b(and|then) (summari|explain|tell))/i, true],
  ["explain", /^(please )?(summari[sz]e|explain|describe|translate|tl;?dr|give me (a|the) (summary|gist|key points)|what('?s| is) (this|the) (page|article|post|thread) about)/i, true],
  ["count", /^how many\b/i],
  ["hide", /^(please )?(hide|remove|filter out|dim|fade|get rid of|mute)\b/i],
  ["find", /^(please )?(highlight|mark|outline|show me where)\b/i],
  ["list", /^(which|list)\b/i],
  ["yes_no", /^(is|are|does|do|did|can|could|has|have|was|were|will|should)\b.*\?\s*$/i],
  ["task", /^(please )?(click|open|go to|visit|search|type|fill|enter|add|buy|order|sign (in|up|out)|log ?(in|out)|navigate|scroll|press|select|choose|play|draw|create|make (a|an) (?!podcast)|send|post|reply|like|follow|subscribe|download|book|reserve|compose|write)\b/i],
];
const WANTS_VOICE = /\b(tell me|say it|out loud|aloud|read (it|that|them) (out|to me)|speak)\b/i;

async function classifyWithoutJev(r, llm, kinds) {
  const goal = r.goal.trim();
  if (WANTS_VOICE.test(goal) && llm) r.speak = true;
  for (const [kind, re, needsLlm] of QUICK_KINDS) {
    if (needsLlm && !llm) continue;
    if (re.test(goal)) { log("info", `Understood as: ${kind.replace("_", "/")}`, "from the wording"); return kind; }
  }
  if (!llm) return null;
  const out = await chat(llm, [
    { role: "system", content: `Classify a request made to a browser assistant about the web page the user is on. Reply with only one of these keys:
${Object.entries(kinds).map(([k, d]) => `${k}: ${d}`).join("\n")}` },
    { role: "user", content: `${r.selection ? `(The user selected some text on the page.)\n` : ""}Request: ${goal}` },
  ], { maxTokens: 8, signal: r.abort.signal }).catch(() => "");
  const k = (out.toLowerCase().match(/[a-z_]+/) || [])[0];
  if (k && kinds[k]) { log("info", `Understood as: ${k.replace("_", "/")}`, `by ${llm.lkModel || DEFAULT_MODEL}`); return k; }
  return null;
}

// Laya: make sure the model is loaded, showing download/start-up progress in the log.
let layaProgressEntry = null;
async function ensureLaya(r, s) {
  const st = await layaStatus().catch(() => null);
  if (st?.info) return;
  log("info", "Loading Laya, the in-browser decision model…", "The first time, this downloads the model once (about 290 MB for the int4 build). After that it loads from the browser's cache.");
  layaProgressEntry = r.log.at(-1);
  try {
    const info = await layaLoad(s);
    layaProgressEntry.text = `Laya ready: ${info.checkpoint === "laya" ? "general" : "typed-decisions"} model, ${info.device === "webgpu" ? "WebGPU" : `CPU (${info.threads} thread${info.threads === 1 ? "" : "s"})`}, ${Math.round(info.loadMs / 1000)} s to load${info.fromCache ? " from cache" : ""}.`;
    layaProgressEntry.detail = undefined;
    publish();
  } finally {
    layaProgressEntry = null;
  }
}
let lastLayaPublish = 0;
function onLayaProgress(msg) {
  if (!layaProgressEntry || !run) return;
  layaProgressEntry.text = msg.text;
  if (Date.now() - lastLayaPublish > 250) { lastLayaPublish = Date.now(); publish(); }
}

async function classifyPrompt(r, ask, llm) {
  if (isLaya(r.settings)) {
    const kinds0 = llm
      ? { ...PROMPT_KINDS, explain: EXPLAIN_KIND, read: "A request to read the page, the article or the selected text out loud, word for word",
          podcast: "A request to turn the page, article, post, thread or selected text into a podcast, or a spoken discussion or conversation between two voices to listen to" }
      : PROMPT_KINDS;
    const k = await classifyWithoutJev(r, llm, kinds0);
    if (k) return k;
  }
  const snap = await inject(r.tabId, snapshotPage, [60, 600]).catch(() => null);
  const kinds = llm
    ? { ...PROMPT_KINDS, explain: EXPLAIN_KIND, read: "A request to read the page, the article or the selected text out loud, word for word",
      podcast: "A request to turn the page, article, post, thread or selected text into a podcast, or a spoken discussion or conversation between two voices to listen to" }
    : PROMPT_KINDS;
  const questions = { kind: choice("What kind of request is `user_prompt`?", kinds) };
  if (llm) questions.wants_voice = noul("Does `user_prompt` ask for the answer to be spoken, said or read out loud?");
  const res = await ask(
    {
      user_prompt: r.goal,
      current_page: snap ? { url: snap.url, title: snap.title } : "unknown",
      ...(r.selection ? { selected_text: r.selection.slice(0, 1000), note: fromClipboard(r) ? "The prompt is about `selected_text`, which is the text on the user's clipboard" : "The prompt is about `selected_text`, which the user selected on the page" } : {}),
    },
    questions
  );
  const a = res.answers.kind;
  if ((res.answers.wants_voice?.noul ?? 0) >= 0.5) r.speak = true;
  log("info", `Understood as: ${a.choice.replace("_", "/")}`, `confidence ${pct(a.confidence)}`);
  return a.choice;
}

// Jev can't write an answer, so the answer is built in code from Jev's typed
// judgements: a Noul for yes/no, one Noul per page item for count/list (the
// docs' counting pattern: never ask the model to count), a Choice for lookup.
async function answerQuestion(r, ask, kind, llm, s) {
  if (kind === "explain") return writtenAnswer(r, llm);
  if (kind === "find" || kind === "hide") return filterAnswer(r, s, kind);
  let snap, items;
  if (r.selection) {
    // Answer from the selection only: its lines, or its sentences if it's one paragraph.
    const tab = await chrome.tabs.get(r.tabId);
    let parts = r.selection.split(/\n+/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (parts.length < 3) parts = r.selection.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
    snap = { url: tab.url, title: tab.title, text: r.selection.slice(0, 4000) };
    items = [...new Set(parts)].slice(0, 250).map((t) => ({ text: t, desc: `text "${t.slice(0, 300)}"` }));
  } else if (r.pdf) {
    // PDF: answer from its text; items are its paragraphs.
    snap = { url: r.pdf.url, title: r.pdf.title, text: pdfText(r.pdf, 4000) };
    items = r.pdf.paras.slice(0, endOfBody(r.pdf)).filter((p) => p.text.length > 20)
      .slice(0, isLaya(s) ? 80 : 250).map((p) => ({ text: p.text.slice(0, 400), desc: `text on page ${p.page}: "${p.text.slice(0, 300)}"` }));
  } else {
    snap = await inject(r.tabId, snapshotPage, [isLaya(s) ? 80 : 250, 4000]);
    if (!snap) throw new Error("Couldn't read the page.");
    // Items = interactive elements (with their link targets, which carry meaning)
    // plus text lines that aren't already an element's label.
    const names = new Set(snap.elements.map((e) => (e.name || "").toLowerCase()));
    items = snap.elements.map((e) => ({ id: e.id, text: e.name || e.desc, desc: e.desc }));
    const cap = isLaya(s) ? 80 : 250;
    items = items.slice(0, cap);
    for (const line of snap.lines) {
      if (items.length >= cap) break;
      if (!names.has(line.toLowerCase())) items.push({ text: line, desc: `text "${line}"` });
    }
  }
  if (!items.length) return finish("stopped", "Couldn't find any text or elements on this page to answer from.");
  const page = { url: snap.url, title: snap.title };
  let answer;

  if (kind === "yes_no") {
    const res = await ask(
      r.selection
        ? { question: r.goal, current_page: page, selected_text: snap.text }
        : { question: r.goal, current_page: { ...page, visible_text: snap.text } },
      { yes: noul(r.selection ? "Based on `selected_text`, is the answer to `question` yes?" : "Based on `current_page`, is the answer to `question` yes?") }
    );
    const p = res.answers.yes.noul;
    answer = {
      text: p >= 0.5 ? "Yes" : "No",
      note: `${pct(p >= 0.5 ? p : 1 - p)} sure` + (p > 0.3 && p < 0.7 ? ". Borderline: check the page." : ""),
      items: [],
    };
  } else if (kind === "lookup") {
    const res = await ask(
      { question: r.goal, current_page: page, items: items.map((x) => x.desc) },
      {
        pick: choice("Which item on the page answers `question`?", {
          ...Object.fromEntries(items.map((x, i) => [String(i), x.desc])),
          [NONE]: "None of the items answers the question",
        }),
      }
    );
    const a = res.answers.pick;
    if (a.choice === NONE && llm) {
      log("info", `${deciderName(s)} found no single item that answers this; asking the text model.`);
      return writtenAnswer(r, llm);
    } else if (a.choice === NONE) {
      answer = { text: "Not found on this page", note: `${pct(a.confidence)} sure`, items: [] };
    } else {
      const it = items[Number(a.choice)];
      const alts = Object.entries(a.probabilities).filter(([k, p]) => k !== a.choice && k !== NONE && p >= 0.15)
        .map(([k]) => items[Number(k)]?.text).filter(Boolean);
      answer = {
        text: it.text,
        note: `${pct(a.confidence)} confident` + (alts.length ? `. Other candidates: ${alts.join("; ")}` : ""),
        items: [{ text: it.text, id: it.id, ref: it.id ? { attr: "data-jev-id", val: it.id } : undefined }],
      };
    }
  } else {
    // count / list: one yes/no per item, tallied in code.
    let res;
    if (isLaya(s)) {
      const ps = await layaJudge(s, items.map((x) => x.text), r.goal, r.abort.signal);
      res = { answers: Object.fromEntries(ps.map((p, i) => [`i${i}`, { noul: p }])) };
    }
    const questions = {};
    items.forEach((_, i) => {
      questions[`i${i}`] = noul(`Is \`items[${i}]\` one of the things that \`question\` is asking about?`, {
        true: "It is an instance of exactly the kind of thing the question asks about",
        false: "It is something else, such as navigation, a label, a description or a different kind of thing",
      });
    });
    if (!res) res = await ask({ question: r.goal, current_page: page, items: items.map((x) => x.desc) }, questions);
    const seen = new Set();
    const matched = [], unsure = [];
    items.forEach((it, i) => {
      const p = res.answers[`i${i}`]?.noul ?? 0;
      const key = it.text.toLowerCase();
      if (p >= 0.5 && !seen.has(key)) {
        seen.add(key);
        matched.push({ text: it.text, id: it.id, p, ref: it.id ? { attr: "data-jev-id", val: it.id } : undefined });
      }
      else if (p >= 0.3 && p < 0.5) unsure.push(it.text);
    });
    answer = {
      text: kind === "count" ? String(matched.length) : matched.length ? `${matched.length} found` : "None found",
      note: unsure.length ? `Borderline, not counted: ${unsure.slice(0, 8).join("; ")}` : "",
      items: matched,
    };
  }

  const ids = answer.items.map((x) => x.id).filter(Boolean);
  if (ids.length) await inject(r.tabId, highlightElements, [ids, 8000]).catch(() => {});
  r.answer = answer;
  log("answer", answer.text, answer.note);
  finish("done", ids.length ? `Answered. Matches are outlined on the page for 8 seconds.` : "Answered.");
}

// Pause the run until you allow or cancel in the popup.
async function askUser(r, label) {
  r.status = "confirm";
  r.pending = { label };
  log("confirm", `Waiting for your OK: ${label}`);
  const ok = await new Promise((resolve) => (r.confirm = resolve));
  r.confirm = null;
  r.pending = null;
  if (!r.abort.signal.aborted) { r.status = "running"; publish(); }
  return ok && !r.abort.signal.aborted;
}

// Find / hide / dim by meaning: one Noul per page item (see rules.js).
async function filterAnswer(r, s, kind) {
  const mode = modeFor(kind, r.goal);
  log("info", mode === "highlight" ? "Checking each item on the page…" : `Checking which items to ${mode}…`);
  const res = await runFilter(s, r.tabId, r.goal, mode, r.abort.signal);
  if (!res.total) return finish("stopped", "Couldn't split this page into items to check.");
  const verb = { highlight: "found", hide: "hidden", dim: "dimmed" }[mode];
  r.answer = {
    text: res.matches.length ? `${res.matches.length} ${verb}` : "No matches",
    note: `Checked ${res.total} items on the page.` +
      (res.borderline.length ? ` Borderline, left alone: ${res.borderline.slice(0, 5).map((b) => b.text.slice(0, 60)).join("; ")}` : ""),
    items: res.matches.map((m) => ({ text: m.text.length > 140 ? m.text.slice(0, 137) + "…" : m.text, ref: { attr: "data-jev-item", val: m.k } })),
    filter: { mode, prompt: r.goal, host: res.host, count: res.matches.length },
  };
  log("answer", r.answer.text, r.answer.note);
  finish("done", mode === "highlight" ? "Matches are outlined on the page. Click one in the list to jump to it." : "Done. Use Undo to bring them back, or save this as a rule for the site.");
}

// ---------- read aloud (LiveKit Inference TTS) ----------
async function readAloud(r, s) {
  let title, text, truncated = false, what;
  if (podcast) { podcast.stop(); podcast = null; }
  if (r.pdf && !r.selection) {
    // A PDF: read a located section, or the whole document up to the references,
    // turning the viewer to each page as it goes.
    const doc = r.pdf;
    const target = await pickTarget(r, s, "read aloud");
    const whole = !(target.kind === "item" && target.range);
    const [from, to] = whole ? [bodyStart(doc), endOfBody(doc)] : target.range;
    const chunks = pdfChunks(doc, READ_CHUNK_CHARS, from, to);
    if (!chunks.length) return finish("stopped", "Couldn't find text to read in this PDF.");
    if (whole && from > 0) chunks[0].lines.unshift(`${doc.title}.`); // title, then straight to the abstract
    const words = doc.paras.slice(from, to).reduce((n, p) => n + p.text.split(/\s+/).length, 0);
    const minutes = Math.max(1, Math.round(words / 160));
    const what = target.kind === "item" ? `"${target.first.slice(0, 60)}"` : `"${doc.title.slice(0, 60)}"`;
    log("info", `Reading ${what} aloud from page ${chunks[0].page}: ${words.toLocaleString()} words, about ${minutes} min.`, target.kind === "item" ? undefined : `${from > 0 ? "Skips the author list; " : ""}stops before the references.`);
    startPdfReader(r.tabId, s, doc, chunks);
    r.answer = { text: "Reading aloud", note: `${doc.title} · about ${minutes} min · the PDF follows along · press ■ to stop`, items: [], spoken: true, reading: true };
    return finish("done", "Reading the PDF aloud.");
  }
  if (r.selection) {
    const tab = await chrome.tabs.get(r.tabId);
    title = fromClipboard(r) ? "Clipboard" : tab.title; text = r.selection; what = fromClipboard(r) ? "the clipboard" : "the selection";
  } else {
    const target = await pickTarget(r, s, "read aloud");
    if (target.kind === "item") {
      title = target.first; text = target.text; what = `"${target.first.slice(0, 60)}"`;
    } else {
      // The whole page: read progressively, a chunk at a time, scrolling down (and
      // letting feeds load more) until the end of the page or until you say stop.
      const tab = await chrome.tabs.get(r.tabId);
      const ok = await startPageReader(r.tabId, s, tab.title);
      if (!ok) return finish("stopped", "Couldn't find readable text on this page.");
      r.answer = { text: "Reading aloud", note: `${tab.title} · reading down the page until the end · press ■ to stop`, items: [], spoken: true, reading: true };
      return finish("done", "Reading the page aloud, scrolling as it goes.");
    }
  }
  const words = text.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 160));
  log("info", `Reading ${what} aloud: ${words.toLocaleString()} words, about ${minutes} min.`, truncated ? "Long page: reading the first 60,000 characters." : undefined);
  // Sentence by sentence, so the page can highlight the one being spoken.
  const list = text.split(/\n+/).flatMap((line) => voice.sentences(line)).filter((x) => x.trim());
  await startReadAlong(r.tabId, list, 0, s);
  r.readText = text;
  r.answer = { text: "Reading aloud", note: `${title} · about ${minutes} min · press ■ to stop`, items: [], spoken: true, reading: true };
  finish("done", "Reading aloud.");
}

// Which part of the page does the request mean? See targets.js (page outline →
// text model or Jev picks the range → extract its text).
function pickTarget(r, s, purpose) {
  return pickTargetFromOutline({
    tabId: r.tabId, goal: r.goal, settings: s, pdf: r.pdf || null, llm: lkConfigured(s) ? s : null, signal: r.abort.signal,
    log: (k, t, d) => log(k, t, d),
    inject: (func, args) => inject(r.tabId, func, args),
  }, purpose);
}

// ---------- read-along highlight ----------
let readAlong = null; // { tabId, list, lastSeg, highlighted }

async function startReadAlong(tabId, list, from, s, opts = {}) {
  if (opts.plain) {
    // PDFs: Chrome's viewer can't be highlighted; just track the sentence for "continue".
    readAlong = { tabId, list, lastSeg: from, highlighted: false, plain: true };
    await voice.speakSentences(s, list.slice(from), from);
    return;
  }
  const prep = await inject(tabId, prepareReadAlong, [list]).catch(() => null);
  readAlong = { tabId, list, lastSeg: from, highlighted: !!prep?.found };
  if (run && prep && from === 0 && !(reader && reader.chunks > 1)) log("info", prep.found ? `Read-along: following ${prep.found} of ${prep.total} sentences on the page.` : "Read-along: couldn't match the text on the page, so no highlight.");
  await voice.speakSentences(s, list.slice(from), from);
}

// ---- progressive page reader ----
// Reads the page chunk by chunk (about two screens at a time). When a chunk finishes it
// asks the page for the next one, which scrolls down; at the end of the loaded content
// it scrolls to the bottom so feeds load more, and stops when nothing more appears.
let reader = null; // { tabId, s, waiting: resolve fn, stopped, chunks }
const READ_CHUNK_CHARS = 1600;

async function startPageReader(tabId, s, title) {
  stopReadingOut();
  const me = {
    tabId, s, stopped: false, chunks: 0,
    nextChunk: () => inject(tabId, nextReadingChunk, [READ_CHUNK_CHARS, false]).catch(() => null),
    loadMore: () => inject(tabId, loadMoreBelow, []).catch(() => false),
  };
  reader = me;
  const first = await inject(tabId, nextReadingChunk, [READ_CHUNK_CHARS, true]).catch(() => null);
  if (!first?.lines?.length) { reader = null; return false; }
  if (run) log("info", `Reading "${title}" from ${first.lines[0].slice(0, 50)}… and continuing down the page.`);
  readerLoop(me, first).catch((e) => { if (run) log("warn", `Reader stopped: ${e.message}`); });
  return true;
}

// A PDF: read prepared chunks in order, turning Chrome's viewer to each chunk's page.
function startPdfReader(tabId, s, doc, chunks) {
  stopReadingOut();
  let i = 0;
  const me = {
    tabId, s, stopped: false, chunks: 0, plain: true,
    nextChunk: async () => chunks[i++] || null,
    loadMore: async () => false,
    onChunk: (c) => { if (c.page && c.page !== me.page) { me.page = c.page; goToPage(tabId, doc, c.page); } },
    endText: "That's the end of the document.",
  };
  reader = me;
  readerLoop(me, chunks[i++]).catch((e) => { if (run) log("warn", `Reader stopped: ${e.message}`); });
}

async function readerLoop(me, chunk) {
  let dry = 0;
  while (!me.stopped && reader === me) {
    if (!chunk?.lines?.length) {
      // Out of text: scroll to the bottom and give lazy-loading feeds a moment.
      const grew = await me.loadMore();
      if (!grew && ++dry >= 2) { await voice.speak(me.s, me.endText || "That's the end of the page."); break; }
      chunk = await me.nextChunk();
      continue;
    }
    dry = 0;
    me.chunks++;
    me.onChunk?.(chunk);
    const list = chunk.lines.flatMap((line) => voice.sentences(line)).filter((x) => x.trim());
    const done = waitForReadingDone(me);
    await startReadAlong(me.tabId, list, 0, me.s, { plain: me.plain });
    const reason = await done;
    if (reason !== "finished") { me.paused = true; return; } // stopped / interrupted: "continue" resumes
    chunk = await me.nextChunk();
  }
  if (reader === me) reader = null;
}

function waitForReadingDone(me) {
  return new Promise((resolve) => { me.waiting = resolve; });
}

function onReadAlongEvent(ev) {
  if (ev.kind === "tts-done" && ev.sentences && reader?.waiting) {
    const w = reader.waiting;
    reader.waiting = null;
    w(ev.reason);
  }
  if (!readAlong) return;
  if (ev.kind === "tts-seg") {
    readAlong.lastSeg = ev.idx;
    if (readAlong.highlighted) inject(readAlong.tabId, highlightSentence, [ev.idx]).catch(() => {});
  } else if (ev.kind === "tts-done" && ev.sentences && ev.reason !== "replaced") {
    if (ev.reason === "finished") readAlong.lastSeg = readAlong.list.length;
    inject(readAlong.tabId, clearReadAlong, []).catch(() => {});
  }
}

// "Continue" / "go on" after an interruption: pick up at the sentence that was playing.
async function continueReading() {
  const s = await loadSettings();
  // Interrupted podcast: pick up at the turn that was playing.
  if (podcast?.paused && !podcast.stopped) { podcast.play().catch(() => {}); return true; }
  // Paused page reader: finish the current chunk from where it stopped, then keep going down the page.
  if (reader?.paused && readAlong && reader.tabId === readAlong.tabId) {
    const me = reader;
    me.paused = false;
    (async () => {
      if (readAlong.lastSeg < readAlong.list.length - 1) {
        const done = waitForReadingDone(me);
        await startReadAlong(me.tabId, readAlong.list, Math.max(0, readAlong.lastSeg), s, { plain: me.plain });
        if ((await done) !== "finished") { me.paused = true; return; }
      }
      const next = await me.nextChunk();
      await readerLoop(me, next);
    })().catch(() => {});
    return true;
  }
  if (!readAlong || readAlong.lastSeg >= readAlong.list.length - 1) return false;
  await startReadAlong(readAlong.tabId, readAlong.list, Math.max(0, readAlong.lastSeg), s, { plain: readAlong.plain });
  return true;
}

// Stop the page reader and any podcast (a fresh read, a new podcast, or ■ Stop).
function stopReadingOut() {
  if (reader) reader.stopped = true;
  if (podcast) { podcast.stop(); podcast = null; }
}

// ---------- podcast mode ----------
let podcast = null; // the Podcast being written / performed (see podcast.js)
let lastPodcast = null; // { pod, title, run }: kept after it ends, for ⬇ Download

// Render the last podcast to an MP3 and save it with Chrome's downloads.
async function downloadPodcast() {
  const lp = lastPodcast;
  if (!lp?.pod.scriptDone || !lp.pod.turns.length) return { error: "There's no finished podcast script to download yet." };
  if (lp.busy) return { error: "Already preparing the download." };
  lp.busy = true;
  const a = lp.run.answer;
  const setDl = (dl) => { if (a?.podcast) { a.dl = dl; publish(); } };
  setDl({ state: "rendering", done: 0, total: lp.pod.turns.length });
  lp.onProgress = (done, total) => setDl({ state: "rendering", done, total });
  try {
    const res = await lp.pod.exportAudio();
    if (!res || res.error) throw new Error(res?.error || "The audio couldn't be made.");
    const safe = lp.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "podcast";
    const id = await chrome.downloads.download({ url: res.url, filename: `Docent podcasts/${safe}.${res.ext}`, conflictAction: "uniquify" });
    const mins = Math.floor(res.seconds / 60), secs = String(res.seconds % 60).padStart(2, "0");
    setDl({ state: "saved", id, ext: res.ext, text: `Saved ${res.ext.toUpperCase()} · ${mins}:${secs} · ${(res.bytes / 1048576).toFixed(1)} MB` });
    if (run) log("info", `Podcast audio saved to Downloads/Docent podcasts/${safe}.${res.ext} (${mins}:${secs}).`);
    return { ok: true, id };
  } catch (e) {
    setDl({ state: "error", text: e.message });
    return { error: e.message };
  } finally {
    lp.busy = false;
  }
}

async function makePodcast(r, s) {
  if (!lkConfigured(s)) throw new Error("Podcast mode uses LiveKit Inference (text model and voices). Add your LiveKit URL, key and secret in Settings.");
  r.kind = "podcast";
  const tab = await chrome.tabs.get(r.tabId);
  let title = tab.title, text, what, cited = false, pdfPages = null;
  if (r.selection) {
    text = r.selection; what = "the selection";
    if (fromClipboard(r)) { title = "Clipboard"; what = "the clipboard"; }
  } else if (r.pdf) {
    // A PDF: number its paragraphs [p1]… so each line can cite what it's about; while it
    // plays, the viewer turns to the page being discussed.
    const doc = r.pdf;
    title = doc.title;
    const target = await pickTarget(r, s, "turn into a podcast");
    const [from, to] = target.kind === "item" && target.range ? target.range : [0, endOfBody(doc)];
    what = target.kind === "item" ? `"${target.first.slice(0, 60)}"` : `"${doc.title.slice(0, 60)}"`;
    const lines = [];
    pdfPages = {};
    let chars = 0;
    for (let i = from; i < to && chars < 32000; i++) {
      const p = doc.paras[i], id = `p${i + 1}`;
      pdfPages[id] = p.page;
      const line = `[${id}] ${p.heading ? "## " : ""}${p.text}`;
      lines.push(line);
      chars += line.length;
    }
    text = lines.join("\n");
    cited = true;
    log("info", `Numbered ${lines.length} paragraphs of the PDF so the hosts can point at them; the viewer will follow along.`);
  } else {
    const target = await pickTarget(r, s, "turn into a podcast");
    what = target.kind === "item" ? `"${target.first.slice(0, 60)}"` : "the page";
    // Number the blocks, images and charts so the script can say which part each line is
    // about; while it plays, that part is highlighted and scrolled into view.
    const src = await inject(r.tabId, podcastSource, [target.start || null, target.end || null, 30000]).catch(() => null);
    if (src?.blocks >= 2) {
      text = src.text; cited = true;
      log("info", `Numbered ${src.blocks} text blocks${src.media ? ` and ${src.media} image${src.media === 1 ? "" : "s"}/chart${src.media === 1 ? "" : "s"}` : ""} so the hosts can point at them.`);
    } else if (target.kind === "item") {
      text = target.text;
    } else {
      const page = await inject(r.tabId, pageText, [16000]).catch(() => null);
      text = page?.text || "";
    }
  }
  if (!text.trim()) return finish("stopped", "Couldn't find text on this page to talk about.");
  stopReadingOut();
  await voice.stopSpeaking();
  if (readAlong) { inject(readAlong.tabId, clearReadAlong, []).catch(() => {}); readAlong = null; }

  const hosts = hostsFor(s);
  const expressive = s.podcastExpressive !== false && hosts.some((h) => supportsExpressive(h.voice));
  let last = 0;
  const pod = new Podcast({
    settings: s,
    hosts,
    expressive,
    log: (k, t) => { if (run === r) log(k, t); },
    onTurn: (t) => {
      if (pdfPages) {
        const page = (t.refs || []).map((id) => pdfPages[id]).find(Boolean);
        if (page && page !== pod.pdfPage) { pod.pdfPage = page; goToPage(r.tabId, r.pdf, page); }
      } else if (cited) inject(r.tabId, showPodcastRefs, [t.refs || []]).catch(() => {});
    },
    onEnd: () => { if (cited && !pdfPages) inject(r.tabId, clearPodcastRefs, []).catch(() => {}); },
    onUpdate: (p) => {
      if (!r.answer?.podcast) return;
      r.answer.text = p.transcript() || "Writing the script…";
      const n = p.turns.length;
      r.answer.note = p.stopped ? `${hosts[0].name} & ${hosts[1].name} · stopped`
        : p.finished ? `${hosts[0].name} & ${hosts[1].name} · finished (${n} turns)`
        : p.paused ? `${hosts[0].name} & ${hosts[1].name} · paused at turn ${p.idx + 1} · say "continue" to resume`
        : `${hosts[0].name} & ${hosts[1].name} · turn ${Math.min(p.idx + 1, n)} of ${n}${p.scriptDone ? "" : "+"} · press ■ to stop`;
      if (Date.now() - last > 200 || p.finished) { last = Date.now(); publish(); }
    },
  });
  podcast = pod;
  lastPodcast = { pod, title: `Podcast - ${title}`, run: r };
  r.answer = { text: "Writing the script…", note: `${hosts[0].name} & ${hosts[1].name}`, items: [], long: true, spoken: true, podcast: true };
  log("info", `Podcast of ${what}: ${hosts[0].name} and ${hosts[1].name} will discuss it.`, expressive ? "Expressive mode: the script marks emotion, pauses and emphasis for the voices." : undefined);
  pod.play().catch((e) => log("warn", `Podcast: ${e.message}`));
  try {
    await pod.write({ title, url: fromClipboard(r) ? "" : tab.url, text: text.slice(0, cited ? 32000 : 16000), goal: r.goal, signal: r.abort.signal, cited });
  } catch (e) {
    pod.stop();
    throw e;
  }
  if (!pod.turns.length) {
    pod.stop();
    r.answer = { text: "No script", note: `${s.lkModel || DEFAULT_MODEL} returned nothing. Try again, or pick a different text model in Settings.`, items: [], spoken: true };
    return finish("error", "The text model didn't return a script.");
  }
  const words = pod.turns.reduce((n, t) => n + stripExpr(t.text).split(/\s+/).length, 0);
  r.answer.downloadable = true;
  finish("done", `Script ready: ${pod.turns.length} turns, about ${Math.max(1, Math.round(words / 150))} min. Playing now.`);
}

// ---------- what next? (clickable suggestions after a run) ----------
const SUGGEST = {
  read: ["Summarize this page", "podcast", "What are the key takeaways?"],
  podcast: ["download", "Summarize this page", "read"],
  explain: ["podcast", "read", "What are the key takeaways?"],
  task: ["Summarize this page", "What can I do on this page?"],
  default: ["Summarize this page", "podcast", "read"],
};
function staticSuggestions(r) {
  const sel = !!r.selection;
  // Clipboard runs name the clipboard in the goal, so a follow-up reads it afresh.
  const [short, full] = fromClipboard(r) ? ["the clipboard", "the clipboard"] : ["the selection", "the selected text"];
  const make = (x) => x === "read" ? { label: sel ? `Read ${short} aloud` : "Read this page aloud", goal: sel ? `Read ${full} aloud` : "Read this page aloud", mode: "read" }
    : x === "download" ? { label: "Download the podcast (MP3)", goal: "Download the podcast audio", mode: "download" }
    : x === "podcast" ? { label: "Make it a podcast", goal: sel ? `Make a podcast of ${full}` : "Make a podcast of this page", mode: "podcast" }
    : { label: sel ? x.replace("this page", short) : x, goal: sel ? x.replace("this page", full) : x };
  const list = SUGGEST[r.kind] || SUGGEST.default;
  return list.map(make).filter((x) => x.goal.toLowerCase() !== r.goal.toLowerCase());
}

async function suggestNext(r) {
  const base = staticSuggestions(r);
  r.suggestions = base.slice(0, 3);
  publish();
  const s = r.settings;
  if (!s || !lkConfigured(s)) return;
  // Page-specific ideas from the text model, next to the built-in ones.
  const page = r.pdf ? { title: r.pdf.title, url: r.pdf.url, text: pdfText(r.pdf, 1500) } : await inject(r.tabId, pageText, [1500]).catch(() => null);
  const result = r.answer ? `${r.answer.text}`.slice(0, 400) : (r.log.at(-1)?.text || "");
  const out = await chat(s, [
    { role: "system", content: "You suggest what a user might want to do next with a browser assistant. It can answer questions about the page, summarize, find/highlight/hide items by meaning, read aloud, make a two-voice podcast, and click, type and navigate on the page. Reply with only a JSON array of 3 short requests (each under 8 words, written as the user would type them), specific to this page and the last result. Don't repeat the last request." },
    { role: "user", content: `Page: ${page?.title || ""} (${page?.url || ""})\nPage text (start): ${(page?.text || "").slice(0, 1200)}\n\nLast request: ${r.goal}\nResult: ${result}` },
  ], { maxTokens: 150 }).catch(() => "");
  let ideas = [];
  try { ideas = JSON.parse((out.match(/\[[\s\S]*\]/) || ["[]"])[0]); } catch (_) {}
  const seen = new Set([r.goal.toLowerCase(), ...base.map((x) => x.goal.toLowerCase())]);
  const extra = ideas.filter((x) => typeof x === "string" && x.trim() && x.length <= 80)
    .map((x) => x.trim().replace(/[.]$/, ""))
    .filter((x) => !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
    .slice(0, 3)
    .map((x) => ({ label: x, goal: x, ai: true }));
  if (run !== r || !extra.length) return;
  r.suggestions = [...base.slice(0, 2), ...extra];
  publish();
}

// ---------- hands-free conversation ----------
const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
const convo = new Conversation({
  loadSettings,
  startRun: async (goal, meta) => {
    if (run && (run.status === "running" || run.status === "confirm")) { run.abort.abort(); run.confirm?.(false); finish("stopped", "Interrupted."); }
    const tab = await activeTab();
    if (!tab) return null;
    await startRun(goal, tab.id, "", { voice: true, heard: meta.heard, history: meta.history });
    return run;
  },
  abortRun: () => { if (run && (run.status === "running" || run.status === "confirm")) { run.abort.abort(); run.confirm?.(false); finish("stopped", "Stopped."); } },
  continueReading,
  log: (k, t) => { if (run) log(k, t); },
  notify: (state) => chrome.runtime.sendMessage({ type: "conv:update", state }).catch(() => {}),
});
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "toggle-conversation") (convo.active ? convo.end(true) : convo.start()).catch(() => {});
  if (cmd === "pause-speaking") (voice.state.paused ? voice.resumeSpeaking() : voice.pauseSpeaking()).catch(() => {});
});

// ---------- text model (LiveKit Inference) ----------
async function writtenAnswer(r, llm) {
  let page;
  if (r.selection) {
    page = fromClipboard(r) ? { title: "Clipboard", url: "", text: r.selection.slice(0, 16000) }
      : { ...(await chrome.tabs.get(r.tabId)), text: r.selection.slice(0, 16000) };
  } else {
    const target = await pickTarget(r, r.settings || llm, "answer about");
    page = r.pdf
      ? { title: r.pdf.title, url: r.pdf.url, text: target.kind === "item" ? target.text.slice(0, 48000) : pdfText(r.pdf, 48000), item: target.kind === "item" }
      : target.kind === "item"
      ? { ...(await chrome.tabs.get(r.tabId)), text: target.text.slice(0, 16000), item: true }
      : await inject(r.tabId, pageText, [16000]);
  }
  const model = llm.lkModel || DEFAULT_MODEL;
  r.answer = { text: "", note: `Written by ${model} from the ${fromClipboard(r) ? "clipboard" : r.selection ? "selected" : "page"} text. Not checked by ${deciderName(r.settings || llm)}.`, items: [], long: true };
  log("info", `Asking ${model}…`);
  let last = 0, sent = 0;
  // Spoken reply: stream sentences to TTS while the text model is still writing.
  const speaker = r.speak ? await voice.speakStream(llm).catch((e) => { log("warn", `Voice: ${e.message}`); return null; }) : null;
  const text = await chat(llm, [
    { role: "system", content: (fromClipboard(r) ? "You answer questions about the text on the user's clipboard, using only that text." : "You answer questions about the web page the user is looking at, using only the page content provided.") + " Be concise. Plain text: short paragraphs or '- ' bullets, no markdown headings or bold. If the text doesn't contain the answer, say so." },
    ...(r.history?.length ? [{ role: "system", content: `Conversation so far (for context):\n${r.history.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n")}` }] : []),
    { role: "user", content: `${fromClipboard(r) ? "" : `Page title: ${page.title}\nURL: ${page.url}\n\n`}${fromClipboard(r) ? "Text on the user's clipboard" : r.selection ? "Text the user selected on the page" : page.item ? "The post or item on the page the user means" : "Page text"}:\n${page.text}\n\nQuestion: ${r.goal}` },
  ], {
    signal: r.abort.signal,
    maxTokens: 1200,
    onDelta: (t) => {
      r.answer.text = t;
      if (speaker) { speaker.push(t.slice(sent)); sent = t.length; }
      if (Date.now() - last > 150) { last = Date.now(); publish(); }
    },
  });
  r.answer.text = text.trim() || "(the model returned nothing)";
  if (speaker) { speaker.push(text.slice(sent)); speaker.end(); r.answer.spoken = true; }
  log("answer", r.answer.text.length > 140 ? r.answer.text.slice(0, 137) + "…" : r.answer.text, r.answer.note);
  finish("done", "Answered.");
}

async function composeText(r, llm, snap, field, history) {
  const page = await inject(r.tabId, pageText, [8000]);
  const model = llm.lkModel || DEFAULT_MODEL;
  log("info", `Writing text for ${field.desc} with ${model}…`);
  const out = await chat(llm, [
    { role: "system", content: "You write the text for one field on a web page, on behalf of the user. Reply with only the exact text to put in the field: no quotes around it, no preamble, no explanation, no markdown." },
    { role: "user", content: [
      `The user's goal: ${r.goal}`,
      `Page: ${snap.title} (${snap.url})`,
      `The field to fill: ${field.desc}`,
      history.length ? `Steps done so far:\n- ${history.join("\n- ")}` : "",
      `Page text:\n${page.text}`,
    ].filter(Boolean).join("\n\n") },
  ], { signal: r.abort.signal, maxTokens: 800 });
  const text = out.trim().replace(/^["“](.*)["”]$/s, "$1").trim();
  if (text) log("info", `${model} wrote: "${text.length > 140 ? text.slice(0, 137) + "…" : text}"`);
  return text;
}

// ---------- side panel, right-click menu, saved rules ----------
async function applyIconBehavior() {
  const { iconOpens } = await loadSettings();
  const panel = iconOpens === "panel";
  await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
  await chrome.action.setPopup({ popup: panel ? "" : "popup.html" });
}
applyIconBehavior();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.iconOpens) applyIconBehavior();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "jev-selection", title: "Ask Docent about \"%s\"", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "jev-page", title: "Ask Docent about this page", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // Must be called straight from the click (user gesture), before any await.
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  (async () => {
    let selection = "";
    if (info.menuItemId === "jev-selection") {
      selection = (await inject(tab.id, getSelectionText).catch(() => "")) || info.selectionText || "";
    }
    await chrome.storage.session.set({ jevPending: { selection, tabId: tab.id, t: Date.now() } });
  })();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "complete") return;
  const s = await loadSettings();
  applyRules(s, tabId, false).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));

// ---------- helpers ----------
async function inject(tabId, func, args) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

async function settle(tabId, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("The tab was closed.");
    if (tab.status === "complete") return;
    await sleep(200);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;
function topN(probs, n, els) {
  return Object.entries(probs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, p]) => `${els?.[k] ? els[k].desc : k} ${pct(p)}`)
    .join("; ");
}
