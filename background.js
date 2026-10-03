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
import { pdfFor, pdfText, pdfChunks, pdfNumbered, endOfBody, bodyStart, goToPage } from "./pdfdoc.js";
import { chat, lkConfigured, DEFAULT_MODEL } from "./lk.js";
import { focusRef, clearMarks, getSelectionText } from "./items.js";
import { pickTarget as pickTargetFromOutline } from "./targets.js";
import { pageSkeleton, applyEdits, undoEdits } from "./restyle.js";
import { languageIn, uiLanguage, translateLines, collectTexts, applyTexts, pageLanguage } from "./translate.js";
import { videoTranscript, seekVideo } from "./video.js";
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

// "help" (typed or said): how to use Docent. Answered here, without a model or the page.
const HELP = /^(please )?(help( me)?|\?+|commands|instructions|how (do|can) i use (this|it|you|docent)|what can (you|docent|this) do|how (does|do) (this|docent|you) work)[\s?.!]*$/i;
const HELP_TEXT = `Type what you want in the box, or use the mic. Docent works on the page in the current tab.

Ask about the page
- "Is this in stock?", "How many reviews are there?", "Which posts mention pricing?", "What is the total?"
- "Summarize this page", "Explain this article", "Summarize the post from Jane Doe"
- Click a number in a written answer to see the part of the page it came from

Videos (YouTube, or any video with captions)
- "Summarize this video", "What does she say about pricing?"
- Click a time in the answer to jump the video there

Find, hide or dim by meaning
- "Highlight reviews that mention battery life"
- "Hide sponsored results", "Dim posts about politics" (can be saved as a rule for the site)

Listen
- "Read this page aloud", "Read the post I'm looking at"
- "Make this a podcast", "A 5 minute podcast of this article" (two hosts; downloadable as MP3)
- Add "tell me" or "out loud" to have an answer spoken

Change the page
- "Change the page background to red", "Make the text bigger", "Make this page dark"
- "Replace every "colour" with "color"", then "Undo page changes" to put it back

Translate
- "Translate this page into Spanish" rewrites the page; "Undo page changes" puts it back
- "Read this page aloud in French", "Summarize this page in German"

Do things for you
- "Search for mechanical keyboards and open the first result"
- "Go to example.com", "Type "hello" in the message box"
- Docent asks before anything that buys, sends, posts or deletes

Use the clipboard or a selection
- "Read the clipboard aloud", "Summarize the clipboard", "Make a podcast of what I copied"
- Select text, right-click, "Ask Docent about …" to ask about just that text

Talk hands-free (Alt+Shift+J)
- Say requests one after another; talk over Docent to interrupt
- "stop", "continue", "repeat that", "goodbye"

Keys: Alt+J opens Docent, Alt+Shift+P pauses or resumes speech, ■ stops.
Settings (⚙): the decision model (Jev with a TypeSafe key, or Laya in your browser) and LiveKit for summaries, voice and podcasts.`;
const HELP_SPOKEN = "You can ask me questions about the page, or ask me to summarize it, read it aloud, or make it a podcast. I can highlight or hide things by meaning, change how the page looks, click and type for you, and read or summarize your clipboard. Say stop, continue or repeat that while I'm talking, and goodbye to finish. The full list is in the panel.";
function showHelp(r, s) {
  r.kind = "help";
  r.answer = { text: HELP_TEXT, note: "", items: [], long: true, spoken: true };
  if (r.speak && lkConfigured(s)) voice.speak(s, HELP_SPOKEN).catch((e) => log("warn", `Voice: ${e.message}`));
  finish("done", "Here's how to use Docent.");
}

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
        // The popup sends the suggestion itself: the service worker may have restarted
        // (Chrome stops it when idle) and forgotten the run the chip belongs to.
        const sg = msg.suggestion || (run?.suggestions || [])[msg.index];
        if (!sg?.goal) return { error: "That suggestion is gone." };
        if (sg.mode === "download") {
          if (!lastPodcast) return { error: "That podcast is no longer in memory. Make it again to download it." };
          downloadPodcast();
          return publicRun();
        }
        const keepSel = run?.tabId === msg.tabId ? run.selection || "" : "";
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
      case "jev:cite":
        return { ok: await showCitation(msg.ids) };
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
  if (HELP.test(r.goal.trim()) && !r.read && !r.podcast) return showHelp(r, s);
  if (UNDO_CHANGES.test(r.goal.trim())) return undoChanges(r);
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
  r.url = tab0.url || "";
  if (TRANSLATE_PAGE.test(r.goal.trim()) && !TRANSLATE_PART.test(r.goal) && !r.selection && !r.pdf && !r.read && !r.podcast) return translatePage(r, s);
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

