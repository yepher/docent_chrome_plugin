const $ = (id) => document.getElementById(id);
const DEFAULTS = { apiKey: "", model: "jev-latest", apiBase: "https://api.typesafe.ai", maxSteps: 15, minConfidence: 0.3, confirmRisky: true };
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

$("settingsBtn").onclick = () => ($("settings").hidden = !$("settings").hidden);
$("saveSettings").onclick = async () => {
  const s = {};
  for (const k of FIELDS) {
    const el = $(k);
    s[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value.trim();
  }
  if (!s.model) s.model = DEFAULTS.model;
  if (!s.apiBase) s.apiBase = DEFAULTS.apiBase;
  await chrome.storage.local.set(s);
  $("settings").hidden = true;
  $("prompt").focus();
};

// ---------- run ----------
$("promptForm").onsubmit = async (e) => {
  e.preventDefault();
  const goal = $("prompt").value.trim();
  if (!goal) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await send({ type: "jev:start", goal, tabId: tab.id });
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
$("approveBtn").onclick = () => send({ type: "jev:confirm", approve: true });
$("denyBtn").onclick = () => send({ type: "jev:confirm", approve: false });

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "jev:update") render(msg.run);
});

const LABELS = { running: "Working…", confirm: "Needs your OK", done: "Done", stopped: "Stopped", error: "Error" };

function render(run) {
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
  if (ans) {
    $("answerText").textContent = ans.text;
    $("answerNote").textContent = ans.note || "";
    $("answerItems").replaceChildren(...(ans.items || []).map((it) => {
      const li = document.createElement("li");
      li.textContent = it.text;
      return li;
    }));
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
  $("prompt").focus();
})();
