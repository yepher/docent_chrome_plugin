// Page outline: the page's text as an ordered list of blocks, built in the tab.
// It doesn't rely on class names or repeated-sibling shapes (LinkedIn and friends
// hash their classes and nest posts unpredictably). Every text node belongs to its
// nearest block-level ancestor; that element is one outline line. The model then
// reads the outline and says which range of lines the request is about, and
// extractRange() pulls that range's full text. Injected functions: self-contained.

export function buildOutline(maxLines) {
  maxLines = maxLines || 700;
  const vh = innerHeight;
  // Screen-reader-only copies duplicate visible text (LinkedIn shows the name in an
  // aria-hidden span and repeats it in a visually-hidden one), so skip those.
  const SKIP = "script,style,noscript,template,svg,canvas,iframe,select,option,.visually-hidden,.sr-only,.a11y-text,[class*=visually-hidden],.__jev_hl,#__jev_style";
  const cs = new Map();
  const style = (el) => { if (!cs.has(el)) cs.set(el, getComputedStyle(el)); return cs.get(el); };
  const isBlock = (el) => {
    const d = style(el).display;
    return !(d === "inline" || d === "contents" || d === "inline-block" && el.tagName === "A");
  };
  const bodySize = parseFloat(style(document.body).fontSize) || 16;

  // Text nodes → their nearest block-level element, in document order.
  const order = [];
  const text = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    let b = n.parentElement;
    while (b && b !== document.body && !isBlock(b)) b = b.parentElement;
    if (!b) continue;
    if (!text.has(b)) { text.set(b, []); order.push(b); }
    text.get(b).push(n.nodeValue);
  }

  document.querySelectorAll("[data-jev-b]").forEach((e) => e.removeAttribute("data-jev-b"));
  const lines = [];
  for (const el of order) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // not rendered
    const st = style(el);
    if (st.visibility === "hidden") continue;
    const t = text.get(el).join(" ").replace(/\s+/g, " ").trim();
    if (!t) continue;
    const id = "b" + (lines.length + 1);
    el.setAttribute("data-jev-b", id);
    const size = parseFloat(st.fontSize) || bodySize;
    const bold = parseInt(st.fontWeight, 10) >= 600;
    const heading = /^H[1-6]$/.test(el.tagName) || size >= bodySize * 1.15 || (bold && t.length < 120);
    const link = !!el.closest("a") || !!el.querySelector("a");
    const ui = !!el.closest("button,[role=button],[role=menuitem],[role=tab],nav,[role=navigation]");
    lines.push({
      id, text: t, len: t.length, heading, link, ui,
      pos: r.bottom <= 0 ? "above" : r.top >= vh ? "below" : "screen",
      top: Math.round(r.top + scrollY),
    });
  }

  // Too many lines: keep everything within ~3 screens of the view, and headings/links elsewhere.
  let keep = lines;
  if (lines.length > maxLines) {
    const y0 = scrollY - 3 * vh, y1 = scrollY + 4 * vh;
    keep = lines.filter((l) => (l.top >= y0 && l.top <= y1) || l.heading || l.link);
    if (keep.length > maxLines) keep = keep.filter((l) => l.top >= y0 && l.top <= y1).slice(0, maxLines);
  }
  window.__jevOutline = lines.map((l) => l.id);
  return { url: location.href, title: document.title, total: lines.length, lines: keep };
}

// Full text of outline lines start..end (inclusive), with "…see more" expanded
// first and UI chrome dropped.
export async function extractRange(startId, endId) {
  const q = (id) => document.querySelector(`[data-jev-b="${id}"]`);
  const a = q(startId), b = q(endId) || a;
  if (!a) return null;
  // Lowest common ancestor of the range: where to look for "see more".
  let lca = a;
  while (lca && !lca.contains(b)) lca = lca.parentElement;
  const MORE = /^(…|\.{3})?\s*(see|show|read)?\s*more\s*(…)?$/i;
  let clicked = 0;
  if (lca && (lca.textContent || "").length < 60000) {
    for (const el of lca.querySelectorAll("button, [role=button], a, span")) {
      const t = (el.innerText || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      const inRange = (a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING || a.contains(el)) &&
        (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING || b.contains(el));
      if (!inRange) continue;
      if ((t && t.length < 20 && MORE.test(t)) || /see more|show more|read more/i.test(aria)) {
        if (el.tagName === "A" && el.getAttribute("href") && !el.getAttribute("href").startsWith("#")) continue;
        el.click();
        if (++clicked > 5) break;
      }
    }
    if (clicked) await new Promise((r) => setTimeout(r, 450));
  }

  // Collect text between the two blocks (inclusive), block by block.
  const SKIP = "script,style,noscript,template,svg,button,[role=button],.visually-hidden,.sr-only,.a11y-text,[class*=visually-hidden]";
  const root = lca || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const endEl = b;
  let started = false;
  const blocks = [];
  let cur = null, curBlock = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!started) { if (a.contains(n) || (a.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) started = true; else continue; }
    if (!endEl.contains(n) && (endEl.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    if (!p || p.closest(SKIP) || !n.nodeValue.trim()) continue;
    let blk = p;
    while (blk && blk !== root && getComputedStyle(blk).display === "inline") blk = blk.parentElement;
    if (blk !== curBlock) { curBlock = blk; cur = []; blocks.push(cur); }
    cur.push(n.nodeValue);
  }
  const UI = /^(like|comment|comments|repost|reposts|send|share|follow|following|reply|replies|save|more|see more|show more|…more|see translation|show translation|translate|edit|report|promoted|suggested|visible to anyone.*|view profile|connect|message|subscribe|load more comments?|activate to view larger image,?)$/i;
  const COUNT = /^([\d,.]+\s*[kKmM]?\s*(reactions?|comments?|reposts?|likes?|views?|shares?|impressions?|followers?)?\s*[•·,]?\s*)+$/i;
  const TIME = /^(•\s*)?\d+\s*(s|m|h|d|w|mo|y|yr|min|hr)s?\b\s*(•.*)?$/i;
  const lines = [];
  for (const parts of blocks) {
    let line = parts.join(" ").replace(/\s+/g, " ").trim();
    line = line.replace(/\s*•\s*(1st|2nd|3rd\+?|Following|Verified|Premium)(?![\w+])/gi, "").trim();
    if (!line || UI.test(line) || COUNT.test(line) || TIME.test(line)) continue;
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  a.scrollIntoView({ block: "start", behavior: "smooth" });
  return { text: lines.join("\n"), first: lines[0] || "", expanded: clicked };
}
