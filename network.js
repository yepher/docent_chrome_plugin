// Developer tools: answer questions from the page's network requests, and run JavaScript in it.
// With DevTools open on the tab, devtools.js (the extension's DevTools page) reads the Network
// panel, response bodies included, and runs code like the Console. Without it, Docent falls back
// to the page's own Resource Timing list (no headers or bodies) and to eval in the page, which a
// strict Content Security Policy can block.
import { serializeValue } from "./serialize.js";

// "What does the network tab show…", "which API call returns the emails?", "find the request to /users".
export const NETWORK = /\b(network (tab|panel|requests?|calls?|traffic|activity|log)|xhr|har|api (calls?|requests?|responses?|endpoints?)|(http|ajax|fetch|graphql) (requests?|calls?|queries)|requests? (to|from|made|sent|that|which|returning|loading)|request (headers?|body|payload|url)|response (headers?|body|bodies|payload|json|data)|status codes?|endpoints?|graphql|curl|(json|xhr|api|http) (responses?|data|payloads?)|responses? (that|which) (returned|return|contain|came back)|(returned|returns|returning) json|which (responses?|requests?)|responses?\b.*\bjson|json\b.*\bresponses?)\b/i;
// "What API is used for the data in this table?", "where does this list come from?"
export const DATA_SOURCE = /\b(what|which) (api|endpoint|request|call|service|url)s?\b.*\b(data|table|list|grid|rows?|results?|directory|shown)\b|\bsource (api|request|call|endpoint|of (the|this|these) (data|table|list|rows?|results?))\b|\bwhere (does|do|is|are) (the|this|these) (data|table|list|rows?|results?|values?|names?|people)\b.*\b(come from|loaded|fetched|from)\b|\b(api|request|call|endpoint|response)s? (for|behind|that (loads|feeds|populates|returns|fills)) (the|this|these)\b/i;
// "Copy the authorization token to the clipboard", "put the session_id cookie on the clipboard".
const SECRET_WORDS = "cookies?|authori[sz]ation|auth|bearer|tokens?|jwt|session|headers?|csrf|xsrf|api[- ]?key";
export const COPY_SECRET = new RegExp(`\\bcopy\\b.*\\b(${SECRET_WORDS})\\b|\\b(${SECRET_WORDS})\\b.*\\bclipboard\\b|\\bclipboard\\b.*\\b(${SECRET_WORDS})\\b`, "i");
export const ALL_COOKIES = /\b(all (the |my )?cookies|cookies\b(?! named| called)|cookie (header|string|jar))/i;
export const RAW_VALUE = /\b(just|only|raw|plain) (the )?(value|token|cookie)\b|\bwithout (the )?(export|variable|name)\b/i;
const AUTHISH = /\b(authori[sz]ation|auth|bearer|token|jwt|access)\b/i;

// The header asked for: "the x-csrf-token header", else Authorization.
export function headerIn(goal) {
  const m = goal.match(/\b([a-z][\w-]*) header\b/i) || goal.match(/\bheader (?:named |called )?([a-z][\w-]*)/i);
  return m && !/^(the|a|an|request|response|auth|bearer|this|that|cookie)$/i.test(m[1]) ? m[1] : "authorization";
}

// The shell variable name asked for ("into $API_TOKEN", "variable named JWT"), if any.
export function variableIn(goal) {
  const m = goal.match(/\$([A-Za-z_]\w*)/) || goal.match(/\b(?:variable|var)\s+(?:named |called )?([A-Za-z_]\w*)/i);
  return m && !/^(so|and|for|to|that|which|in|on|i|it|named|called|then)$/i.test(m[1]) ? m[1] : "";
}

export const shellName = (name) => {
  const v = String(name).toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return /^[0-9]/.test(v) || !v ? `_${v}` : v;
};

// The cookie whose name is in the request; the longest name wins ("session_id" over "session").
export function cookieIn(goal, cookies) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cookies
    .filter((c) => c.name.length >= 2 && new RegExp(`(^|[^\\w.-])${esc(c.name)}($|[^\\w.-])`, "i").test(goal))
    .sort((a, b) => b.name.length - a.name.length)[0] || null;
}

// The likeliest login cookie when none is named: names with auth/token/jwt first, then session ids.
export function loginCookie(cookies) {
  const score = (c) => (/auth|token|jwt|access/i.test(c.name) ? 3 : /sess|sid\b|^sid|connect\.sid/i.test(c.name) ? 2 : 0) + (/^eyJ/.test(c.value) ? 1 : 0) + (c.httpOnly ? 0.5 : 0);
  return cookies.filter((c) => score(c) >= 2).sort((a, b) => score(b) - score(a))[0] || null;
}

