import { listModels, chat, KNOWN_MODELS, DEFAULT_MODEL, lkConfigured } from "./lk.js";
import { SUGGESTED_VOICES, STT_MODELS, DEFAULT_VOICE, DEFAULT_STT } from "./voice.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  apiKey: "", model: "jev-latest", apiBase: "https://api.typesafe.ai", maxSteps: 15, minConfidence: 0.3, confirmRisky: true,
  lkUrl: "", lkApiKey: "", lkApiSecret: "", lkModel: DEFAULT_MODEL, lkInferenceUrl: "",
  iconOpens: "popup",
  ttsVoice: DEFAULT_VOICE, sttModel: DEFAULT_STT, speakAnswers: false,
};
const IN_PANEL = new URLSearchParams(location.search).has("panel");
if (IN_PANEL) document.documentElement.classList.add("panel");
const FIELDS = Object.keys(DEFAULTS);

const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- settings ----------
async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(FIELDS)) };
  for (const k of FIELDS) {
    if (k === "lkModel" || k === "ttsVoice") continue; // filled by fillModels / fillVoices below
    const el = $(k);
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
  }
  fillVoices(s.ttsVoice || DEFAULT_VOICE);
  const { lkModelList } = await chrome.storage.local.get("lkModelList");
  fillModels(lkModelList?.length ? lkModelList : KNOWN_MODELS, s.lkModel || DEFAULT_MODEL);
  // First time with LiveKit set up: fetch the real model list in the background.
  if (!lkModelList?.length && lkConfigured(s)) $("lkRefresh").click();
  if (!s.apiKey) $("settings").hidden = false;
  return s;
}

function readForm() {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    s[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
  }
  if (s.lkModel === CUSTOM) s.lkModel = $("lkModelCustom").value.trim();
  if (s.ttsVoice === CUSTOM) s.ttsVoice = $("ttsVoiceCustom").value.trim() || DEFAULT_VOICE;
  if (!s.model) s.model = DEFAULTS.model;
  if (!s.apiBase) s.apiBase = DEFAULTS.apiBase;
  if (!s.lkModel) s.lkModel = DEFAULT_MODEL;
  return s;
}

// A real <select>: a <datalist> filters its suggestions by the text already in the box,
// so with a model filled in it only ever offered that one model.
const CUSTOM = "__custom__";
function fillModels(ids, selected = $("lkModel").value) {
  if (selected === CUSTOM) selected = $("lkModelCustom").value.trim();
  const list = [...new Set(ids)].sort();
  if (selected && !list.includes(selected)) list.unshift(selected);
  const byProvider = new Map();
  for (const id of list) {
    const p = id.includes("/") ? id.split("/")[0] : "other";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(id);
  }
  const groups = [...byProvider].map(([p, arr]) => {
    const g = document.createElement("optgroup");
    g.label = p;
    g.append(...arr.map((id) => new Option(id.slice(p.length + 1) || id, id)));
    return g;
  });
  const other = document.createElement("optgroup");
  other.label = "—";
  other.append(new Option("Other model…", CUSTOM));
  $("lkModel").replaceChildren(...groups, other);
  $("lkModel").value = selected || DEFAULT_MODEL;
  $("lkModelCustom").hidden = true;
}
$("lkModel").onchange = () => {
  const custom = $("lkModel").value === CUSTOM;
  $("lkModelCustom").hidden = !custom;
  if (custom) $("lkModelCustom").focus();
};
fillModels(KNOWN_MODELS, DEFAULT_MODEL);

// ---------- voice settings ----------
$("sttModel").replaceChildren(...STT_MODELS.map(([id, label]) => new Option(label, id)));
function fillVoices(selected) {
  const known = SUGGESTED_VOICES.map(([id]) => id);
  const opts = SUGGESTED_VOICES.map(([id, label]) => new Option(label, id));
  if (selected && !known.includes(selected)) opts.unshift(new Option(selected, selected));
  opts.push(new Option("Other voice…", CUSTOM));
  $("ttsVoice").replaceChildren(...opts);
  $("ttsVoice").value = selected || DEFAULT_VOICE;
  $("ttsVoiceCustom").hidden = true;
}
fillVoices(DEFAULT_VOICE);
$("ttsVoice").onchange = () => {
  const custom = $("ttsVoice").value === CUSTOM;
  $("ttsVoiceCustom").hidden = !custom;
  if (custom) $("ttsVoiceCustom").focus();
};
$("ttsPreview").onclick = async () => {
  const f = readForm();
  const name = ($("ttsVoice").selectedOptions[0]?.textContent || "").split(" · ")[0];
  const r = await send({ type: "voice:speakText", ttsVoice: f.ttsVoice, text: `Hi, I'm ${name || "your Jev voice"}. I can read this page to you, or answer questions about it.` });
  if (r?.error) lkStatus(r.error, "err");
};

