import { listModels, chat, KNOWN_MODELS, DEFAULT_MODEL, lkConfigured } from "./lk.js";

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  apiKey: "", model: "jev-latest", apiBase: "https://api.typesafe.ai", maxSteps: 15, minConfidence: 0.3, confirmRisky: true,
  lkUrl: "", lkApiKey: "", lkApiSecret: "", lkModel: DEFAULT_MODEL, lkInferenceUrl: "",
  iconOpens: "popup",
};
const IN_PANEL = new URLSearchParams(location.search).has("panel");
if (IN_PANEL) document.documentElement.classList.add("panel");
const FIELDS = Object.keys(DEFAULTS);

const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- settings ----------
async function loadSettings() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(FIELDS)) };
  for (const k of FIELDS) {
    const el = $(k);
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
  }
  if (!s.apiKey) $("settings").hidden = false;
  return s;
}

function readForm() {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    s[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
  }
  if (!s.model) s.model = DEFAULTS.model;
  if (!s.apiBase) s.apiBase = DEFAULTS.apiBase;
  if (!s.lkModel) s.lkModel = DEFAULT_MODEL;
  return s;
}

function fillModels(ids) {
  $("lkModels").replaceChildren(...ids.map((id) => Object.assign(document.createElement("option"), { value: id })));
}
fillModels(KNOWN_MODELS);

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
    fillModels(ids);
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
