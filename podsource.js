// Numbered source text, for podcasts and for written answers that cite where each point
// came from, plus "show what they're talking about". Injected functions: self-contained.
//
// podcastSource numbers the readable blocks of the page (or of one post/section) as
// [p1], [p2]… and its images, charts and videos as [m1], [m2]…, tagging each element with
// data-jev-p. The text model cites those ids at the end of each script line, and while a
// line is spoken showPodcastRefs highlights the text it's about, outlines the image or
// chart, and scrolls it into view. A citation clicked in an answer does the same.
//
// wide: number the whole page, including its navigation, sidebars and footer (answers can
// be about anything on the page; a podcast is about its main content).

export async function podcastSource(startId, endId, maxChars, wide) {
  document.querySelectorAll("[data-jev-p]").forEach((e) => e.removeAttribute("data-jev-p"));
  const SKIP = "script,style,noscript,template,select,option,button,[role=button],[role=menuitem],[role=tab]," +
    (wide ? "" : "nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],") +
    ".visually-hidden,.sr-only,[class*=visually-hidden],.__jev_hl";
  const UI = /^(like|comment|comments|repost|reposts|send|share|follow|following|reply|replies|save|more|see more|show more|…more|see translation|translate|edit|report|promoted|suggested|view profile|connect|message|subscribe|load more( comments)?|skip to (main )?content|advertisement|sponsored)$/i;
  const COUNT = /^([\d,.]+\s*[kKmM]?\s*(reactions?|comments?|reposts?|likes?|views?|shares?|followers?)?\s*[•·,]?\s*)+$/i;

  // Which part of the page: a located range (outline ids), else the main content.
  const q = (id) => (id ? document.querySelector(`[data-jev-b="${id}"]`) : null);
  const startEl = q(startId), endEl = q(endId);
  const scope = startEl || wide ? document.body : document.querySelector("article, main, [role=main]") || document.body;
  const inRange = (el) => {
    if (!startEl) return true;
    const afterStart = startEl === el || startEl.contains(el) || el.contains(startEl) || !!(startEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!afterStart) return false;
    if (!endEl) return true;
    return endEl === el || endEl.contains(el) || el.contains(endEl) || !!(endEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
  };

  const cs = new Map();
  const display = (el) => { if (!cs.has(el)) cs.set(el, getComputedStyle(el).display); return cs.get(el); };
  const blockOf = (el) => { while (el && el !== document.body && (display(el) === "inline" || display(el) === "contents")) el = el.parentElement; return el; };
  const MEDIA = "img, svg, canvas, video, picture, figure, iframe[src*='youtube'], iframe[src*='datawrapper'], iframe[src*='flourish']";
  const isMedia = (el) => {
    if (!el.matches(MEDIA) || el.closest(SKIP)) return false;
    if (el.tagName === "svg" && el.parentElement?.closest("svg")) return false;
    if (el.matches("img, svg, canvas, video, iframe") && el.closest("figure")) return false; // the figure stands for it
    const r = el.getBoundingClientRect();
    return r.width >= 160 && r.height >= 100;
  };
  const describe = (el) => {
    const inner = el.matches("figure") ? el.querySelector("img, svg, canvas, video, iframe") : el;
    const cap = el.querySelector?.("figcaption")?.innerText || el.closest("figure")?.querySelector("figcaption")?.innerText || "";
    const alt = inner?.getAttribute?.("alt") || inner?.getAttribute?.("aria-label") || inner?.getAttribute?.("title") || inner?.querySelector?.("title")?.textContent || "";
    const kind = !inner ? "figure" : inner.matches("svg, canvas") || /chart|graph|plot|diagram|figure|map/i.test(alt + cap) ? "chart or graphic"
      : inner.matches("video, iframe") ? "video" : "image";
    return `${kind}${alt ? `: ${alt.trim().slice(0, 200)}` : ""}${cap ? ` · caption: ${cap.trim().replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
  };

  // One pass in document order: each text node joins its nearest block; media in place.
  const entries = [], byBlock = new Map(), seen = new Set();
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType === 1) return n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 1) {
      if (!seen.has(n) && isMedia(n) && inRange(n)) { seen.add(n); entries.push({ media: true, el: n }); }
      continue;
    }
    if (n.parentElement.closest("figure")) continue; // captions are part of the figure's description
    const b = blockOf(n.parentElement);
    if (!b || !inRange(b)) continue;
    if (!byBlock.has(b)) { const e = { el: b, parts: [] }; byBlock.set(b, e); entries.push(e); }
    byBlock.get(b).parts.push(n.nodeValue);
  }
  const out = [];
  let chars = 0, p = 0, m = 0;
  for (const e of entries) {
    if (chars >= maxChars) break;
    let line;
    if (e.media) {
      const id = `m${++m}`;
      e.el.setAttribute("data-jev-p", id);
      line = `[${id}] (${describe(e.el)})`;
    } else {
      const r = e.el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const t = e.parts.join(" ").replace(/\s+/g, " ").trim();
      if (!t || t.length < 2 || UI.test(t) || COUNT.test(t)) continue;
      const id = `p${++p}`;
      e.el.setAttribute("data-jev-p", id);
      line = `[${id}] ${t.slice(0, 1500)}`;
    }
    out.push(line);
    chars += line.length;
  }
  return { text: out.join("\n"), blocks: p, media: m };
}

export function showPodcastRefs(ids) {
  if (!document.getElementById("__jev_pod_style")) {
    const st = document.createElement("style");
    st.id = "__jev_pod_style";
    st.textContent = "::highlight(jev-pod){background-color:rgba(56,189,248,.28);color:inherit}" +
      ".__jev_pod_media{outline:3px solid #0ea5e9 !important;outline-offset:4px;border-radius:6px;box-shadow:0 0 0 8px rgba(14,165,233,.15) !important;transition:outline-color .3s}";
    (document.head || document.documentElement).append(st);
  }
  if (window.CSS && CSS.highlights) CSS.highlights.delete("jev-pod");
  document.querySelectorAll(".__jev_pod_media").forEach((e) => e.classList.remove("__jev_pod_media"));
  const ranges = [];
  let focus = null, media = null;
  for (const id of ids || []) {
    const el = document.querySelector(`[data-jev-p="${id}"]`);
    if (!el) continue;
    if (id[0] === "m") { el.classList.add("__jev_pod_media"); media = media || el; }
    else { const r = document.createRange(); r.selectNodeContents(el); ranges.push(r); focus = focus || el; }
  }
  if (ranges.length && window.CSS && CSS.highlights) CSS.highlights.set("jev-pod", new Highlight(...ranges));
  // An image or chart they're talking about wins: bring it into view.
  const show = media || focus;
  if (show) {
    const r = show.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 40) show.scrollIntoView({ behavior: "smooth", block: r.height > innerHeight * 0.7 ? "start" : "center" });
  }
  return ranges.length + (media ? 1 : 0);
}

export function clearPodcastRefs() {
  if (window.CSS && CSS.highlights) CSS.highlights.delete("jev-pod");
  document.querySelectorAll(".__jev_pod_media").forEach((e) => e.classList.remove("__jev_pod_media"));
  return true;
}