function lkStatus(text, cls = "") {
  $("lkStatus").textContent = text;
  $("lkStatus").className = "help " + cls;
}

$("lkRefresh").onclick = async () => {
  const s = readForm();
  if (!lkConfigured(s)) return lkStatus("Enter the LiveKit URL, key and secret first.", "err");
  lkStatus("Loading models…");
  try {
    const ids = await listModels(s);
    fillModels(ids, s.lkModel);
    await chrome.storage.local.set({ lkModelList: ids });
    lkStatus(`${ids.length} models available.`, "ok");
  } catch (e) {
    lkStatus(`Couldn't list models (${e.message}). Using the built-in list.`, "err");
  }
};

$("lkTest").onclick = async () => {
  const s = readForm();
  if (!lkConfigured(s)) return lkStatus("Enter the LiveKit URL, key and secret first.", "err");
  lkStatus(`Asking ${s.lkModel}…`);
  const t0 = performance.now();
  try {
    const out = await chat(s, [{ role: "user", content: "Reply with exactly: OK" }], { maxTokens: 20 });
    lkStatus(`${s.lkModel} replied "${out.trim().slice(0, 40)}" in ${Math.round(performance.now() - t0)} ms.`, "ok");
  } catch (e) {
    lkStatus(e.message, "err");
  }
};

$("settingsBtn").onclick = () => ($("settings").hidden = !$("settings").hidden);
$("saveSettings").onclick = async () => {
  const s = readForm();
  await chrome.storage.local.set(s);
  $("settings").hidden = true;
  $("prompt").focus();
};

// ---------- run ----------
$("promptForm").onsubmit = async (e) => {
  e.preventDefault();
  const goal = $("prompt").value.trim();
  if (!goal) return;
  const tab = await activeTab();
  if (!tab) return;
  const selection = pending && pending.tabId === tab.id ? pending.selection : "";
  const res = await send({ type: "jev:start", goal, tabId: tab.id, selection });
  setPending(null);
  if (res?.error) render({ status: "error", log: [{ kind: "error", text: res.error }] });
  else render(res.run);
};
$("prompt").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("promptForm").requestSubmit();
});
$("stopBtn").onclick = () => send({ type: "jev:stop" }).then((r) => render(r.run));
$("copyBtn").onclick = async () => {
  const items = [...$("answerItems").children].map((li, i) => `${i + 1}. ${li.textContent}`);
  const text = [$("answerText").textContent, $("answerNote").textContent, ...items].filter(Boolean).join("\n");
  await navigator.clipboard.writeText(text).catch(() => {});
  $("copyBtn").textContent = "Copied";
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1200);
};
// ---------- answers: jump to items, undo, save as rule ----------
function focusItem(it) {
  if (lastRun?.tabId != null && it?.ref) send({ type: "jev:focus", tabId: lastRun.tabId, ref: it.ref });
}
function step(dir) {
  const items = (lastRun?.answer?.items || []).filter((x) => x.ref);
  if (!items.length) return;
  navIndex = (navIndex + dir + items.length) % items.length;
  focusItem(items[navIndex]);
  [...$("answerItems").children].forEach((li, i) => (li.style.fontWeight = i === navIndex ? "600" : ""));
}
$("skillUndoBtn").onclick = async () => {
  $("skillUndoBtn").disabled = true;
  const r = await send({ type: "jev:undoSkill" });
  $("skillUndoBtn").textContent = `Removed ${r?.removed ?? 0}`;
};
$("prevBtn").onclick = () => step(-1);
$("nextBtn").onclick = () => step(1);
$("undoBtn").onclick = async () => {
  const f = lastRun?.answer?.filter;
  if (!f) return;
  const r = await send({ type: "jev:clearMarks", tabId: lastRun.tabId, mode: f.mode });
  $("undoBtn").textContent = `Done (${r?.cleared ?? 0})`;
};
$("saveRuleBtn").onclick = async () => {
  const f = lastRun?.answer?.filter;
  if (!f) return;
  await send({ type: "jev:saveRule", tabId: lastRun.tabId, rule: { host: f.host, prompt: f.prompt, mode: f.mode } });
  $("saveRuleBtn").textContent = "Saved ✓";
  $("saveRuleBtn").disabled = true;
  renderRules();
};

