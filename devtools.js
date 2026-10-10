// DevTools page: loaded by Chrome whenever DevTools opens on a tab (manifest "devtools_page").
// It has no panel of its own. It answers the service worker's requests for that tab: what the
// Network panel has recorded (with headers and response bodies), and running code in the page
// the way the Console does (not blocked by the page's Content Security Policy).
import { serializeValue } from "./serialize.js";

const tabId = chrome.devtools.inspectedWindow.tabId;
const SER = serializeValue.toString();
let entries = []; // the last HAR snapshot; ids are n<index> into it

const har = () => new Promise((resolve) => chrome.devtools.network.getHAR((log) => resolve(log?.entries || [])));
const content = (e) => new Promise((resolve) => {
  if (typeof e?.getContent !== "function") return resolve({ body: null });
  e.getContent((body, encoding) => resolve({ body, encoding }));
});
const evaluate = (expr) => new Promise((resolve) => {
  chrome.devtools.inspectedWindow.eval(expr, (value, exc) => resolve({ value, exc }));
});

const mimeOf = (e) => (e.response?.content?.mimeType || "").split(";")[0].trim().toLowerCase();
const TEXTUAL = /json|text|javascript|xml|html|graphql|x-www-form-urlencoded/;

function summary(e, i) {
  return {
    id: `n${i}`,
    method: e.request?.method || "",
    url: e.request?.url || "",
    status: e.response?.status ?? 0,
    statusText: e.response?.statusText || "",
    type: e._resourceType || "",
    mime: mimeOf(e),
    size: e.response?._transferSize ?? e.response?.bodySize ?? -1,
    bodySize: e.response?.content?.size ?? -1,
    time: Math.round(e.time || 0),
    started: e.startedDateTime || "",
    error: e.response?._error || "",
  };
}

async function bodyText(e, max) {
  const { body, encoding } = await content(e);
  if (body == null) return { text: null };
  let text = body;
  if (encoding === "base64") {
    if (!TEXTUAL.test(mimeOf(e))) return { text: null, binary: true, bytes: Math.floor(body.length * 0.75) };
    try { text = new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))); } catch (_) { return { text: null, binary: true }; }
  }
  return { text: text.length > max ? text.slice(0, max) : text, length: text.length };
}

async function details(ids, max) {
  const out = [];
  for (const id of ids) {
    const e = entries[Number(String(id).replace(/^n/, ""))];
    if (!e) continue;
    const body = await bodyText(e, max);
    out.push({
      ...summary(e, entries.indexOf(e)),
      requestHeaders: e.request?.headers || [],
      query: e.request?.queryString || [],
      postData: e.request?.postData?.text?.slice(0, max) || "",
      responseHeaders: e.response?.headers || [],
      body: body.text,
      bodyLength: body.length,
      binary: !!body.binary,
    });
  }
  return out;
}

// Which responses mention these words: counts and the first match, so the model can pick
// requests by what they returned, not just by their URL.
async function search(terms, limit) {
  const words = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (!words.length) return {};
  const hits = {};
  const pick = entries
    .map((e, i) => [e, i])
    .filter(([e]) => TEXTUAL.test(mimeOf(e)) && !/^(stylesheet|font|image|media)$/.test(e._resourceType || ""))
    .slice(-limit);
  for (const [e, i] of pick) {
    const { text } = await bodyText(e, 2_000_000);
    const hay = `${e.request?.url || ""}\n${text || ""}`.toLowerCase();
    const counts = {};
    let first = -1;
    for (const w of words) {
      let n = 0, at = hay.indexOf(w);
      if (at >= 0 && (first < 0 || at < first)) first = at;
      while (at >= 0 && n < 9999) { n++; at = hay.indexOf(w, at + w.length); }
      if (n) counts[w] = n;
    }
    if (Object.keys(counts).length) hits[`n${i}`] = { counts, snippet: hay.slice(Math.max(0, first - 60), first + 100).replace(/\s+/g, " ") };
  }
  return hits;
}

// Which response the values shown on the page (e.g. a table's cells) came from: each text
// response is scored by how many of the values it contains, and for JSON, the field each value
// sits in ("members[].email") and the list the rows come from.
async function provenance(values, limit) {
  const vals = [...new Set(values.map((v) => String(v).trim()).filter((v) => v.length >= 2))];
  if (!vals.length) return { results: [] };
  const escaped = vals.map((v) => JSON.stringify(v).slice(1, -1));
  const results = [];
  const pick = entries
    .map((e, i) => [e, i])
    .filter(([e]) => TEXTUAL.test(mimeOf(e)) && !/^(stylesheet|font|image|media|script)$/.test(e._resourceType || ""))
    .slice(-limit);
  for (const [e, i] of pick) {
    const { text } = await bodyText(e, 20_000_000);
    if (!text) continue;
    const found = vals.filter((v, k) => text.includes(v) || text.includes(escaped[k]));
    if (found.length) results.push({ e, i, text, found });
  }
  results.sort((a, b) => b.found.length - a.found.length || (b.e._resourceType === "fetch" || b.e._resourceType === "xhr") - (a.e._resourceType === "fetch" || a.e._resourceType === "xhr"));
  return {
    total: vals.length,
    results: results.slice(0, 5).map(({ e, i, text, found }, rank) => ({
      ...summary(e, i),
      matched: found.length,
      found: found.slice(0, 200),
      ...(rank < 3 ? jsonFields(text, new Set(found)) : {}),
    })),
  };
}