const CHANGE_KIND = "A request to change how the current page itself looks or reads, in place: its background, colors, fonts, text size, spacing, width, dark or light look, or rewriting or replacing words shown on it. Not clicking the site's own controls";
// Clear-cut restyling requests, whichever decision model is in use.
const CHANGE_QUICK = /^(please )?(change|make|set|turn|switch|give|restyle|recolou?r|increase|decrease|enlarge|shrink)\b.*\b(background|colou?rs?|fonts?|text|dark|light|bigger|smaller|larger|wider|narrower|bold|headings?|theme|contrast|spacing|readable)\b/i;
const CHANGE_NOT = /\b(search|field|box|dropdown|menu|button|settings?|option|form|input|podcast)\b/i;
const UNDO_CHANGES = /^(please )?(undo|reset|revert|restore|remove)\b.*\b(changes?|styles?|styling|restyl\w*|edits?)\b|^(please )?(reset|restore|revert) (the|this) page\b/i;
// The kinds a prompt can be sorted into; the ones that need writing only with a text model.
const kindsFor = (llm) => llm
  ? { ...PROMPT_KINDS, explain: EXPLAIN_KIND, change: CHANGE_KIND, read: "A request to read the page, the article or the selected text out loud, word for word",
      podcast: "A request to turn the page, article, post, thread or selected text into a podcast, or a spoken discussion or conversation between two voices to listen to" }
  : PROMPT_KINDS;

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
  if (llm && aboutVideo(r)) {
    log("info", "Understood as: explain", "a question about the video");
    return "explain";
  }
  if (llm && !r.selection && CHANGE_QUICK.test(r.goal.trim()) && !CHANGE_NOT.test(r.goal)) {
    log("info", "Understood as: change", "from the wording");
    return "change";
  }
  if (isLaya(r.settings)) {
    const k = await classifyWithoutJev(r, llm, kindsFor(llm));
    if (k) return k;
  }
  const snap = await inject(r.tabId, snapshotPage, [60, 600]).catch(() => null);
  const kinds = kindsFor(llm);
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
  if (kind === "change") return changePage(r, llm);
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

// ---------- change the page in place (restyle.js) ----------
const CHANGE_PROMPT = `You change how a web page looks or reads, for a browser extension that applies your output to the page the user has open.
You get the user's request and an outline of the page: indented elements written as CSS selectors; "bg:<color>" marks an element whose painted background covers a notable part of the screen; quoted text is the element's own text.
Reply with JSON only:
{"css":"<CSS rules or empty>","edits":[{"selector":"<CSS selector>","text":"<new text>"},{"find":"<exact text on the page>","replace":"<new text>"}],"summary":"<one short sentence saying what was changed>"}
Rules:
- Use css for anything about appearance. Put !important on every declaration.
- A page-wide background or color change must also restyle the elements marked bg: that cover the page, or they will hide it.
- Keep text readable: when the background changes a lot, set a contrasting text color too.
- Use selectors that appear in the outline. No url(), no @import, no content from other sites.
- Use edits only to change wording: selector+text for one element's text, find+replace for a word or phrase everywhere.
- If the request can't be done with CSS or text edits, return empty css and edits and say why in summary.`;

// The CSS added to each tab this session, so it can be taken out again.
const cssKey = (tabId) => `docentCss:${tabId}`;
const addedCss = async (tabId) => (await chrome.storage.session.get(cssKey(tabId)))[cssKey(tabId)] || [];