// ---------- rules for the current site ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
const MODE_LABEL = { hide: "hide", dim: "dim", highlight: "highlight" };

async function renderRules() {
  const tab = await activeTab();
  const host = hostOf(tab?.url || "");
  const { rules = [] } = (await send({ type: "jev:rules" })) || {};
  const mine = rules.filter((r) => r.host === host);
  $("rulesBox").hidden = !mine.length;
  $("rulesSummary").textContent = `Rules for ${host} (${mine.length})`;
  $("rulesList").replaceChildren(...mine.map((rule) => {
    const li = document.createElement("li");
    if (!rule.enabled) li.className = "off";
    const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: rule.enabled, title: "Enabled" });
    cb.onchange = async () => { await send({ type: "jev:updateRule", id: rule.id, patch: { enabled: cb.checked }, tabId: tab.id }); renderRules(); };
    const tag = Object.assign(document.createElement("span"), { className: "mode-tag", textContent: MODE_LABEL[rule.mode] || rule.mode });
    const text = Object.assign(document.createElement("span"), { className: "rule-text", textContent: rule.prompt });
    const del = Object.assign(document.createElement("button"), { className: "icon", textContent: "✕", title: "Delete rule" });
    del.onclick = async () => { await send({ type: "jev:deleteRule", id: rule.id, tabId: tab.id }); renderRules(); };
    li.append(cb, tag, text, del);
    return li;
  }));
}
if (IN_PANEL) {
  chrome.tabs.onActivated.addListener(() => renderRules());
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") renderRules(); });
}

// ---------- selection from the right-click menu ----------
let pending = null;
function setPending(p) {
  pending = p && p.selection ? p : null;
  $("ctx").hidden = !pending;
  if (pending) {
    $("ctxText").textContent = pending.selection.replace(/\s+/g, " ").slice(0, 200);
    $("ctxText").title = pending.selection.slice(0, 1000);
    $("prompt").placeholder = "Ask about the selected text, e.g. \"explain this\" or \"is this a good deal?\"";
  } else {
    $("prompt").placeholder = "What should Jev do on this page? e.g. search for \"mechanical keyboards\" and open the first result";
  }
}
$("ctxClear").onclick = () => setPending(null);
async function takePending() {
  const { jevPending } = await chrome.storage.session.get("jevPending");
  if (!jevPending || Date.now() - jevPending.t > 5 * 60_000) return;
  await chrome.storage.session.remove("jevPending");
  setPending(jevPending);
  if (!jevPending.selection) $("prompt").value = "";
  $("prompt").disabled = false;
  $("prompt").focus();
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jevPending?.newValue) takePending();
});

// ---------- side panel ----------
let windowId = null;
chrome.windows.getCurrent().then((w) => (windowId = w.id));
$("panelBtn").hidden = IN_PANEL;
$("panelBtn").onclick = () => {
  // Called straight from the click so Chrome treats it as a user gesture.
  chrome.sidePanel.open({ windowId }).then(() => window.close()).catch(() => {});
};

// ---------- voice: read aloud, speak answers, ask by mic ----------
function voiceBar(mode, text) {
  const bar = $("voiceBar");
  bar.hidden = !mode;
  bar.className = "voice-bar " + (mode || "");
  if (text) $("voiceText").textContent = text;
}
$("readBtn").onclick = async () => {
  const tab = await activeTab();
  if (!tab) return;
  const selection = pending && pending.tabId === tab.id ? pending.selection : "";
  const res = await send({ type: "jev:start", goal: selection ? "Read the selected text aloud" : "Read this page aloud", tabId: tab.id, selection, read: true });
  setPending(null);
  if (res?.error) voiceBar("error", res.error); else render(res.run);
};
$("speakBtn").onclick = async () => {
  const a = lastRun?.answer;
  if (!a) return;
  const items = (a.items || []).map((x) => x.text).slice(0, 12);
  const r = await send({ type: "voice:speakText", text: `${a.text}${items.length ? ": " + items.join(", ") : ""}.` });
  if (r?.error) voiceBar("error", r.error);
};
$("voiceStop").onclick = async () => {
  await send({ type: "voice:stopListening" });
  await send({ type: "voice:stop" });
  $("micBtn").classList.remove("listening");
  voiceBar(null);
};

