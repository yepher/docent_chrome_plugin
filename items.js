// Page functions for find/hide by meaning. Injected with chrome.scripting.executeScript,
// so each function must be self-contained.

// Split the page into "items": repeated blocks such as search results, posts,
// comments, products or table rows. Each item is tagged data-jev-item="<n>".
// With onlyNew, returns just the items that weren't tagged before (infinite scroll).
export function segmentItems(onlyNew, max, maxLen) {
  const MIN = 15, MAXLEN = maxLen || 2500;
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
  // Where each item sits relative to what you're looking at.
  const vh = innerHeight;
  const list = els
    .map((el) => {
      const r = el.getBoundingClientRect();
      const shown = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      return {
        k: el.getAttribute("data-jev-item"),
        text: squash(el.innerText || el.textContent, 400),
        vis: r.height ? shown / Math.min(r.height, vh) : 0, // share of the item (or of the screen) visible
        pos: r.bottom <= 0 ? "above" : r.top >= vh ? "below" : "on screen",
        dist: Math.abs((r.top + r.bottom) / 2 - vh / 2),
      };
    })
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

// The post/item in the middle of the screen: what "the post I'm looking at" means.
// Tries well-known post containers first (article, [data-urn], tweets, reddit posts),
// then climbs from the element under the screen centre to the first ancestor that is
// one of several siblings with real text (a list entry). Tags it data-jev-focus.
export function focusedItem(minLen, maxLen) {
  minLen = minLen || 150; maxLen = maxLen || 40000;
  const HINT = "article,[role=article],[data-urn],[data-id^='urn:'],[data-testid*='post' i],[data-testid*='tweet' i],[data-testid='cellInnerDiv'],shreddit-post,[data-post-id],[data-item-id]";
  const len = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().length;
  const ok = (el) => { const n = len(el); return n >= minLen && n <= maxLen; };
  const pick = (el) => {
    // Outermost well-known container that still fits (a post can nest another article).
    let hinted = null;
    for (let h = el.closest(HINT); h; h = h.parentElement && h.parentElement.closest(HINT)) if (ok(h)) hinted = h;
    if (hinted) return hinted;
    for (let a = el; a && a !== document.body && a.parentElement; a = a.parentElement) {
      if (a.matches("main,[role=main],body,html")) break;
      const sibs = [...a.parentElement.children].filter((c) => c !== a && !c.matches("script,style,template,noscript,link,meta") && c.getBoundingClientRect().height > 0 && len(c) > 100);
      if (sibs.length && ok(a)) return a;
    }
    return null;
  };
  for (const fy of [0.4, 0.3, 0.55, 0.2, 0.7]) {
    for (const fx of [0.4, 0.5, 0.3, 0.6]) {
      const el = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      if (!el || el === document.body || el === document.documentElement) continue;
      const item = pick(el);
      if (!item) continue;
      // Its own attribute, so it doesn't interfere with find/hide items.
      document.querySelectorAll("[data-jev-focus]").forEach((e) => e.removeAttribute("data-jev-focus"));
      item.setAttribute("data-jev-focus", "1");
      return { attr: "data-jev-focus", k: "1", text: (item.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300) };
    }
  }
  return null;
}

// Full text of one item, for reading aloud: expands "…see more" first and drops
// UI chrome (Like / Comment / Follow, counts, timestamps).
export async function readItem(k, attr) {
  const el = document.querySelector(`[${attr || "data-jev-item"}="${k}"]`);
  if (!el) return null;
  const MORE = /^(…|\.{3})?\s*(see|show|read)?\s*more\s*(…)?$/i;
  let clicked = 0;
  for (const b of el.querySelectorAll("button, [role=button], a, span")) {
    const t = (b.innerText || "").trim();
    const aria = b.getAttribute("aria-label") || "";
    if ((t && t.length < 20 && MORE.test(t)) || /see more|show more|read more/i.test(aria)) {
      if (b.tagName === "A" && b.getAttribute("href") && !b.getAttribute("href").startsWith("#")) continue;
      b.click();
      clicked++;
      if (clicked > 3) break;
    }
  }
  if (clicked) await new Promise((r) => setTimeout(r, 400));
  const UI = /^(like|comment|comments|repost|reposts|send|share|follow|following|reply|replies|save|more|see more|show more|…more|see translation|show translation|translate|edit|report|promoted|visible to anyone.*|view profile|connect|message|subscribe|load more comments?)$/i;
  const COUNT = /^[\d,.]+\s*[kKmM]?\s*(reactions?|comments?|reposts?|likes?|views?|shares?|impressions?|followers?)?$/;
  const TIME = /^(•\s*)?\d+\s*(s|m|h|d|w|mo|y|yr|min|hr)s?\b\s*(•.*)?$/i;
  // Hide controls while reading the text, so "Like Comment Repost" etc. aren't part of it.
  const hidden = [];
  for (const c of el.querySelectorAll("button, [role=button], [role=toolbar], select, svg, img, video, [aria-hidden=true], .visually-hidden, .sr-only")) {
    hidden.push([c, c.style.display]);
    c.style.setProperty("display", "none", "important");
  }
  const raw = el.innerText || "";
  for (const [c, d] of hidden) c.style.display = d;
  const lines = [];
  for (let line of raw.split(/\n+/)) {
    line = line.replace(/\s*•\s*(1st|2nd|3rd\+?|Following|Verified|Premium)(?![\w+])/gi, "");
    line = line.replace(/\s+/g, " ").trim();
    if (!line || UI.test(line) || COUNT.test(line) || TIME.test(line) || /^•\s*(1st|2nd|3rd\+?)$/.test(line)) continue;
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  return { text: lines.join("\n"), first: lines[0] || "", expanded: clicked > 0 };
}

// The current text selection, if any.
export function getSelectionText() {
  return String(window.getSelection() || "").trim().slice(0, 12000);
}