async function changePage(r, llm) {
  if (!llm) return finish("stopped", "Changing a page needs a text model to write the change. Add your LiveKit URL, key and secret in Settings.");
  if (r.pdf) return finish("stopped", "Docent can't change how a PDF looks in Chrome's viewer.");
  let sk;
  try {
    sk = await inject(r.tabId, pageSkeleton, [9000]);
  } catch (e) {
    throw new Error(`Can't change this page (${e.message}). Chrome blocks extensions on chrome:// pages, the Web Store and some viewers.`);
  }
  if (!sk?.skeleton) return finish("stopped", "Couldn't read this page's structure.");
  const model = llm.lkModel || DEFAULT_MODEL;
  log("info", `Asking ${model} to write the change…`);
  const out = await chat(llm, [
    { role: "system", content: CHANGE_PROMPT },
    { role: "user", content: `Request: ${r.goal}\n\nPage: ${sk.title} (${sk.url})\nNow: body background ${sk.body.background}, text ${sk.body.color}, font ${sk.body.font}\n\nOutline:\n${sk.skeleton}` },
  ], { signal: r.abort.signal, maxTokens: 1500 });
  let j = {};
  try { j = JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch (_) {}
  // Styling only: nothing that would make the page load something from elsewhere.
  const css = String(j.css || "").replace(/@import[^;]*;?/gi, "").replace(/url\([^)]*\)/gi, "none").trim();
  const edits = Array.isArray(j.edits) ? j.edits.slice(0, 40) : [];
  if (!css && !edits.length) return finish("stopped", j.summary ? `Nothing changed: ${j.summary}` : "The text model didn't return a change for this page.");
  if (css) {
    // The user origin outranks the page's own !important rules.
    await chrome.scripting.insertCSS({ target: { tabId: r.tabId }, css, origin: "USER" });
    await chrome.storage.session.set({ [cssKey(r.tabId)]: [...(await addedCss(r.tabId)), css] });
    log("info", "Added CSS to the page.", css.length > 600 ? css.slice(0, 600) + "…" : css);
  }
  const edited = edits.length ? await inject(r.tabId, applyEdits, [edits]).catch(() => 0) : 0;
  if (edits.length) log(edited ? "info" : "warn", edited ? `Changed text in ${edited} place${edited === 1 ? "" : "s"}.` : "The text to change wasn't found on the page.");
  r.answer = {
    text: String(j.summary || "Changed the page.").slice(0, 400),
    note: `Written by ${model}. Only this tab is changed, until it reloads. "Undo page changes" puts it back.`,
    items: [], long: true,
  };
  log("answer", r.answer.text, r.answer.note);
  finish("done", "Page changed.");
}

async function undoChanges(r) {
  r.kind = "undo";
  const list = await addedCss(r.tabId);
  for (const css of list) await chrome.scripting.removeCSS({ target: { tabId: r.tabId }, css, origin: "USER" }).catch(() => {});
  await chrome.storage.session.remove(cssKey(r.tabId));
  const restored = (await inject(r.tabId, undoEdits, []).catch(() => 0)) || 0;
  if (!list.length && !restored) return finish("done", "There were no Docent changes on this page to undo. Reloading the page also resets it.");
  r.answer = { text: "Page changes undone", note: `${list.length} style change${list.length === 1 ? "" : "s"} and ${restored} text edit${restored === 1 ? "" : "s"} removed.`, items: [] };
  finish("done", "Undone.");
}

// ---------- translate the page in place (translate.js) ----------
const TRANSLATE_PAGE = /^(please )?(can you |could you )?translate\b/i;
// A named part of the page is answered in the Answer card instead ("translate the first comment").
const TRANSLATE_PART = /\b(post|comment|paragraph|heading|headline|title|sentence|word|phrase|section|quote|caption|review|message|tweet|selection|selected|clipboard)\b/i;
const TRANSLATE_CHARS = 60000;

