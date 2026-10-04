// Reading aids: a distraction-free reader view, and the sentence a word appears in (for
// "define"). The functions below are injected into the tab, so each must be self-contained.

// Reader view: the page's main content, rebuilt as plain headings, paragraphs, lists,
// images and tables, in a full-window overlay. It lives in a shadow root, so the site's
// styles don't reach it and the page underneath isn't changed. mode: "on", "off" or "toggle".
// Returns { open, closed, words, images }.
export function readerView(mode) {
  const cur = window.__docentReader;
  if (cur) {
    if (mode === "on") return { open: true, words: cur.words, images: cur.images };
    cur.close();
    return { open: false, closed: true };
  }
  if (mode === "off") return { open: false, closed: false };

  // The article: a semantic container, or the element holding the most paragraph text
  // (the same choice reading aloud makes).
  const textLen = (el) => (el.innerText || "").length;
  let root = document.querySelector("article, main, [role=main]");
  if (!root || textLen(root) < 400) {
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll("div, section")) {
      let score = 0;
      for (const p of el.querySelectorAll(":scope > p, :scope > div > p")) score += (p.innerText || "").length;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    root = best && bestScore > 300 ? best : document.body;
  }
  const rootLen = textLen(root) || 1;

  const DROP = "script,style,noscript,template,nav,aside,footer,form,button,input,select,textarea,label,svg,canvas,iframe,object,embed,dialog,menu,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],[role=toolbar],[aria-hidden=true],[hidden]"
    + (root === document.body ? ",header" : "");
  const JUNK = /(^|[-_ ])(share|sharing|social|related|recommend\w*|promo\w*|advert\w*|ads?|sponsor\w*|newsletter|subscribe|signup|comments?|sidebar|cookies?|breadcrumbs?|toolbar|popup|modal|paywall)([-_ ]|$)/i;
  const KEEP = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "CODE", "EM", "STRONG", "B", "I", "U", "S", "SUB", "SUP", "FIGURE", "FIGCAPTION", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "BR", "HR", "DL", "DT", "DD", "MARK", "SMALL", "KBD", "Q", "CITE", "ABBR", "TIME"]);
  const VOID = new Set(["BR", "HR", "IMG"]);
  const web = (u) => /^(https?:|data:image\/)/i.test(u || "");
  let images = 0;

  const build = (node, out, pre) => {
    if (node.nodeType === 3) {
      const t = pre ? node.nodeValue : node.nodeValue.replace(/\s+/g, " ");
      if (t) out.append(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node, tag = el.tagName;
    if (el.matches(DROP)) return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    // Share bars, related links, sign-up boxes: dropped unless they hold most of the article.
    if (el !== root && JUNK.test(`${el.id} ${el.getAttribute("class") || ""}`) && textLen(el) < rootLen * 0.5) return;
    if (tag === "IMG") {
      const src = el.currentSrc || el.src;
      const r = el.getBoundingClientRect();
      if (!web(src) || (el.naturalWidth || r.width) < 80 || (el.naturalHeight || r.height) < 40) return;
      const img = document.createElement("img");
      img.src = src;
      img.alt = el.alt || "";
      out.append(img);
      images++;
      return;
    }
    let made;
    if (tag === "A") {
      made = document.createElement("a");
      if (web(el.href) && !el.href.startsWith("data:")) { made.href = el.href; made.target = "_blank"; made.rel = "noopener noreferrer"; }
    } else if (KEEP.has(tag)) {
      made = document.createElement(tag.toLowerCase());
      for (const a of ["colspan", "rowspan"]) if (el.hasAttribute(a)) made.setAttribute(a, el.getAttribute(a));
    } else if (!cs.display.startsWith("inline") && cs.display !== "contents") {
      // An unknown block (div, section…): kept as a block so its text stays a paragraph.
      made = document.createElement("div");
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) made.className = "t";
    }
    const into = made || out;
    for (const k of el.childNodes) build(k, into, pre || tag === "PRE");
    if (made && (VOID.has(tag) || made.textContent.trim() || made.querySelector("img"))) out.append(made);
  };

  const article = document.createElement("article");
  build(root, article, false);
  const words = (article.textContent.match(/\S+/g) || []).length;
  if (words < 60) return { open: false, closed: false, words };
  if (!article.querySelector("h1")) {
    const h1 = document.createElement("h1");
    h1.textContent = document.title;
    article.prepend(h1);
  }

  const host = document.createElement("div");
  host.id = "docent-reader";
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    .wrap { --z: 1; position: fixed; inset: 0; overflow: auto; outline: none; background: #fbfaf7; color: #1f2328; font: calc(19px * var(--z))/1.65 Georgia, "Iowan Old Style", "Times New Roman", serif; }
    .bar { position: sticky; top: 0; display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding: 8px 12px; background: inherit; font: 12px system-ui, -apple-system, sans-serif; }
    .bar span { margin-right: auto; opacity: .6; }
    .bar button { font: inherit; color: inherit; background: rgba(127,127,127,.15); border: 0; border-radius: 6px; padding: 4px 9px; cursor: pointer; }
    .bar button:hover { background: rgba(127,127,127,.3); }
    article { max-width: 68ch; margin: 0 auto; padding: 24px 24px 120px; overflow-wrap: break-word; }
    h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 .7em; }
    h2 { font-size: 1.4em; line-height: 1.3; margin: 1.6em 0 .5em; }
    h3, h4, h5, h6 { font-size: 1.15em; line-height: 1.3; margin: 1.4em 0 .4em; }
    p, .t, ul, ol, dl, blockquote, pre, table, figure { margin: 0 0 1em; }
    a { color: #2456c4; }
    img { display: block; max-width: 100%; height: auto; margin: 1.2em auto; border-radius: 4px; }
    figure { margin-left: 0; margin-right: 0; }
    figcaption, small { font-size: .8em; opacity: .7; }
    blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid rgba(127,127,127,.4); opacity: .9; }
    pre, code, kbd { font: .82em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    pre { overflow: auto; padding: 12px; border-radius: 6px; background: rgba(127,127,127,.12); }
    pre code { font-size: 1em; }
    table { display: block; overflow-x: auto; border-collapse: collapse; font-size: .85em; }
    td, th { border: 1px solid rgba(127,127,127,.35); padding: 4px 8px; text-align: left; vertical-align: top; }
    hr { border: 0; border-top: 1px solid rgba(127,127,127,.35); margin: 2em 0; }
    @media (prefers-color-scheme: dark) {
      .wrap { background: #16181d; color: #d7dae0; }
      a { color: #8ab4f8; }
    }`;
  const wrap = document.createElement("div");
  wrap.className = "wrap";
  wrap.tabIndex = -1;
  const bar = document.createElement("div");
  bar.className = "bar";
  const site = document.createElement("span");
  site.textContent = `Docent reader view · ${location.hostname}`;
  const button = (label, title, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.onclick = fn;
    return b;
  };
  let zoom = 1;
  const resize = (by) => { zoom = Math.min(1.8, Math.max(0.7, zoom + by)); wrap.style.setProperty("--z", zoom); };
  const prevOverflow = document.documentElement.style.overflow;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => {
    host.remove();
    document.documentElement.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey, true);
    window.__docentReader = null;
  };
  bar.append(site, button("A−", "Smaller text", () => resize(-0.1)), button("A+", "Bigger text", () => resize(0.1)), button("✕ Close", "Close reader view (Esc)", close));
  wrap.append(bar, article);
  shadow.append(style, wrap);
  // Beside <body>, not in it, so the page's own scripts and observers don't see it.
  document.documentElement.append(host);
  document.documentElement.style.overflow = "hidden";
  document.addEventListener("keydown", onKey, true);
  wrap.focus();
  window.__docentReader = { close, words, images };
  return { open: true, words, images };
}

// The paragraph a word or phrase appears in, so it can be defined as it is used here:
// the block around the current selection if that holds the term, else the first place
// on the page that does. "" if it isn't on the page.
export function termContext(term, maxChars) {
  const needle = term.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
  if (!needle) return "";
  const block = (n) => {
    let el = n.nodeType === 1 ? n : n.parentElement;
    while (el && el !== document.body && getComputedStyle(el).display.startsWith("inline")) el = el.parentElement;
    return el;
  };
  const around = (el) => {
    const t = ((el && el.innerText) || "").replace(/\s+/g, " ").trim();
    const at = t.toLowerCase().indexOf(needle);
    if (at < 0) return "";
    const from = Math.max(0, Math.min(at - Math.floor(maxChars / 2), t.length - maxChars));
    return t.slice(from, from + maxChars);
  };
  const sel = window.getSelection();
  if (sel && sel.rangeCount && String(sel).trim()) {
    const found = around(block(sel.getRangeAt(0).commonAncestorContainer));
    if (found) return found;
  }
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = 0; w.nextNode() && n < 30000; n++) {
    const node = w.currentNode;
    if (!node.nodeValue.toLowerCase().includes(needle)) continue;
    if (node.parentElement?.closest("script,style,noscript,textarea")) continue;
    const found = around(block(node));
    if (found) return found;
  }
  return "";
}
