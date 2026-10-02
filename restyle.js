// Changing the page in place: "make the background red", "bigger text", "dark mode",
// "replace 'colour' with 'color'". The text model writes CSS (and text edits) from an
// outline of the page's structure; code applies them and can undo them.
//
// The functions below are injected into the tab, so each must be self-contained.

// An indented outline of the page's elements as selectors, for the text model to target.
// "bg:" marks a painted background covering a notable part of the screen (these hide a
// page-wide background change unless they're overridden too).
export function pageSkeleton(maxChars = 9000) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE", "IFRAME", "svg", "SVG", "BR", "WBR"]);
  const area = innerWidth * innerHeight;
  const esc = (x) => (window.CSS?.escape ? CSS.escape(x) : x);
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id && el.id.length < 40 && !/\d{4,}/.test(el.id)) s += `#${esc(el.id)}`;
    const cls = [...el.classList].filter((c) => c.length < 30 && !c.startsWith("jev-")).slice(0, 3);
    return s + cls.map((c) => `.${esc(c)}`).join("");
  };
  const lines = [];
  let chars = 0;
  const walk = (el, depth) => {
    if (chars > maxChars || depth > 8) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (depth > 1 && (r.width < 2 || r.height < 2)) return;
    let line = "  ".repeat(depth) + sel(el);
    const bg = cs.backgroundColor;
    if (bg && bg !== "transparent" && !/, 0\)$/.test(bg) && r.width * r.height > area * 0.05) line += ` bg:${bg}`;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" ").replace(/\s+/g, " ").trim();
    if (own) line += ` "${own.slice(0, 50)}${own.length > 50 ? "…" : ""}"`;
    lines.push(line);
    chars += line.length + 1;
    // Repeated siblings (list rows, cards): show two, count the rest.
    const seen = new Map();
    for (const k of el.children) {
      if (SKIP.has(k.tagName)) continue;
      const sig = sel(k);
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);
      if (n <= 2) walk(k, depth + 1);
    }
    for (const [sig, n] of seen) if (n > 2) { const l = `${"  ".repeat(depth + 1)}… ${n - 2} more ${sig}`; lines.push(l); chars += l.length + 1; }
  };
  walk(document.documentElement, 0);
  const b = getComputedStyle(document.body || document.documentElement);
  return {
    url: location.href,
    title: document.title,
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    body: { background: b.backgroundColor, color: b.color, font: `${b.fontSize} ${b.fontFamily.slice(0, 60)}` },
    skeleton: lines.join("\n"),
  };
}

// edits: [{ selector, text }] sets an element's text; [{ find, replace }] replaces text
// everywhere on the page. Originals are kept in the tab for undoEdits(). Returns how many
// places changed.
export function applyEdits(edits) {
  const saved = (window.__docentEdits ||= []);
  let n = 0;
  const set = (node, value) => { if (node.nodeValue !== value) { saved.push({ node, old: node.nodeValue }); node.nodeValue = value; n++; } };
  for (const e of edits || []) {
    if (e.selector && typeof e.text === "string") {
      let els = [];
      try { els = [...document.querySelectorAll(e.selector)].slice(0, 50); } catch (_) {}
      for (const el of els) {
        // Keep child elements (icons, links): put the new text in the first text node.
        const texts = [...el.childNodes].filter((x) => x.nodeType === 3 && x.nodeValue.trim());
        if (texts.length) { set(texts[0], e.text); texts.slice(1).forEach((t) => set(t, "")); }
        else if (!el.children.length) { el.textContent = e.text; if (el.firstChild) { saved.push({ node: el.firstChild, old: "" }); n++; } }
      }
    } else if (e.find && typeof e.replace === "string") {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (w.nextNode() && nodes.length < 20000) nodes.push(w.currentNode);
      for (const node of nodes) {
        if (node.parentElement?.closest("script,style,textarea,noscript")) continue;
        if (node.nodeValue.includes(e.find)) set(node, node.nodeValue.split(e.find).join(e.replace));
      }
    }
  }
  return n;
}

export function undoEdits() {
  const saved = window.__docentEdits || [];
  for (const { node, old } of saved.reverse()) { try { node.nodeValue = old; } catch (_) {} }
  window.__docentEdits = [];
  return saved.length;
}
