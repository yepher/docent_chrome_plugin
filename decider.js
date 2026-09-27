// Which model makes Jev-style typed decisions: Jev (TypeSafe's hosted API) or Laya, which
// runs entirely in the browser (laya-worker.js, via the offscreen document). Both take the
// same { state, questions } and return the same { answers } shape.
//
// Laya reads a shorter window (512 or 1,024 tokens of context) and scores about 10 options
// per question well, so for Laya this module:
//   - puts each item's text into per-item questions ("Does `items[3]` match…") instead of
//     relying on a long `items` list in the state that would be cut off;
//   - splits choices with many options into knockout rounds of about 10;
//   - sends questions in small batches, so Stop can interrupt between them.

import { systemOne as jevSystemOne } from "./jev.js";
import { ensureOffscreen } from "./voice.js";

export const isLaya = (s) => String(s?.decider || "jev").startsWith("laya");
export const deciderName = (s) => (isLaya(s) ? "Laya" : "Jev");
export const deciderReady = (s) => isLaya(s) || !!s?.apiKey;
export const layaOpts = (s) => ({ checkpoint: s.decider === "laya-typed" ? "laya-typed" : "laya", build: s.layaBuild || "q4e8", device: s.layaDevice || "auto", base: s.layaModelBase || "" });

async function toLaya(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  if (!res) throw new Error("Laya didn't answer (the offscreen document isn't available).");
  if (res.error) throw new Error(`Laya: ${res.error}`);
  return res;
}
export const layaLoad = async (s) => (await toLaya({ type: "laya:load", opts: layaOpts(s) })).info;
export const layaStatus = () => toLaya({ type: "laya:status" });
export const layaClear = () => toLaya({ type: "laya:clear" });

export function decide(s, { state, questions, signal }) {
  if (!isLaya(s)) return jevSystemOne({ apiBase: s.apiBase, apiKey: s.apiKey, model: s.model, state, questions, signal });
  return layaDecide(s, state, questions, signal);
}

const GROUP = 10;  // options per Laya choice question
const BATCH = 8;   // questions per model call
const KEEP = new Set(["none", "whole_page", "compose"]); // "none of these"-style options stay in every round
const aborted = (signal) => { if (signal?.aborted) throw new DOMException("Stopped", "AbortError"); };

// Laya judges one item best when the item's text is the whole state and the question is
// a plain statement about it ("The text is one of the things meant by: sponsored posts").
// In tests on a feed this got 22–23 of 24 right, against 16–18 for list-style questions.
export function topicOf(request) {
  return String(request).trim()
    .replace(/^(please\s+)?(can you\s+)?/i, "")
    .replace(/^(hide|highlight|find|show( me)?( where)?|dim|fade|remove|filter out|mark|outline|get rid of|mute|list|which( of these)?|how many( of)?|count)\s+/i, "")
    .replace(/^(all|the|any)\s+/i, "")
    .replace(/\s+(are there|do you see|on (this|the) page)\s*\??$/i, "")
    .replace(/[?.!]+$/, "")
    // "posts are about X" / "reviews mention Y" → "posts that are about X" / "reviews that mention Y"
    .replace(/^(\w+(?: \w+)?) (are|is|were|was|mention|mentions|talk about|discuss|say|contain|have|has|include)\b/i, (m, n, v) => (/\bthat$/i.test(n) ? m : `${n} that ${v}`))
    .trim() || String(request);
}
export async function layaJudge(s, texts, request, signal) {
  const q = { m: { type: "noul", instructions: `The text is one of the things meant by: ${topicOf(request)}` } };
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    aborted(signal);
    const jobs = texts.slice(i, i + BATCH).map((t) => ({ state: String(t).slice(0, 1500), questions: q }));
    const res = await toLaya({ type: "laya:runMany", opts: layaOpts(s), jobs });
    for (const a of res.results) out.push(a.m?.noul ?? 0);
  }
  return out;
}

async function runBatch(s, state, questions, signal) {
  const answers = {};
  const ids = Object.keys(questions);
  for (let i = 0; i < ids.length; i += BATCH) {
    aborted(signal);
    const part = Object.fromEntries(ids.slice(i, i + BATCH).map((k) => [k, questions[k]]));
    const res = await toLaya({ type: "laya:run", opts: layaOpts(s), state, questions: part });
    Object.assign(answers, res.answers);
  }
  return answers;
}

// `items[3]`-style references: put the item's text into the question and drop the list
// from the state (Laya would only see its first few entries).
function inlineRefs(state, questions) {
  if (!state || typeof state !== "object") return { state, questions };
  const used = new Set();
  const qs = {};
  for (const [id, q] of Object.entries(questions)) {
    const ins = String(q.instructions || "").replace(/`(\w+)\[(\d+)\]`/g, (m, name, i) => {
      const arr = state[name];
      if (!Array.isArray(arr) || arr[i] == null) return m;
      used.add(name);
      return `this item ("${String(arr[i]).replace(/\s+/g, " ").slice(0, 400)}")`;
    });
    qs[id] = { ...q, instructions: ins };
  }
  if (!used.size) return { state, questions };
  const st = Object.fromEntries(Object.entries(state).filter(([k]) => !used.has(k)));
  return { state: st, questions: qs };
}

async function tournament(s, state, q, signal) {
  const entries = Object.entries(q.criteria);
  const keep = entries.filter(([k]) => KEEP.has(k));
  const rest = entries.filter(([k]) => !KEEP.has(k));
  const size = Math.max(2, GROUP - keep.length);
  if (rest.length <= size) return (await runBatch(s, state, { q }, signal)).q;
  const groups = [];
  for (let i = 0; i < rest.length; i += size) groups.push(rest.slice(i, i + size));
  const rounds = Object.fromEntries(groups.map((g, i) => [`g${i}`, { ...q, criteria: Object.fromEntries([...g, ...keep]) }]));
  const got = await runBatch(s, state, rounds, signal);
  // Each group's best real option goes through, ranked by how strongly it won.
  const winners = groups.map((g, i) => {
    const p = got[`g${i}`]?.probabilities || {};
    const [k] = g.map(([k]) => k).sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0));
    return [k, p[k] ?? 0];
  }).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const crit = Object.fromEntries([...winners.map((k) => [k, q.criteria[k]]), ...keep]);
  return tournament(s, state, { ...q, criteria: crit }, signal);
}

async function layaDecide(s, state0, questions0, signal) {
  const { state, questions } = inlineRefs(state0, questions0);
  const simple = {}, big = [];
  for (const [id, q] of Object.entries(questions)) {
    const n = q.type === "choice" ? (Array.isArray(q.criteria) ? q.criteria.length : Object.keys(q.criteria || {}).length) : 0;
    if (n > GROUP) big.push([id, q]); else simple[id] = q;
  }
  const answers = await runBatch(s, state, simple, signal);
  for (const [id, q] of big) {
    const crit = Array.isArray(q.criteria) ? Object.fromEntries(q.criteria.map((c) => [c, null])) : q.criteria;
    answers[id] = await tournament(s, state, { ...q, criteria: crit }, signal);
  }
  return { model: "laya", answers };
}
