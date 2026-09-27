// Read-along highlight: marks the sentence being spoken on the page and keeps it in
// view, like a karaoke cursor. Uses the CSS Custom Highlight API, so the page's DOM
// is never modified. Injected functions: self-contained.

// Find each sentence in the page text, in order. Matching ignores case, spaces and
// punctuation (letters and digits only), so it survives bullets, line breaks and the
// small clean-ups made for speech. Returns how many sentences were found.
export function prepareReadAlong(sentences) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const SKIP = "script,style,noscript,template,svg,.visually-hidden,.sr-only,[class*=visually-hidden]";
  // Flat letters-and-digits string of the page, with a map back to (text node, offset).
  const nodes = [], starts = [];
  let flat = "";
  const map = []; // flat index -> [nodeIndex, offset]
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() && n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const ni = nodes.push(n) - 1;
    starts.push(flat.length);
    const v = n.nodeValue.toLowerCase();
    for (let i = 0; i < v.length; i++) {
      if (/[\p{L}\p{N}]/u.test(v[i])) { flat += v[i]; map.push([ni, i]); }
    }
  }
  const ranges = [];
  let cursor = 0, found = 0;
  sentences.forEach((s, i) => {
    const key = norm(s);
    if (!key) { ranges.push(null); return; }
    // The first sentence: anchor with the next one too, so a title that also appears in
    // the navigation doesn't pull the cursor to the wrong place.
    let at = -1;
    if (i === 0 && sentences[1]) at = flat.indexOf(key + norm(sentences[1]).slice(0, 30));
    if (at < 0) at = flat.indexOf(key, cursor);
    if (at < 0 && key.length > 40) at = flat.indexOf(key.slice(0, 40), cursor);
    if (at < 0) { ranges.push(null); return; }
    const end = Math.min(flat.length - 1, at + key.length - 1);
    try {
      const r = document.createRange();
      const [sn, so] = map[at], [en, eo] = map[end];
      r.setStart(nodes[sn], so);
      r.setEnd(nodes[en], eo + 1);
      ranges.push(r);
      found++;
      cursor = end + 1;
    } catch (_) { ranges.push(null); }
  });
  window.__jevRead = { ranges, current: -1 };
  if (!document.getElementById("__jev_read_style")) {
    const st = document.createElement("style");
    st.id = "__jev_read_style";
    st.textContent = "::highlight(jev-read){background-color:rgba(250,204,21,.55);color:inherit}::highlight(jev-read-done){background-color:rgba(250,204,21,.12)}";
    (document.head || document.documentElement).append(st);
  }
  return { found, total: sentences.length };
}

// Highlight sentence i (and dim the ones already read); scroll it into view if needed.
export function highlightSentence(i) {
  const st = window.__jevRead;
  if (!st || !window.CSS || !CSS.highlights) return false;
  const r = st.ranges[i];
  if (!r) return false;
  st.current = i;
  CSS.highlights.set("jev-read", new Highlight(r));
  const done = st.ranges.slice(Math.max(0, i - 3), i).filter(Boolean);
  CSS.highlights.set("jev-read-done", new Highlight(...done));
  const rect = r.getBoundingClientRect();
  if (rect.top < innerHeight * 0.15 || rect.bottom > innerHeight * 0.8) {
    window.scrollBy({ top: rect.top - innerHeight * 0.35, behavior: "smooth" });
  }
  return true;
}

export function clearReadAlong() {
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete("jev-read");
    CSS.highlights.delete("jev-read-done");
  }
  window.__jevRead = null;
  return true;
}