// Where in a JSON body the values are: path per value, and the array most of them are in.
function jsonFields(text, wanted) {
  let data;
  try { data = JSON.parse(text); } catch (_) { return {}; }
  const fields = {}; // value -> path with array indices as []
  const lists = {}; // array path -> { count, length }
  const lower = new Map([...wanted].map((v) => [v.toLowerCase(), v]));
  let seen = 0;
  const walk = (x, path, arrays) => {
    if (++seen > 2_000_000) return;
    if (x && typeof x === "object") {
      if (Array.isArray(x)) x.forEach((y) => walk(y, `${path}[]`, [...arrays, [`${path}[]`, x.length]]));
      else for (const k of Object.keys(x)) walk(x[k], path ? `${path}.${k}` : k, arrays);
      return;
    }
    if (x == null) return;
    const s = String(x).trim();
    const v = wanted.has(s) ? s : lower.get(s.toLowerCase());
    if (!v) return;
    if (!fields[v]) fields[v] = path;
    const inner = arrays[arrays.length - 1];
    if (inner) {
      const l = (lists[inner[0]] ||= { count: 0, length: 0 });
      l.count++;
      l.length = Math.max(l.length, inner[1]);
    }
  };
  walk(data, "", []);
  const best = Object.entries(lists).sort((a, b) => b[1].count - a[1].count)[0];
  return { fields, list: best ? { path: best[0], length: best[1].length } : null };
}

// The newest recorded value of a request header (e.g. Authorization), preferring requests to
// the inspected page's own site over third parties such as analytics.
async function header(name, pageUrl) {
  entries = await har();
  const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch (_) { return ""; } };
  const mine = site(pageUrl);
  let other = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const h = (e.request?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!h?.value) continue;
    if (site(e.request.url) === mine) return { value: h.value, url: e.request.url };
    other ||= { value: h.value, url: e.request.url };
  }
  return other || {};
}

// Run code in the page, as typed in the Console. An expression's value is returned (awaited if
// it's a promise, and `await` works); for statements, the value of the last one, or what an
// `await` block returns.
async function run(code) {
  code = code.trim().replace(/;+$/, "");
  const id = Math.random().toString(36).slice(2);
  const slot = `window.__docentEval && window.__docentEval[${JSON.stringify(id)}]`;
  const start = (body) => `(() => { window.__docentEval = window.__docentEval || {}; const done = (r) => { window.__docentEval[${JSON.stringify(id)}] = r; };
    (async () => ${body})().then((v) => done({ ok: (${SER})(v) }), (e) => done({ error: String(e && e.stack || e) }));
    return "started"; })()`;
  const tryAsync = async (body) => {
    const { exc } = await evaluate(start(body));
    if (exc) return { exc }; // a syntax error: nothing ran
    for (let waited = 0; waited < 20000; waited += 100) {
      const { value } = await evaluate(slot);
      if (value) {
        await evaluate(`delete window.__docentEval[${JSON.stringify(id)}]`);
        return value.error ? { error: value.error } : { result: value.ok };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { error: "Still running after 20 seconds; stopped waiting for it." };
  };
  const syntax = (exc) => exc?.isException && /SyntaxError/.test(exc.value || "");
  const first = await tryAsync(`(\n${code}\n)`);
  if (!first.exc) return first;
  if (!syntax(first.exc)) return { error: first.exc.value || first.exc.description || "DevTools couldn't run that." };
  if (/\bawait\b/.test(code)) {
    const block = await tryAsync(`{\n${code}\n}`);
    if (!block.exc) return { ...block, note: block.result === "undefined" ? "Code with await returns only what it returns: add `return …` to see a value." : undefined };
    return { error: block.exc.value || block.exc.description };
  }
  const { value, exc } = await evaluate(code);
  if (exc?.isException) return { error: exc.value };
  if (exc) return { error: `The result can't be shown (${exc.description || exc.code}). End with an expression that gives plain data, e.g. text or numbers.` };
  return { result: value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "devtools:call" || msg.tabId !== tabId) return;
  (async () => {
    switch (msg.op) {
      case "ping": return { ok: true };
      case "entries":
        entries = await har();
        return { entries: entries.map(summary) };
      case "details": return { details: await details(msg.ids || [], msg.max || 8000) };
      case "search": return { hits: await search(msg.terms || [], msg.limit || 150) };
      case "header": return await header(msg.name || "authorization", msg.pageUrl || "");
      case "provenance": return await provenance(msg.values || [], msg.limit || 300);
      case "eval": return await run(msg.code);
    }
    return { error: `Unknown DevTools request: ${msg.op}` };
  })().then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
