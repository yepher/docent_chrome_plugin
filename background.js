// Agent loop. Code stays in control; Jev makes narrow, typed decisions each step:
//   action   – which kind of step comes next (click / type / select / scroll / back / open URL / done)
//   *_target – which indexed page element to act on
//   text     – which span of the user's prompt to type (Jev doesn't generate text)
//   submit   – whether to press Enter after typing
// All of these are asked together in one request per step (speculative fan-out).

import { systemOne, choice, noul } from "./jev.js";
import { textCandidates, urlCandidates } from "./candidates.js";
import { snapshotPage, performAction, highlightElements } from "./page.js";

export const DEFAULTS = {
  apiKey: "",
  model: "jev-latest",
  apiBase: "https://api.typesafe.ai",
  maxSteps: 15,
  minConfidence: 0.3,
  confirmRisky: true,
};
const MAX_ELEMENTS = 150;
const PAGE_TEXT_CHARS = 1500;
const NONE = "none";

let run = null; // the one active (or last) run

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "jev:get":
        return publicRun();
      case "jev:start":
        if (run?.status === "running" || run?.status === "confirm") return { error: "A task is already running." };
        startRun(msg.goal, msg.tabId);
        return publicRun();
      case "jev:stop":
        if (run) { run.abort.abort(); run.confirm?.(false); finish("stopped", "Stopped by you."); }
        return publicRun();
      case "jev:confirm":
        run?.confirm?.(!!msg.approve);
        return publicRun();
      case "jev:clear":
        if (run && run.status !== "running" && run.status !== "confirm") { run = null; publish(); }
        return publicRun();
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

function publicRun() {
  if (!run) return { run: null };
  const { goal, tabId, status, log, pending, step, answer } = run;
  return { run: { goal, tabId, status, log, pending, step, answer } };
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
}