// Progressive page reader: returns the next chunk of readable text after a cursor
// that lives in the page, so reading can continue down the page (and through content
// that loads as you scroll) instead of stopping at what was extracted up front.
// restart: start from the top of the current view (or the page top if not scrolled).
export async function nextReadingChunk(maxChars, restart) {
  const SKIP = "script,style,noscript,template,svg,canvas,iframe,select,option,button,[role=button],[role=menuitem],[role=tab]," +
    "nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog]," +
    ".visually-hidden,.sr-only,[class*=visually-hidden],.__jev_hl";
  const UI = /^(like|comment|comments|repost|reposts|send|share|follow|following|reply|replies|save|more|see more|show more|…more|see translation|show translation|translate|edit|report|promoted|suggested|visible to anyone.*|view profile|connect|message|subscribe|load more( comments)?|activate to view larger image,?|skip to (main )?content|advertisement|sponsored)$/i;
  const COUNT = /^([\d,.]+\s*[kKmM]?\s*(reactions?|comments?|reposts?|likes?|views?|shares?|impressions?|followers?)?\s*[•·,]?\s*)+$/i;
  const TIME = /^(•\s*)?\d+\s*(s|m|h|d|w|mo|y|yr|min|hr)s?\b\s*(•.*)?$/i;
  const st = (window.__jevReader = window.__jevReader || { cursor: null });
  if (restart) st.cursor = null;

  // Expand "…see more" on what's coming up, so truncated posts are read in full.
  const MORE = /^(…|\.{3})?\s*(see|show|read)?\s*more\s*(…)?$/i;
  let clicked = 0;
  for (const el of document.querySelectorAll("button, [role=button], span[role=link]")) {
    const t = (el.innerText || "").trim();
    if (!t || t.length > 20 || !MORE.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.top < -40 || r.top > innerHeight * 2.5 || r.height === 0) continue;
    el.click();
    if (++clicked > 6) break;
  }
  if (clicked) await new Promise((r) => setTimeout(r, 350));

  const cs = new Map();
  const display = (el) => { if (!cs.has(el)) cs.set(el, getComputedStyle(el).display); return cs.get(el); };
  const blockOf = (el) => { while (el && el !== document.body && (display(el) === "inline" || display(el) === "contents")) el = el.parentElement; return el; };

  // Readable blocks in document order: each text node's nearest block element.
  const order = [], text = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() && n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const b = blockOf(n.parentElement);
    if (!b) continue;
    if (!text.has(b)) { text.set(b, []); order.push(b); }
    text.get(b).push(n.nodeValue);
  }
  const after = (el) => !st.cursor || !st.cursor.isConnected ? true
    : !!(st.cursor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !st.cursor.contains(el) && !el.contains(st.cursor);
  let startI = 0;
  if (!st.cursor) {
    // Start at the first block at or below the top of the view (page top if not scrolled).
    if (scrollY > 150) startI = Math.max(0, order.findIndex((b) => b.getBoundingClientRect().bottom > 60));
  } else if (!st.cursor.isConnected) {
    // The page re-rendered: continue from whatever is now on screen.
    startI = Math.max(0, order.findIndex((b) => b.getBoundingClientRect().top > 0));
  } else {
    startI = order.findIndex(after);
    if (startI < 0) return { lines: [], end: true };
  }
  const lines = [];
  let chars = 0, last = null, first = null;
  for (let i = startI; i < order.length; i++) {
    const b = order[i];
    const r = b.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    let t = text.get(b).join(" ").replace(/\s+/g, " ").trim();
    t = t.replace(/\s*•\s*(1st|2nd|3rd\+?|Following|Verified|Premium)(?![\w+])/gi, "").trim();
    last = b;
    if (!t || UI.test(t) || COUNT.test(t) || TIME.test(t)) continue;
    if (lines[lines.length - 1] === t) continue;
    if (!first) first = b;
    lines.push(t);
    chars += t.length;
    if (chars >= maxChars) break;
  }
  if (last) st.cursor = last;
  const more = last ? order.slice(order.indexOf(last) + 1).some((b) => text.get(b).join("").trim()) : false;
  if (first) first.scrollIntoView({ block: "start", behavior: "smooth" });
  return { lines, end: !more, atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 4 };
}

// Scroll to the bottom so feeds load more, for when the reader runs out of text.
export async function loadMoreBelow() {
  const h = document.documentElement.scrollHeight;
  window.scrollTo({ top: h, behavior: "smooth" });
  await new Promise((r) => setTimeout(r, 1800));
  return document.documentElement.scrollHeight > h + 50;
}