async function translatePage(r, s) {
  r.kind = "translate";
  if (!lkConfigured(s)) return finish("stopped", "Translating a page needs a text model to write the translation. Add your LiveKit URL, key and secret in Settings.");
  const lang = languageIn(r.goal, true) || uiLanguage();
  log("info", `Goal: ${r.goal}`);
  let src;
  try {
    src = await inject(r.tabId, collectTexts, [TRANSLATE_CHARS]);
  } catch (e) {
    throw new Error(`Can't translate this page (${e.message}). Chrome blocks extensions on chrome:// pages, the Web Store and some viewers.`);
  }
  const total = src?.texts?.length || 0;
  if (!total) return finish("stopped", "Couldn't find text on this page to translate.");
  const model = s.lkModel || DEFAULT_MODEL;
  log("info", `Translating ${total.toLocaleString()} pieces of text into ${lang.name} with ${model}…`, src.more ? `Long page: translating the first ${TRANSLATE_CHARS.toLocaleString()} characters.` : undefined);
  const entry = r.log.at(-1);
  let done = 0, changed = 0;
  await translateLines(s, src.texts, lang.name, {
    signal: r.abort.signal,
    onBatch: async (pairs) => {
      changed += (await inject(r.tabId, applyTexts, [pairs]).catch(() => 0)) || 0;
      done += pairs.length;
      entry.text = `Translating into ${lang.name} with ${model}: ${done.toLocaleString()} of ${total.toLocaleString()} pieces of text…`;
      publish();
    },
  });
  entry.text = `Translated ${done.toLocaleString()} of ${total.toLocaleString()} pieces of text into ${lang.name} with ${model}.`;
  if (!changed) return finish("stopped", done ? `The page already reads as ${lang.name}: nothing changed.` : "The text model didn't return a translation.");
  r.answer = {
    text: `Translated into ${lang.name}`,
    note: `${changed.toLocaleString()} piece${changed === 1 ? "" : "s"} of text changed, written by ${model}${src.more ? " (the first part of a long page)" : ""}. Only this tab is changed, until it reloads. "Undo page changes" puts it back.`,
    items: [],
  };
  log("answer", r.answer.text, r.answer.note);
  finish("done", "Page translated.");
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
// "Read this page aloud in Spanish": each part is translated just before it is spoken.
// Returns { name, code } or null (also when the page is already in that language).
async function readingLanguage(r) {
  const lang = languageIn(r.goal);
  if (!lang) return null;
  const pageLang = r.selection || r.pdf ? "" : await inject(r.tabId, pageLanguage, []).catch(() => "");
  if (pageLang && lang.code && pageLang.toLowerCase().split("-")[0] === lang.code) return null;
  log("info", `Translating into ${lang.name} as it reads.`, "The words spoken aren't the ones on the page, so there's no read-along highlight. How natural it sounds depends on the voice chosen in Settings.");
  return lang;
}

async function readAloud(r, s) {
  let title, text, truncated = false, what;
  if (podcast) { podcast.stop(); podcast = null; }
  const lang = await readingLanguage(r);
  const inLang = lang ? ` · in ${lang.name}` : "";
  if (lang) s = { ...s, ttsLang: lang.code };
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
    startPdfReader(r.tabId, s, doc, chunks, lang);
    r.answer = { text: "Reading aloud", note: `${doc.title}${inLang} · about ${minutes} min · the PDF follows along · press ■ to stop`, items: [], spoken: true, reading: true };
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
      const ok = await startPageReader(r.tabId, s, tab.title, lang);
      if (!ok) return finish("stopped", "Couldn't find readable text on this page.");
      r.answer = { text: "Reading aloud", note: `${tab.title}${inLang} · reading down the page until the end · press ■ to stop`, items: [], spoken: true, reading: true };
      return finish("done", "Reading the page aloud, scrolling as it goes.");
    }
  }
  const words = text.split(/\s+/).length;
  const minutes = Math.max(1, Math.round(words / 160));
  log("info", `Reading ${what} aloud: ${words.toLocaleString()} words, about ${minutes} min.`, truncated ? "Long page: reading the first 60,000 characters." : undefined);
  // Sentence by sentence, so the page can highlight the one being spoken.
  let lines = text.split(/\n+/).filter((x) => x.trim());
  if (lang) lines = await translateLines(s, lines, lang.name, { signal: r.abort.signal });
  const list = lines.flatMap((line) => voice.sentences(line)).filter((x) => x.trim());
  await startReadAlong(r.tabId, list, 0, s, { plain: !!lang });
  r.readText = text;
  r.answer = { text: "Reading aloud", note: `${title}${inLang} · about ${minutes} min · press ■ to stop`, items: [], spoken: true, reading: true };
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
    readAlong = { tabId, list, lastSeg: from, highlighted: false, plain: true, s };
    await voice.speakSentences(s, list.slice(from), from);
    return;
  }
  const prep = await inject(tabId, prepareReadAlong, [list]).catch(() => null);
  readAlong = { tabId, list, lastSeg: from, highlighted: !!prep?.found, s };
  if (run && prep && from === 0 && !(reader && reader.chunks > 1)) log("info", prep.found ? `Read-along: following ${prep.found} of ${prep.total} sentences on the page.` : "Read-along: couldn't match the text on the page, so no highlight.");
  await voice.speakSentences(s, list.slice(from), from);
}

