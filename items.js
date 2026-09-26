// Page functions for find/hide by meaning. Injected with chrome.scripting.executeScript,
// so each function must be self-contained.

// Split the page into "items": repeated blocks such as search results, posts,
// comments, products or table rows. Each item is tagged data-jev-item="<n>".
// With onlyNew, returns just the items that weren't tagged before (infinite scroll).
export function segmentItems(onlyNew, max) {
  const MIN = 15, MAXLEN = 2500;
  const squash = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  const sig = (el) =>
    el.tagName + "." + [...el.classList].filter((c) => !/\d{3,}|active|selected|hover|focus|open|expanded/i.test(c)).sort().join(".");
  const textLen = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().length;
  const shown = (el) => {
    if (el.hasAttribute("data-jev-item")) return true; // ours; may be hidden by a rule
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  const SKIP = "script,style,noscript,svg,template,select,option";

  // 1. Groups of ≥3 same-shaped siblings with real text.
  const groups = [];
  for (const parent of document.body.querySelectorAll("*")) {
    if (parent.children.length < 3 || parent.matches(SKIP)) continue;
    const bySig = new Map();
    for (const c of parent.children) {
      if (c.matches(SKIP)) continue;
      const k = sig(c);
      if (!bySig.has(k)) bySig.set(k, []);
      bySig.get(k).push(c);
    }
    for (const arr of bySig.values()) {
      if (arr.length < 3) continue;
      const ok = arr.filter((c) => { const n = textLen(c); return n >= MIN && n <= MAXLEN; });
      if (ok.length < 3) continue;
      const avg = ok.reduce((a, c) => a + textLen(c), 0) / ok.length;
      let score = ok.length * Math.min(avg, 400);
      if (parent.closest("nav,header,footer,[role=navigation],[role=banner],[role=contentinfo],aside")) score *= 0.2;
      groups.push({ score, els: ok });
    }
  }
  groups.sort((a, b) => b.score - a.score);

  // 2. Take members from the best groups, never nesting one item inside another.
  const picked = [...document.querySelectorAll("[data-jev-item]")];
  const overlaps = (el) => picked.some((p) => p === el || p.contains(el) || el.contains(p));
  const fresh = [];
  for (const g of groups.slice(0, 40)) {
    for (const el of g.els) {
      if (picked.length >= 600) break;
      if (overlaps(el) || !shown(el)) continue;
      picked.push(el);
      fresh.push(el);
    }
  }
  // 3. Fallback for pages without repeated blocks: paragraphs, list items, headings.
  if (!picked.length) {
    for (const el of document.querySelectorAll("p,li,h1,h2,h3,h4,blockquote,td,dd")) {
      const n = textLen(el);
      if (n < MIN || n > MAXLEN || overlaps(el) || !shown(el)) continue;
      picked.push(el);
      fresh.push(el);
    }
  }

  window.__jevSeq = window.__jevSeq || 0;
  for (const el of fresh) el.setAttribute("data-jev-item", String(++window.__jevSeq));
  const els = (onlyNew ? fresh : picked).slice();
  // Document order.
  els.sort((A, B) => (A.compareDocumentPosition(B) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const list = els
    .map((el) => ({ k: el.getAttribute("data-jev-item"), text: squash(el.innerText || el.textContent, 400) }))
    .filter((x) => x.text);
  return { url: location.href, host: location.host, title: document.title, items: list.slice(0, max) };
}

// Mark items: marks = [{k, mode: "hide"|"dim"|"highlight"}]. With reset, clears all marks first.
export function markItems(marks, reset) {
  if (!document.getElementById("__jev_style")) {
    const st = document.createElement("style");
    st.id = "__jev_style";
    st.textContent = `
      [data-jev-mode="hide"] { display: none !important; }
      [data-jev-mode="dim"] { opacity: .15 !important; transition: opacity .15s; }
      [data-jev-mode="dim"]:hover { opacity: 1 !important; }
      [data-jev-mode="highlight"] { outline: 3px solid #22c55e !important; outline-offset: 2px; background-color: rgba(34,197,94,.08) !important; }
      .__jev_pulse { animation: __jev_pulse 1s ease-out 2; }
      @keyframes __jev_pulse { 0% { box-shadow: 0 0 0 0 rgba(99,102,241,.7); } 100% { box-shadow: 0 0 0 14px rgba(99,102,241,0); } }`;
    (document.head || document.documentElement).append(st);
  }
  if (reset) document.querySelectorAll("[data-jev-mode]").forEach((e) => e.removeAttribute("data-jev-mode"));
  const rank = { hide: 3, dim: 2, highlight: 1 };
  let n = 0;
  for (const { k, mode } of marks) {
    const el = document.querySelector(`[data-jev-item="${k}"]`);
    if (!el) continue;
    const cur = el.getAttribute("data-jev-mode");
    if (!cur || rank[mode] > rank[cur]) el.setAttribute("data-jev-mode", mode);
    n++;
  }
  return n;
}

// Remove marks (all, or just one mode).
export function clearMarks(mode) {
  const sel = mode ? `[data-jev-mode="${mode}"]` : "[data-jev-mode]";
  const els = document.querySelectorAll(sel);
  els.forEach((e) => e.removeAttribute("data-jev-mode"));
  return els.length;
}

// Scroll to an element by attribute (data-jev-item or data-jev-id) and pulse it.
export function focusRef(attr, val) {
  const el = document.querySelector(`[${attr}="${val}"]`);
  if (!el) return false;
  if (el.getAttribute("data-jev-mode") === "hide") el.removeAttribute("data-jev-mode");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("__jev_pulse");
  void el.offsetWidth;
  el.classList.add("__jev_pulse");
  setTimeout(() => el.classList.remove("__jev_pulse"), 2200);
  return true;
}

// Tell the extension when the page adds content (infinite scroll, SPA updates).
export function watchMutations() {
  if (window.__jevObserver) return false;
  let t = null;
  window.__jevObserver = new MutationObserver((muts) => {
    if (!muts.some((m) => m.addedNodes.length)) return;
    clearTimeout(t);
    t = setTimeout(() => chrome.runtime.sendMessage({ type: "jev:mutated" }).catch(() => {}), 900);
  });
  window.__jevObserver.observe(document.body, { childList: true, subtree: true });
  return true;
}

// The current text selection, if any.
export function getSelectionText() {
  return String(window.getSelection() || "").trim().slice(0, 12000);
}