export const exportLine = (name, value) => `export ${name}=${shq(value)}`;

// "Run document.title", "execute this javascript: …", "use javascript to count the rows".
export const RUN_JS = /^(please )?(run|execute|eval(uate)?)\b.*\b(javascript|js|code|script|snippet|console)\b|\b(use|using|with|write( me)?|in) (some )?(javascript|js)\b|\bin the console\b|^(js|javascript|console)\s*[:>]|^```/i;

// Code written in the prompt: a ``` block, `inline code`, or everything after "javascript:".
export function codeIn(goal) {
  const fence = goal.match(/```(?:js|javascript)?\s*\n?([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const tick = goal.match(/`([^`]+)`/);
  if (tick) return tick[1].trim();
  const after = goal.match(/^(?:please )?(?:run|execute|eval(?:uate)?)?\s*(?:this |the following |some )?(?:javascript|js|code|console)?\s*[:>]\s*([\s\S]+)$/i);
  if (after && /[().=;[\]]/.test(after[1])) return after[1].trim();
  // "run document.querySelectorAll('tr').length in the console": code, not a description of it.
  const bare = goal.match(/^(?:please )?(?:run|execute|eval(?:uate)?)\s+([\s\S]+?)(?:\s+(?:in the console|on (?:this|the) page|here))?\s*$/i);
  const prose = /\b(the|to|of|all|every|how|many|what|which|and|that|this|some|javascript|js|code)\b/i;
  if (bare && /[().=[\]{};]/.test(bare[1]) && !prose.test(bare[1].replace(/(["'`])(?:(?!\1).)*\1/g, ""))) return bare[1].trim();
  return "";
}

// Injected: the values shown in the page's main table or list, by column, to look for in the
// responses. A <table> or ARIA grid if there is one, else the largest group of same-shaped rows.
export function tableValues(maxRows, maxValues) {
  const squash = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rowsOf = (t) => [...t.querySelectorAll("tr, [role=row]")].filter((r) => !r.closest("thead") && r.querySelector("td, [role=cell], [role=gridcell]") && shown(r));
  const grids = [...document.querySelectorAll("table, [role=grid], [role=table], [role=treegrid]")].filter(shown)
    .map((t) => ({ t, rows: rowsOf(t) })).filter((g) => g.rows.length >= 2).sort((a, b) => b.rows.length - a.rows.length);
  let rows, headers = [];
  if (grids.length) {
    const t = grids[0].t;
    rows = grids[0].rows;
    headers = [...t.querySelectorAll("th, [role=columnheader]")].map((h) => squash(h.innerText));
  } else {
    // Repeated siblings: the parent whose same-tag children hold the most text.
    let best = null, bestScore = 0;
    for (const p of document.body.querySelectorAll("*")) {
      if (p.children.length < 3 || p.matches("nav, header, footer, select, ul[role=menu]")) continue;
      const kids = [...p.children].filter((c) => c.tagName === p.children[0].tagName && shown(c));
      if (kids.length < 3) continue;
      const score = kids.length * Math.min(200, squash(p.innerText).length / kids.length);
      if (score > bestScore) { bestScore = score; best = kids; }
    }
    rows = best || [];
  }
  const cellsOf = (row) => {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.matches("script, style, svg, button, img")) continue;
        const own = squash([...c.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
        if (own) out.push(own);
        walk(c);
      }
    };
    const direct = squash([...row.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
    if (direct) out.push(direct);
    walk(row);
    return out;
  };
  const values = [];
  for (const [r, row] of rows.slice(0, maxRows).entries()) {
    const cells = row.matches("tr, [role=row]") ? [...row.children].map((c) => squash(c.innerText)) : cellsOf(row);
    cells.forEach((text, column) => {
      if (text.length >= 2 && text.length <= 200 && !/^[\d\s.,:%-]{0,3}$/.test(text)) values.push({ text, column, row: r });
    });
    if (values.length >= maxValues) break;
  }
  return { values, headers, rows: rows.length };
}

const SKIP_HEADERS = /^(sec-|:|accept-encoding$|content-length$|connection$|host$|priority$|upgrade-insecure-requests$|cache-control$|pragma$)/i;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A curl command for a request. Secret headers become $TOKEN / $COOKIE placeholders.
export function curlFor(d) {
  const lines = [`curl ${shq(d.url)}`];
  if (d.method && d.method !== "GET") lines.push(`-X ${d.method}`);
  for (const h of d.requestHeaders || []) {
    if (SKIP_HEADERS.test(h.name)) continue;
    // Placeholders in double quotes so the shell fills them in from variables; real values in single quotes.
    const placeholder = /^cookie$/i.test(h.name) ? "$COOKIE" : /^authorization$/i.test(h.name) ? String(h.value).replace(/^(\w+)\s.*$/, "$1 $TOKEN")
      : SECRET.test(h.name) ? "$" + h.name.toUpperCase().replace(/\W/g, "_") : null;
    lines.push(placeholder ? `-H "${h.name}: ${placeholder.replace(/["\\`]/g, "\\$&")}"` : `-H ${shq(`${h.name}: ${h.value}`)}`);
  }
  if (d.postData) lines.push(`--data-raw ${shq(d.postData)}`);
  return lines.join(" \\\n  ");
}

export async function devtoolsCall(tabId, op, args = {}, timeoutMs = 60000) {
  const reply = await Promise.race([
    chrome.runtime.sendMessage({ type: "devtools:call", tabId, op, ...args }),
    new Promise((_, no) => setTimeout(() => no(new Error("DevTools didn't answer.")), timeoutMs)),
  ]);
  if (!reply) throw new Error("DevTools didn't answer.");
  if (reply.error && op !== "eval") throw new Error(reply.error);
  return reply;
}

// DevTools is open on this tab (and was opened after Docent was loaded, so devtools.js is running).
export const devtoolsOpen = (tabId) => devtoolsCall(tabId, "ping", {}, 1500).then((r) => !!r?.ok, () => false);

// Injected: the requests the page itself knows about (Resource Timing). No headers or bodies.
export function pageResources() {
  const nav = performance.getEntriesByType("navigation");
  const res = performance.getEntriesByType("resource");
  return [...nav, ...res].map((e, i) => ({
    id: `n${i}`,
    method: "",
    url: e.name,
    status: e.responseStatus || 0,
    type: e.entryType === "navigation" ? "document" : e.initiatorType === "xmlhttprequest" ? "xhr" : e.initiatorType,
    mime: e.contentType || "",
    size: e.transferSize,
    time: Math.round(e.duration),
  }));
}

// Injected into the page's own world when DevTools isn't open. eval is blocked on pages whose
// CSP doesn't allow 'unsafe-eval'; then the caller says to open DevTools.
export async function evalInMainWorld(code, serSrc) {
  let ser, pending;
  try {
    ser = (0, eval)(`(${serSrc})`);
  } catch (e) {
    return { error: String(e), csp: e instanceof EvalError };
  }
  try {
    pending = (0, eval)(`(async () => (\n${code}\n))()`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) return { error: String(e) };
    try {
      pending = /\bawait\b/.test(code) ? (0, eval)(`(async () => {\n${code}\n})()`) : (0, eval)(code);
    } catch (e2) {
      return { error: String(e2 && e2.stack || e2) };
    }
  }
  try {
    return { result: ser(await pending) };
  } catch (e) {
    return { error: String(e && e.stack || e) };
  }
}

export async function runCode(tabId, code, inject) {
  code = code.trim().replace(/;+$/, "");
  if (await devtoolsOpen(tabId)) return { ...(await devtoolsCall(tabId, "eval", { code }, 30000)), via: "devtools" };
  const res = await inject(tabId, evalInMainWorld, [code, serializeValue.toString()], "MAIN");
  return { ...(res || { error: "Nothing came back from the page." }), via: "page" };
}

const STOP = new Set("all and any are can for get got how its not one out see the use run was who why you able give list about after again also because been before being both could does doing done each find from have here into just like look made make many more most much network only other over page panel request requests response responses same show should some such tell than that their them then there these they this those through under very want what when where which while with would your tools developer devtools call calls data return returns returned contain contains value values open tab".split(" "));

// Words from the request worth looking for in response bodies ("emails" → "email").
export function searchTerms(goal) {
  const words = (goal.toLowerCase().match(/[a-z0-9_@.\-]{3,}/g) || []).map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ""));
  const out = new Set();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length <= 4 || !w.endsWith("s") || w.endsWith("ss") ? w
      : w.endsWith("ies") ? w.slice(0, -3) + "y" : /(ss|x|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.slice(0, -1));
  }
  return [...out].slice(0, 8);
}

const kb = (n) => (n == null || n < 0 ? "?" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} kB`);
const STATIC = /^(image|font|stylesheet|media|css|img|ping|beacon)$/;

// One line per request for the model, API calls first in importance. Long lists drop static files.
export function requestLines(entries, hits = {}, { includeStatic = false, max = 300 } = {}) {
  let list = entries;
  if (!includeStatic && list.length > max) list = list.filter((e) => !STATIC.test(e.type) || hits[e.id]);
  if (list.length > max) list = list.slice(-max);
  return list.map((e) => {
    const h = hits[e.id];
    const found = h ? `  matches: ${Object.entries(h.counts).map(([w, n]) => `${w}×${n}`).join(", ")}` : "";
    const url = e.url.length > 220 ? e.url.slice(0, 220) + "…" : e.url;
    return `${e.id} ${e.method || "?"} ${e.status || (e.error ? "failed" : "?")} ${e.type || "?"} ${e.mime || "?"} ${kb(e.size)} ${e.time}ms ${url}${e.error ? `  error: ${e.error}` : ""}${found}`;
  });
}

// Secrets in headers stay out of what's sent to the text model.
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const headerLines = (hs) => hs.map((h) => `  ${h.name}: ${SECRET.test(h.name) ? `[hidden, ${String(h.value || "").length} chars]` : String(h.value).slice(0, 300)}`).join("\n");

// A JSON body without its whitespace, so more of it fits.
function compact(body, mime) {
  if (!body) return body;
  if (/json/.test(mime) || /^\s*[[{]/.test(body)) { try { return JSON.stringify(JSON.parse(body)); } catch (_) { /* not complete JSON */ } }
  return body;
}

export function detailText(details, perBody) {
  return details.map((d) => {
    const body = d.binary ? "[binary]" : d.body == null ? "[no body recorded]" : compact(d.body, d.mime);
    const shown = body && body.length > perBody ? `${body.slice(0, perBody)}\n… (${(d.bodyLength || body.length).toLocaleString()} chars in all, cut off)` : body;
    return `### ${d.id} ${d.method} ${d.url}\nStatus: ${d.status} ${d.statusText || ""}  Type: ${d.type}  ${d.mime}\nRequest headers:\n${headerLines(d.requestHeaders)}${d.postData ? `\nRequest body:\n${d.postData.slice(0, 4000)}` : ""}\nResponse headers:\n${headerLines(d.responseHeaders)}\nResponse body:\n${shown}`;
  }).join("\n\n");
}

