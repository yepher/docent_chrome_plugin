// PDFs: Chrome shows them in its built-in viewer, which extensions can't read or script.
// So when the tab is a PDF, Docent downloads the file and extracts its text with pdf.js
// (in the offscreen document), rebuilt into paragraphs with headings and page numbers.
// Every feature that reads the page then uses this text instead of the page's DOM, and
// reading aloud / podcasts turn the viewer to the page being read with "#page=N".

import { ensureOffscreen } from "./voice.js";

const cache = new Map(); // url without #hash → Promise<doc>
export const baseUrl = (u) => String(u || "").split("#")[0];
export const looksLikePdf = (url) => /\.pdf($|[?#])/i.test(url || "") || /arxiv\.org\/pdf\//i.test(url || "");

// Injected: Chrome's PDF viewer page reports the PDF's content type.
export function probeContentType() { return document.contentType; }

// Returns null for normal pages, the extracted document for PDFs, or throws if the PDF
// can't be read.
export async function pdfFor(tab, inject) {
  if (!tab?.url || !/^(https?|file):/i.test(tab.url)) return null;
  let isPdf = looksLikePdf(tab.url);
  if (!isPdf) isPdf = (await inject(probeContentType, []).catch(() => null)) === "application/pdf";
  if (!isPdf) return null;
  const url = baseUrl(tab.url);
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      await ensureOffscreen();
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "pdf:extract", url });
      if (!r || r.error) throw new Error(r?.error || "Couldn't read the PDF.");
      const title = r.title || r.paras.find((p) => p.heading)?.text || tab.title || "PDF";
      return { ...r, url, title };
    })());
    if (cache.size > 6) cache.delete(cache.keys().next().value);
  }
  try {
    return await cache.get(url);
  } catch (e) {
    cache.delete(url);
    throw e;
  }
}

// Paragraph index where the references / bibliography start (not worth reading aloud).
export function endOfBody(doc) {
  const i = doc.paras.findIndex((p) => p.heading && /^(\d+\.?\s*)?(references|bibliography|works cited)$/i.test(p.text.trim()));
  return i > 0 ? i : doc.paras.length;
}

// Where the body starts: papers begin with notices, authors and affiliations; if there's an
// "Abstract" heading on the first pages, reading starts there (after the title).
export function bodyStart(doc) {
  const i = doc.paras.findIndex((p, k) => k < 80 && p.page <= 2 && p.heading && /^abstract\b/i.test(p.text.trim()));
  return i > 0 ? i : 0;
}

// Plain text of paragraphs [from, to), with [page N] markers, up to maxChars.
export function pdfText(doc, maxChars, from = 0, to = doc.paras.length) {
  let out = "", page = 0;
  for (let i = from; i < to && out.length < maxChars; i++) {
    const p = doc.paras[i];
    if (p.page !== page) { page = p.page; out += `${out ? "\n\n" : ""}[page ${page}]\n`; }
    out += (p.heading ? "\n" : "") + p.text + "\n";
  }
  return out.slice(0, maxChars).trim();
}

// Paragraphs [from, to) numbered [p1], [p2]… so a podcast line or an answer can cite them.
// pages maps each id to its page, for turning the viewer to it.
export function pdfNumbered(doc, maxChars, from = 0, to = doc.paras.length) {
  const lines = [], pages = {};
  let chars = 0;
  for (let i = from; i < to && chars < maxChars; i++) {
    const p = doc.paras[i], id = `p${i + 1}`;
    pages[id] = p.page;
    const line = `[${id}] ${p.heading ? "## " : ""}${p.text}`;
    lines.push(line);
    chars += line.length;
  }
  return { text: lines.join("\n"), pages, count: lines.length };
}

// Reading chunks of about maxChars, each tagged with the page it starts on.
export function pdfChunks(doc, maxChars, from = 0, to = endOfBody(doc)) {
  const chunks = [];
  let cur = null;
  for (let i = from; i < to; i++) {
    const p = doc.paras[i];
    if (!cur || cur.chars >= maxChars) { cur = { lines: [], chars: 0, page: p.page }; chunks.push(cur); }
    cur.lines.push(p.text);
    cur.chars += p.text.length;
  }
  return chunks;
}

// Turn Chrome's PDF viewer to a page.
export function goToPage(tabId, doc, page) {
  if (!page) return Promise.resolve();
  return chrome.tabs.update(tabId, { url: `${doc.url}#page=${page}` }).catch(() => {});
}