// ---- progressive page reader ----
// Reads the page chunk by chunk (about two screens at a time). When a chunk finishes it
// asks the page for the next one, which scrolls down; at the end of the loaded content
// it scrolls to the bottom so feeds load more, and stops when nothing more appears.
let reader = null; // { tabId, s, waiting: resolve fn, stopped, chunks }
const READ_CHUNK_CHARS = 1600;

async function startPageReader(tabId, s, title, lang) {
  stopReadingOut();
  const me = {
    tabId, s, stopped: false, chunks: 0, lang, plain: !!lang,
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
function startPdfReader(tabId, s, doc, chunks, lang) {
  stopReadingOut();
  let i = 0;
  const me = {
    tabId, s, stopped: false, chunks: 0, plain: true, lang,
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
    let lines = chunk.lines;
    if (me.lang) {
      lines = await translateLines(me.s, lines, me.lang.name).catch((e) => { if (run) log("warn", `Couldn't translate this part (${e.message}); reading it as written.`); return lines; });
      if (me.stopped || reader !== me) break;
    }
    const list = lines.flatMap((line) => voice.sentences(line)).filter((x) => x.trim());
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
        await startReadAlong(me.tabId, readAlong.list, Math.max(0, readAlong.lastSeg), me.s, { plain: me.plain });
        if ((await done) !== "finished") { me.paused = true; return; }
      }
      const next = await me.nextChunk();
      await readerLoop(me, next);
    })().catch(() => {});
    return true;
  }
  if (!readAlong || readAlong.lastSeg >= readAlong.list.length - 1) return false;
  await startReadAlong(readAlong.tabId, readAlong.list, Math.max(0, readAlong.lastSeg), readAlong.s || s, { plain: readAlong.plain });
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
    const src = pdfNumbered(doc, 32000, from, to);
    pdfPages = src.pages;
    text = src.text;
    cited = true;
    log("info", `Numbered ${src.count} paragraphs of the PDF so the hosts can point at them; the viewer will follow along.`);
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
  change: ["Undo page changes", "Summarize this page", "read"],
  translate: ["Undo page changes", "Summarize this page", "podcast"],
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
// Written answers cite their source: the text given to the model is split into numbered
// blocks ([p12] text, [m3] image, [t40] a moment in a video), the model ends each sentence
// with the ids it rests on, and the Answer card shows them as links (see showCitation).
// Models also write ranges ("[t1-t3]", "[p4–p6, p9]"); a range counts as its first block onwards.
const CITE = /\s*\[(?:[pmt]\d+(?:\s*[-–]\s*[pmt]?\d+)?)(?:\s*,\s*[pmt]\d+(?:\s*[-–]\s*[pmt]?\d+)?)*\]/gi;
const CITE_PARTIAL = /\s*\[[pmt\d,\s–-]*$/i; // a marker still being written
const stripCites = (t) => t.replace(CITE, "").replace(CITE_PARTIAL, "");
const citedIds = (t) => [...new Set((t.match(CITE) || []).join(" ").toLowerCase().match(/[pmt]\d+/g) || [])];
const clock = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = String(Math.floor(sec % 60)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};

// Is the request a question about the video on the page (rather than the page around it)?
const VIDEO_SITE = /^https?:\/\/((www|m|music)\.)?youtube\.com\/(watch|shorts|live)|^https?:\/\/youtu\.be\//i;
const VIDEO_WORDS = /\b(video|transcript|captions?|subtitles?|talk|lecture|episode|speaker|presenter|interview)\b/i;
const VIDEO_NOT = /\b(comments?|description|channel|subscribers?|views|likes|sidebar|recommended|playlist)\b/i;
const VIDEO_ASK = /\?\s*$|^(please )?(what|who|when|where|why|how|which|is|are|does|do|did|summari[sz]e|explain|describe|tl;?dr|give me|list|tell me)\b/i;
const aboutVideo = (r) => !r.selection && !r.pdf && VIDEO_ASK.test(r.goal.trim())
  && (VIDEO_WORDS.test(r.goal) || (VIDEO_SITE.test(r.url || "") && !VIDEO_NOT.test(r.goal)));
const VIDEO_CHARS = 100000; // about an hour and three quarters of speech

// The video's captions as numbered, timed blocks, or null if there are none to use.
async function videoSource(r) {
  const v = await inject(r.tabId, videoTranscript, [navigator.language || "en"], "MAIN").catch((e) => ({ error: e.message }));
  if (!v) return null;
  if (v.error || !v.blocks?.length) {
    log("warn", `Couldn't use the video's captions (${v.error || "there are none"}). Answering from the page text instead.`);
    return null;
  }
  const lines = [], times = {};
  let chars = 0;
  for (const [i, b] of v.blocks.entries()) {
    const line = `[t${i + 1}] (${clock(b.t)}) ${b.text}`;
    if (chars + line.length > VIDEO_CHARS) break;
    times[`t${i + 1}`] = b.t;
    lines.push(line);
    chars += line.length;
  }
  const cut = lines.length < v.blocks.length;
  log("info", `Video: "${v.title.slice(0, 80)}"${v.duration ? `, ${clock(v.duration)}` : ""}. Using its ${v.auto ? "auto-generated " : ""}${v.langName} captions.`,
    cut ? `Long video: using the first ${clock(v.blocks[lines.length].t)}.` : undefined);
  return { title: v.title, author: v.author, text: lines.join("\n"), times };
}

// A citation clicked in the Answer card: show that part of the page, turn the PDF to its
// page, or jump the video to that moment. id null clears the highlight.
// What the links point at is kept in session storage, so they still work after Chrome has
// stopped and restarted the service worker. ids: the blocks of one link (several for a range).
async function showCitation(ids) {
  const id = ids?.[0];
  const { docentCite: c } = await chrome.storage.session.get("docentCite");
  if (!c) return false;
  if (c.type === "video") return id != null && c.times[id] != null && !!(await inject(c.tabId, seekVideo, [c.times[id]]).catch(() => false));
  if (c.type === "pdf") { if (!c.pages[id]) return false; await goToPage(c.tabId, { url: c.url }, c.pages[id]); return true; }
  if (id == null) return !!(await inject(c.tabId, clearPodcastRefs, []).catch(() => false));
  return !!(await inject(c.tabId, showPodcastRefs, [ids]).catch(() => 0));
}

async function writtenAnswer(r, llm) {
  let page, cite = null, source = "page text";
  if (r.selection) {
    page = fromClipboard(r) ? { title: "Clipboard", url: "", text: r.selection.slice(0, 16000) }
      : { ...(await chrome.tabs.get(r.tabId)), text: r.selection.slice(0, 16000) };
    source = fromClipboard(r) ? "clipboard text" : "selected text";
  } else {
    const video = aboutVideo(r) ? await videoSource(r) : null;
    if (video) {
      page = { title: video.title, url: r.url, text: video.text, author: video.author };
      cite = { type: "video", times: video.times };
      source = "video's captions";
    } else {
      const target = await pickTarget(r, r.settings || llm, "answer about");
      const item = target.kind === "item";
      if (r.pdf) {
        const [from, to] = item && target.range ? target.range : [0, r.pdf.paras.length];
        const src = pdfNumbered(r.pdf, 48000, from, to);
        page = { title: r.pdf.title, url: r.pdf.url, text: src.text, item };
        cite = { type: "pdf", pages: src.pages };
        source = "PDF's text";
      } else {
        // Number the blocks (the located part, or the whole page) so the answer can cite them.
        const src = await inject(r.tabId, podcastSource, [target.start || null, target.end || null, 16000, !item]).catch(() => null);
        if (src?.blocks >= 2) {
          page = { ...(await chrome.tabs.get(r.tabId)), text: src.text, item };
          cite = { type: "dom" };
        } else {
          page = item ? { ...(await chrome.tabs.get(r.tabId)), text: target.text.slice(0, 16000), item: true } : await inject(r.tabId, pageText, [16000]);
        }
      }
    }
  }
  if (cite) await chrome.storage.session.set({ docentCite: { ...cite, tabId: r.tabId, url: r.pdf?.url || "" } });
  else await chrome.storage.session.remove("docentCite");
  const model = llm.lkModel || DEFAULT_MODEL;
  const noteFor = (cited) => `Written by ${model} from the ${source}. Not checked by ${deciderName(r.settings || llm)}.`
    + (!cited ? "" : cite.type === "video" ? " Click a time to jump the video there." : cite.type === "pdf" ? " Click a page number to turn the PDF to it." : " Click a number to see that part of the page.");
  r.answer = { text: "", note: noteFor(false), items: [], long: true };
  log("info", `Asking ${model}…`);
  // What each citation is shown as: a time in the video or a page of the PDF (page blocks are just numbered).
  const refsFor = (t) => cite.type === "dom" ? undefined
    : Object.fromEntries(citedIds(t).filter((id) => (cite.times || cite.pages)[id] != null).map((id) => [id, cite.type === "video" ? clock(cite.times[id]) : `p. ${cite.pages[id]}`]));
  const show = (t, final) => {
    if (!cite) { r.answer.text = final ? t.trim() : t; return t; }
    const clean = stripCites(t);
    r.answer.text = final ? clean.trim() : clean;
    r.answer.cited = citedIds(t).length ? t.replace(CITE_PARTIAL, "") : undefined;
    r.answer.refs = r.answer.cited ? refsFor(t) : undefined;
    r.answer.note = noteFor(!!r.answer.cited);
    return final ? clean : clean.trimEnd(); // what can be spoken so far: nothing that a marker may still follow
  };
  let last = 0, sent = 0;
  // Spoken reply: stream sentences to TTS while the text model is still writing.
  const lang = r.speak ? languageIn(r.goal) : null;
  const speaker = r.speak ? await voice.speakStream(lang ? { ...llm, ttsLang: lang.code } : llm).catch((e) => { log("warn", `Voice: ${e.message}`); return null; }) : null;
  const subject = fromClipboard(r) ? "the text on the user's clipboard, using only that text"
    : cite?.type === "video" ? "the video the user is watching, using only its transcript"
    : "the web page the user is looking at, using only the page content provided";
  const citing = !cite ? ""
    : cite.type === "video" ? " The transcript is split into numbered blocks such as [t12], each starting with its time in the video. End each sentence or bullet with the id of the block where that is said, in square brackets, e.g. \"She recommends starting small [t12].\" Use single ids exactly as given, never a range like [t3-t7]: when something runs over several blocks, cite the one where it starts. At most two ids per sentence, and don't write times yourself."
    : ` The text is split into numbered blocks such as [p12]${cite.type === "dom" ? ", with images and charts as [m3]" : ""}. End each sentence or bullet with the ids of the blocks it is based on, in square brackets, e.g. \"Sales doubled in a year [p14].\" Use single ids exactly as given, never a range like [p3-p7], at most three per sentence, and never mention them otherwise.`;
  const label = fromClipboard(r) ? "Text on the user's clipboard" : r.selection ? "Text the user selected on the page"
    : cite?.type === "video" ? "Transcript" : page.item ? "The post or item on the page the user means" : "Page text";
  const text = await chat(llm, [
    { role: "system", content: `You answer questions about ${subject}. Be concise. Plain text: short paragraphs or '- ' bullets, no markdown headings or bold. If the text doesn't contain the answer, say so.${citing}` },
    ...(r.history?.length ? [{ role: "system", content: `Conversation so far (for context):\n${r.history.map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.text}`).join("\n")}` }] : []),
    { role: "user", content: `${fromClipboard(r) ? "" : `${cite?.type === "video" ? "Video" : "Page"} title: ${page.title}\n${page.author ? `Channel: ${page.author}\n` : ""}URL: ${page.url}\n\n`}${label}:\n${page.text}\n\nQuestion: ${r.goal}` },
  ], {
    signal: r.abort.signal,
    maxTokens: cite ? 1500 : 1200,
    onDelta: (t) => {
      const say = show(t, false);
      if (speaker) { speaker.push(say.slice(sent)); sent = say.length; }
      if (Date.now() - last > 150) { last = Date.now(); publish(); }
    },
  });
  const say = show(text, true);
  if (!r.answer.text) r.answer.text = "(the model returned nothing)";
  if (speaker) { speaker.push(say.slice(sent)); speaker.end(); r.answer.spoken = true; }
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
async function inject(tabId, func, args, world) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, ...(world ? { world } : {}) });
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
