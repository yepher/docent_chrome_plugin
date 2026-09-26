// Find / hide / dim by meaning, and saved per-site rules that re-apply as pages
// load and scroll. Items come from items.js; each gets one Jev Noul ("does this
// item match the request?"), answered in batches, cached by item text.

import { systemOne, noul } from "./jev.js";
import { segmentItems, markItems, clearMarks, watchMutations } from "./items.js";

const BATCH = 120;
const MAX_ITEMS = 400;
const caches = new Map(); // request text -> Map(item text -> probability)

export function modeFor(kind, prompt) {
  if (kind === "find") return "highlight";
  if (/\b(dim|fade|gr[ae]y(\s+out)?|de-?emphasi[sz]e|mute|tone down)\b/i.test(prompt)) return "dim";
  return "hide";
}

async function inject(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

// Probability that each item matches the request, aligned with `items`.
export async function judgeItems(s, request, items, page, signal) {
  if (!caches.has(request)) caches.set(request, new Map());
  const cache = caches.get(request);
  const todo = [...new Set(items.map((x) => x.text).filter((t) => !cache.has(t)))];
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  await Promise.all(batches.map(async (batch) => {
    const questions = {};
    batch.forEach((_, i) => {
      questions[`m${i}`] = noul(`Does \`items[${i}]\` match what \`request\` describes?`, {
        true: "The item is one of the things the request asks to find, hide or dim",
        false: "The item is something else",
      });
    });
    const res = await systemOne({
      apiBase: s.apiBase, apiKey: s.apiKey, model: s.model, signal,
      state: { request, page: { url: page.url, title: page.title }, items: batch },
      questions,
    });
    batch.forEach((t, i) => cache.set(t, res.answers[`m${i}`]?.noul ?? 0));
  }));
  if (cache.size > 5000) caches.delete(request); // keep memory bounded
  return items.map((x) => cache.get(x.text) ?? 0);
}

// One-off find/hide/dim for a prompt. Returns matches and borderline items.
export async function runFilter(s, tabId, request, mode, signal) {
  const seg = await inject(tabId, segmentItems, [false, MAX_ITEMS]);
  if (!seg?.items?.length) return { total: 0, matches: [], borderline: [], host: seg?.host };
  const ps = await judgeItems(s, request, seg.items, seg, signal);
  const matches = [], borderline = [];
  seg.items.forEach((it, i) => {
    if (ps[i] >= 0.5) matches.push({ ...it, p: ps[i] });
    else if (ps[i] >= 0.3) borderline.push(it);
  });
  if (mode === "highlight") await inject(tabId, clearMarks, ["highlight"]);
  await inject(tabId, markItems, [matches.map((m) => ({ k: m.k, mode })), false]);
  return { total: seg.items.length, matches, borderline, host: seg.host };
}

// ---------- saved rules ----------
export async function getRules() {
  return (await chrome.storage.local.get("rules")).rules || [];
}
async function setRules(rules) {
  await chrome.storage.local.set({ rules });
}
export async function saveRule({ host, prompt, mode }) {
  const rules = await getRules();
  if (!rules.some((r) => r.host === host && r.prompt === prompt && r.mode === mode)) {
    rules.push({ id: crypto.randomUUID(), host, prompt, mode, enabled: true, created: Date.now() });
    await setRules(rules);
  }
  return rules;
}
export async function updateRule(id, patch) {
  const rules = (await getRules()).map((r) => (r.id === id ? { ...r, ...patch } : r));
  await setRules(rules);
  return rules;
}
export async function deleteRule(id) {
  const rules = (await getRules()).filter((r) => r.id !== id);
  await setRules(rules);
  return rules;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };
const queues = new Map(); // tabId -> promise, so runs on one tab don't overlap
const counts = new Map(); // tabId -> items hidden/dimmed by rules

// Apply the enabled rules for the tab's site. onlyNew: just items added since last time.
export function applyRules(s, tabId, onlyNew) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => applyRulesNow(s, tabId, onlyNew));
  queues.set(tabId, next);
  return next;
}

async function applyRulesNow(s, tabId, onlyNew) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !/^https?:/.test(tab.url || "")) return 0;
  const host = hostOf(tab.url);
  const rules = (await getRules()).filter((r) => r.enabled && r.host === host);
  if (!rules.length || !s.apiKey) {
    if (!onlyNew) setCount(tabId, 0);
    return 0;
  }
  const seg = await inject(tabId, segmentItems, [onlyNew, MAX_ITEMS]).catch(() => null);
  await inject(tabId, watchMutations).catch(() => {});
  if (!seg?.items?.length) return counts.get(tabId) || 0;

  const marks = [];
  for (const rule of rules) {
    const ps = await judgeItems(s, rule.prompt, seg.items, seg).catch(() => null);
    if (!ps) continue;
    seg.items.forEach((it, i) => { if (ps[i] >= 0.5) marks.push({ k: it.k, mode: rule.mode }); });
  }
  await inject(tabId, markItems, [marks, false]).catch(() => {});
  const affected = new Set(marks.filter((m) => m.mode !== "highlight").map((m) => m.k)).size;
  setCount(tabId, (onlyNew ? counts.get(tabId) || 0 : 0) + affected);
  return affected;
}

function setCount(tabId, n) {
  counts.set(tabId, n);
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#64748b" }).catch(() => {});
}

// After a rule changes: clear the tab's marks and re-apply what's still enabled (cached, so quick).
export async function reapplyRules(s, tabId) {
  await inject(tabId, clearMarks, []).catch(() => {});
  return applyRules(s, tabId, false);
}

export function forgetTab(tabId) {
  queues.delete(tabId);
  counts.delete(tabId);
}