let listening = false, heard = "", silenceTimer = null;
function setListening(on) {
  listening = on;
  $("micBtn").classList.toggle("listening", on);
  $("micBtn").title = on ? "Stop listening and ask" : "Ask by voice";
}
$("micBtn").onclick = async () => {
  if (listening) {
    clearTimeout(silenceTimer);
    await send({ type: "voice:stopListening" });
    return;
  }
  heard = "";
  $("prompt").value = "";
  const tab = await activeTab();
  const selection = pending && tab && pending.tabId === tab.id ? pending.selection : "";
  const r = await send({ type: "voice:listen", tabId: tab?.id, selection });
  if (r?.error) return voiceBar("error", r.error);
  setListening(true);
  voiceBar("listening", "Listening… click 🎤 again when you're done");
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "voice:event") return;
  switch (msg.kind) {
    case "tts-started": voiceBar("speaking", "Speaking…"); break;
    case "tts-done": if (!listening) voiceBar(null); break;
    case "tts-error": voiceBar("error", msg.message); break;
    case "stt-interim":
    case "stt-final":
      heard = msg.text;
      $("prompt").value = heard;
      clearTimeout(silenceTimer);
      // A final transcript followed by a short pause ends the question.
      if (msg.kind === "stt-final" && heard) silenceTimer = setTimeout(() => send({ type: "voice:stopListening" }), 1400);
      break;
    case "mic-level":
      if (listening) $("voiceDot").style.transform = `scale(${1 + Math.min(1.5, msg.level * 4)})`;
      break;
    case "stt-stopped":
      setListening(false);
      voiceBar(null);
      // The background starts the run with what you said (even if the popup has closed).
      if ((msg.text || heard).trim()) { $("prompt").value = (msg.text || heard).trim(); setPending(null); }
      break;
    case "stt-error": setListening(false); voiceBar("error", msg.message); break;
    case "mic-denied":
      setListening(false);
      voiceBar("error", "Allow the microphone in the tab that just opened, then click 🎤 again.");
      break;
  }
});
send({ type: "voice:state" }).then((st) => { if (st?.speaking) voiceBar("speaking", "Speaking…"); });

$("approveBtn").onclick = () => send({ type: "jev:confirm", approve: true });
$("denyBtn").onclick = () => send({ type: "jev:confirm", approve: false });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jev:update") render(msg.run);
});

const LABELS = { running: "Working…", confirm: "Needs your OK", done: "Done", stopped: "Stopped", error: "Error" };

let lastRun = null;
let navIndex = -1;

function render(run) {
  lastRun = run;
  const status = run?.status;
  const busy = status === "running" || status === "confirm";
  $("status").textContent = LABELS[status] || "";
  $("status").className = "status " + (status || "");
  $("runBtn").disabled = busy;
  $("stopBtn").hidden = !busy;
  $("prompt").disabled = busy;
  if (run?.goal && (busy || !$("prompt").value)) $("prompt").value = run.goal;

  $("confirm").hidden = status !== "confirm" || !run.pending;
  if (run?.pending) $("confirmText").textContent = run.pending.label;

  const ans = run?.answer;
  $("answer").hidden = !ans;
  $("answer").classList.toggle("long", !!ans?.long);
  if (ans) {
    $("answerText").textContent = ans.text;
    $("answerNote").textContent = ans.note || "";
    $("answerItems").replaceChildren(...(ans.items || []).map((it, i) => {
      const li = document.createElement("li");
      li.textContent = it.text;
      if (it.ref) {
        li.className = "link";
        li.title = "Show on the page";
        li.onclick = () => { navIndex = i; focusItem(it); };
      }
      return li;
    }));
    $("skillActions").hidden = !ans.undo;
    $("skillUndoBtn").disabled = false;
    $("skillUndoBtn").textContent = "Remove what Jev added";
    const f = ans.filter;
    $("answerActions").hidden = !f;
    if (f) {
      $("prevBtn").hidden = $("nextBtn").hidden = !ans.items?.length;
      $("undoBtn").textContent = f.mode === "highlight" ? "Clear highlights" : f.mode === "hide" ? "Show hidden" : "Undim";
      $("saveRuleBtn").hidden = !f.host || !f.count;
      $("saveRuleBtn").textContent = `Save as rule for ${f.host}`;
    }
  }

  const ol = $("log");
  ol.replaceChildren(
    ...(run?.log || []).map((entry) => {
      const li = document.createElement("li");
      li.className = entry.kind;
      li.textContent = entry.text;
      if (entry.detail) {
        const small = document.createElement("small");
        small.textContent = entry.detail;
        li.append(small);
      }
      return li;
    })
  );
  ol.scrollTop = ol.scrollHeight;
}

(async () => {
  await loadSettings();
  const res = await send({ type: "jev:get" });
  render(res?.run);
  await takePending();
  renderRules();
  $("prompt").focus();
})();
