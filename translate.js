// Translation: "translate this page into Spanish" rewrites the page's text in place, and
// "read this page aloud in French" translates each part just before it is spoken. The
// text model does the translating, a batch of numbered lines at a time.

import { chat } from "./lk.js";

// Languages recognised by name in a request, with the code passed to the voice.
const LANGS = [
  ["English", "en"], ["Spanish", "es"], ["French", "fr"], ["German", "de"], ["Italian", "it"], ["Portuguese", "pt"],
  ["Dutch", "nl"], ["Swedish", "sv"], ["Norwegian", "no"], ["Danish", "da"], ["Finnish", "fi"], ["Polish", "pl"],
  ["Czech", "cs"], ["Slovak", "sk"], ["Hungarian", "hu"], ["Romanian", "ro"], ["Bulgarian", "bg"], ["Greek", "el"],
  ["Turkish", "tr"], ["Russian", "ru"], ["Ukrainian", "uk"], ["Croatian", "hr"], ["Serbian", "sr"], ["Hebrew", "he"],
  ["Arabic", "ar"], ["Persian", "fa"], ["Farsi", "fa"], ["Hindi", "hi"], ["Bengali", "bn"], ["Urdu", "ur"],
  ["Tamil", "ta"], ["Telugu", "te"], ["Chinese", "zh"], ["Mandarin", "zh"], ["Cantonese", "yue"], ["Japanese", "ja"],
  ["Korean", "ko"], ["Vietnamese", "vi"], ["Thai", "th"], ["Indonesian", "id"], ["Malay", "ms"], ["Tagalog", "tl"],
  ["Filipino", "tl"], ["Swahili", "sw"], ["Catalan", "ca"], ["Welsh", "cy"], ["Irish", "ga"], ["Latin", "la"],
];
const NAMED = new RegExp(`\\b(?:in|into|to)\\s+(?:\\w+\\s+)?(${LANGS.map(([n]) => n).join("|")})\\b`, "i");

// The language a request asks for ("…in Spanish", "…into Brazilian Portuguese"), or null.
// anyName: also accept a capitalised name that isn't in the list ("to Klingon").
export function languageIn(goal, anyName = false) {
  const m = NAMED.exec(goal || "");
  if (m) {
    const [name, code] = LANGS.find(([n]) => n.toLowerCase() === m[1].toLowerCase());
    return { name, code };
  }
  const other = anyName && /\b(?:into|to)\s+([A-Z][a-z]{3,})\b/.exec(goal || "");
  return other ? { name: other[1], code: "" } : null;
}

// The browser's own language, for "translate this page" with no language named.
export function uiLanguage() {
  const code = (chrome.i18n.getUILanguage() || "en").split("-")[0];
  const hit = LANGS.find(([, c]) => c === code);
  return hit ? { name: hit[0], code } : { name: "English", code: "en" };
}

const BATCH_CHARS = 2500, BATCH_LINES = 60, PARALLEL = 4;

// Translate lines of text into `lang` (a language name). Returns the lines translated, in
// the same order; a line the model skipped keeps its original text. onBatch(pairs) is
// called with [[index, translation], …] as each batch comes back.
export async function translateLines(llm, lines, lang, { signal, onBatch } = {}) {
  const batches = [];
  let cur = [], chars = 0;
  lines.forEach((t, i) => {
    if (cur.length && (chars + t.length > BATCH_CHARS || cur.length >= BATCH_LINES)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(i);
    chars += t.length;
  });
  if (cur.length) batches.push(cur);
  const out = lines.slice();
  let next = 0, got = 0, firstError = null;
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const idxs = batches[next++];
      const size = idxs.reduce((n, i) => n + lines[i].length, 0);
      let reply = "";
      try {
        reply = await chat(llm, [
          { role: "system", content: `You translate text from a web page into ${lang}. You get numbered lines, "[n] text". Reply with the same numbered lines translated, one per line, and nothing else.
- Every line is a fragment of the same page: translate each on its own, keeping the wording consistent between them.
- Keep names, numbers, code, web addresses and symbols as they are.
- A line that is already in ${lang} is repeated unchanged.` },
          { role: "user", content: idxs.map((i, k) => `[${k + 1}] ${lines[i].replace(/\s+/g, " ")}`).join("\n") },
        ], { signal, maxTokens: size + 400 });
      } catch (e) {
        if (signal?.aborted) throw e;
        firstError ||= e;
        continue;
      }
      const pairs = [];
      for (const m of reply.matchAll(/^\s*\[(\d+)\]\s?(.*)$/gm)) {
        const i = idxs[Number(m[1]) - 1];
        const text = m[2].trim();
        if (i == null || !text) continue;
        out[i] = text;
        pairs.push([i, text]);
      }
      got += pairs.length;
      if (pairs.length) await onBatch?.(pairs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
  if (!got && firstError) throw firstError;
  return out;
}

// ---- injected into the tab: self-contained ----

// The page's visible text, one entry per text node in reading order. The nodes are kept in
// the tab (window.__docentTx) so applyTexts can put the translations back by index.
export function collectTexts(maxChars) {
  const SKIP = "script,style,noscript,template,textarea,code,pre,svg,math,[contenteditable],[translate=no],.notranslate";
  const nodes = (window.__docentTx = []);
  const texts = [];
  const shown = new Map();
  let chars = 0, more = false;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) {
    const n = w.currentNode, p = n.parentElement;
    const t = n.nodeValue.replace(/\s+/g, " ").trim();
    if (!p || !/\p{L}{2}/u.test(t) || p.closest(SKIP)) continue;
    if (!shown.has(p)) { const r = p.getBoundingClientRect(); shown.set(p, r.width > 0 || r.height > 0); }
    if (!shown.get(p)) continue;
    if (chars + t.length > maxChars) { more = true; break; }
    nodes.push(n);
    texts.push(t);
    chars += t.length;
  }
  return { texts, more, lang: document.documentElement.lang || "" };
}

// pairs: [[index, text], …]. Originals go on the same list restyle.js's undoEdits() restores.
export function applyTexts(pairs) {
  const nodes = window.__docentTx || [];
  const saved = (window.__docentEdits ||= []);
  let n = 0;
  for (const [i, text] of pairs || []) {
    const node = nodes[i];
    if (!node || !node.isConnected || !text) continue;
    const old = node.nodeValue;
    const value = old.match(/^\s*/)[0] + text + old.match(/\s*$/)[0];
    if (value === old) continue;
    saved.push({ node, old });
    node.nodeValue = value;
    n++;
  }
  return n;
}

export function pageLanguage() { return document.documentElement.lang || ""; }