export const PICK_PROMPT = `You help a developer find information in the network requests a web page made, as recorded in Chrome DevTools' Network panel.
You get the request list (id, method, status, type, MIME type, size, time, URL, and for some, how often words from the question appear in the response) and a question.
Reply with JSON only: {"ids":["n12","n40"]}, the requests (at most 6) whose headers or bodies you need to see to answer. Prefer API calls (xhr, fetch, JSON) and requests whose responses contain the words asked about. Reply {"ids":[]} if the list alone answers the question (e.g. which requests failed, or which were slowest).`;

export const ANSWER_PROMPT = `You answer a developer's question about the network requests a web page made, as recorded in Chrome DevTools. Use only the request list and the request details provided.
Name the request(s) you used by id and URL path, e.g. "n12 GET /api/v2/directory". Quote values exactly. When asked for data from a response, give it as a compact list or a '|' table. If the details were cut off, say so. Plain text, no markdown headings or bold. Some header values are hidden for privacy; say so if the answer needs one.
When asked for a curl command, build it from the chosen request's method, URL, request headers and body, one -H per header that matters (skip browser noise like sec-ch-ua, sec-fetch-*, accept-encoding, priority). For a hidden value, put a placeholder such as -H 'Authorization: Bearer $TOKEN' or -H 'Cookie: $COOKIE', and say to copy the real value from DevTools (right-click the request → Copy → Copy as cURL has it all). Put the command on its own lines, with no markdown fences.`;

export const CODE_PROMPT = `You write JavaScript that a browser extension runs in the page the user has open, like typing it into the DevTools Console.
Reply with the code only, no explanation and no markdown fences. It's evaluated as an expression or statements; the value of the last expression is shown to the user, and top-level await works. Return plain data (strings, numbers, arrays, objects), not DOM nodes. Read the page; only change it if the user asked for that. Never send data anywhere, and don't navigate away.`;

export function parseIds(text) {
  try {
    const ids = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]).ids;
    if (Array.isArray(ids)) return ids.map(String).filter((x) => /^n\d+$/.test(x)).slice(0, 6);
  } catch (_) { /* not JSON: pick out the ids */ }
  return [...new Set(text.match(/\bn\d+\b/g) || [])].slice(0, 6);
}