// ---------- the loop ----------
async function startRun(goal, tabId) {
  run = { goal, tabId, status: "running", log: [], pending: null, step: 0, abort: new AbortController() };
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
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!s.apiKey) throw new Error("No TypeSafe API key. Open Settings in the popup and paste your key.");
  const ask = (state, questions) =>
    systemOne({ apiBase: s.apiBase, apiKey: s.apiKey, model: s.model, state, questions, signal: r.abort.signal });

  const texts = textCandidates(r.goal);
  const urls = urlCandidates(r.goal);
  const history = []; // human-readable, fed back to Jev
  const keys = [];    // for loop detection
  let scrolls = 0;

  log("info", `Goal: ${r.goal}`);

  // Is this a question about the page, or something to do?
  await settle(r.tabId);
  const kind = await classifyPrompt(r, ask);
  if (kind !== "task") return answerQuestion(r, ask, kind);

  for (r.step = 1; r.step <= s.maxSteps; r.step++) {
    if (r.abort.signal.aborted) return;
    await settle(r.tabId);

    let snap;
    try {
      snap = await inject(r.tabId, snapshotPage, [MAX_ELEMENTS, PAGE_TEXT_CHARS]);
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
    if (fields.length && texts.length) actions.type = "Type text from the goal into a text field or search box listed in `page_elements`";
    if (selects.length) actions.select = "Choose an option in a dropdown listed in `page_elements`";
    if (!snap.atBottom) actions.scroll_down = "Scroll down, because the element needed next is not in `page_elements` yet";
    if (!snap.atTop) actions.scroll_up = "Scroll up to find an element above the current view";
    if (history.length) actions.go_back = "Go back to the previous page because the last step led somewhere wrong";
    if (urls.length) actions.open_url = "Open a web address that is written in the goal, because we are not on that site yet";
    actions.done = "The goal is already fully accomplished, judging by `actions_taken_so_far` and `current_page`";

    const state = {
      goal: r.goal,
      actions_taken_so_far: history.length ? history : "none yet",
      current_page: { url: snap.url, title: snap.title, visible_text: snap.text },
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
      questions.text = choice(
        "Which exact text should be typed into the field to make progress toward the `goal`? Pick just the text itself, without instruction words like 'search for' or 'type'.",
        { ...Object.fromEntries(texts.map((t) => [t, null])), [NONE]: "The goal doesn't say what text to type" }
      );
      questions.submit = noul("After typing the text, should Enter be pressed to submit it, for example to run a search or send the form?");
    }
    if (actions.select) questions.select_target = targetQ("changed (dropdown)", selects);
    if (actions.open_url) questions.url = choice("Which web address from the goal should be opened?", Object.fromEntries(urls.map((u) => [u, null])));

    const res = await ask(state, questions);
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
      if (!a || a.choice === NONE || !els[a.choice]) return { err: `Jev didn't find an element to ${verb}.` };
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
        if (!tx || tx.choice === NONE) return finish("stopped", "Couldn't tell what text to type. Put the exact text in quotes in your prompt.");
        const submit = (A.submit?.noul ?? 0) >= 0.5;
        step = {
          type: "type", id: t.el.id, text: tx.choice, submit,
          label: `Type "${tx.choice}" into ${t.el.desc}${submit ? " and press Enter" : ""}`,
          conf: Math.min(act.confidence, t.conf, tx.confidence),
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
      default:
        return finish("error", `Unexpected action ${act.choice}`);
    }
    if (step.type !== "scroll_down" && step.type !== "scroll_up") scrolls = 0;

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

// ---------- questions about the page ----------
const PROMPT_KINDS = {
  task: "An instruction to do something in the browser: click, type, search, navigate, open, fill in, change, buy or send something",
  yes_no: "A question about the current page that is answered with yes or no",
  count: "A question asking how many of something there are on the current page",
  list: "A question asking which items or things on the current page match a description (there may be several)",
  lookup: "A question asking for one specific value, name, number or piece of text shown on the current page",
};

async function classifyPrompt(r, ask) {
  const snap = await inject(r.tabId, snapshotPage, [60, 600]).catch(() => null);
  const res = await ask(
    { user_prompt: r.goal, current_page: snap ? { url: snap.url, title: snap.title } : "unknown" },
    { kind: choice("What kind of request is `user_prompt`?", PROMPT_KINDS) }
  );
  const a = res.answers.kind;
  log("info", `Understood as: ${a.choice.replace("_", "/")}`, `confidence ${pct(a.confidence)}`);
  return a.choice;
}

// Jev can't write an answer, so the answer is built in code from Jev's typed
// judgements: a Noul for yes/no, one Noul per page item for count/list (the
// docs' counting pattern: never ask the model to count), a Choice for lookup.
async function answerQuestion(r, ask, kind) {
  const snap = await inject(r.tabId, snapshotPage, [250, 4000]);
  if (!snap) throw new Error("Couldn't read the page.");

  // Items = interactive elements (with their link targets, which carry meaning)
  // plus text lines that aren't already an element's label.
  const names = new Set(snap.elements.map((e) => (e.name || "").toLowerCase()));
  const items = snap.elements.map((e) => ({ id: e.id, text: e.name || e.desc, desc: e.desc }));
  for (const line of snap.lines) {
    if (items.length >= 250) break;
    if (!names.has(line.toLowerCase())) items.push({ text: line, desc: `text "${line}"` });
  }
  if (!items.length) return finish("stopped", "Couldn't find any text or elements on this page to answer from.");
  const page = { url: snap.url, title: snap.title };
  let answer;

  if (kind === "yes_no") {
    const res = await ask(
      { question: r.goal, current_page: { ...page, visible_text: snap.text } },
      { yes: noul("Based on `current_page`, is the answer to `question` yes?") }
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
    if (a.choice === NONE) {
      answer = { text: "Not found on this page", note: `${pct(a.confidence)} sure`, items: [] };
    } else {
      const it = items[Number(a.choice)];
      const alts = Object.entries(a.probabilities).filter(([k, p]) => k !== a.choice && k !== NONE && p >= 0.15)
        .map(([k]) => items[Number(k)]?.text).filter(Boolean);
      answer = {
        text: it.text,
        note: `${pct(a.confidence)} confident` + (alts.length ? `. Other candidates: ${alts.join("; ")}` : ""),
        items: it.id ? [{ text: it.text, id: it.id }] : [],
      };
    }
  } else {
    // count / list: one yes/no per item, tallied in code.
    const questions = {};
    items.forEach((_, i) => {
      questions[`i${i}`] = noul(`Is \`items[${i}]\` one of the things that \`question\` is asking about?`, {
        true: "It is an instance of exactly the kind of thing the question asks about",
        false: "It is something else, such as navigation, a label, a description or a different kind of thing",
      });
    });
    const res = await ask({ question: r.goal, current_page: page, items: items.map((x) => x.desc) }, questions);
    const seen = new Set();
    const matched = [], unsure = [];
    items.forEach((it, i) => {
      const p = res.answers[`i${i}`]?.noul ?? 0;
      const key = it.text.toLowerCase();
      if (p >= 0.5 && !seen.has(key)) { seen.add(key); matched.push({ text: it.text, id: it.id, p }); }
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
