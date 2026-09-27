// Which part of the page does a request mean? ("read the post from Rhodri Hughes",
// "summarize the article I'm looking at", "read this page").
//
//   1. Build an outline of the page in the tab (outline.js): every text block in
//      reading order, with an id, on-screen / above / below, heading-ness.
//   2. The text model reads the outline and returns the block range the request is
//      about, or "whole page". Without a text model, Jev picks the starting line
//      (a heading or author line) with a Choice and code finds where it ends.
//   3. extractRange() pulls that range's full text ("…see more" expanded, buttons,
//      counts and timestamps dropped).

import { buildOutline, extractRange } from "./outline.js";
import { focusedItem, readItem } from "./items.js";
import { chat } from "./lk.js";
import { systemOne, choice } from "./jev.js";

const LOCATE_PROMPT = `You locate content on a web page for a browser assistant.
You get the page outline: one line per text block, in reading order, as
  <id> [ON SCREEN|above|below] (heading|button)? <start of the block's text>
The user's request is about the page. Decide which contiguous range of blocks it refers to.
Reply with JSON only, one of:
  {"scope":"range","start":"<first id>","end":"<last id>","label":"<short description, e.g. Post by Jane Doe>"}
  {"scope":"page"}
Rules:
- A post, article, comment or item starts at its author, title or heading line and ends at its last content line, before the next item's author/title and without the next item's buttons.
- "this", "current", "the one I'm looking at", "on screen" mean the item that is ON SCREEN (if several, the one with the most ON SCREEN lines).
- A named item ("the post from Jane Doe", "the article about X") may be above or below the screen.
- Use {"scope":"page"} only when the request is about the whole page (e.g. "read this page", "summarize the page").`;

function outlineText(lines) {
  return lines.map((l) => {
    const pos = l.pos === "screen" ? "ON SCREEN" : l.pos;
    const kind = l.ui ? " (button)" : l.heading ? " (heading)" : "";
    const t = l.text.length > 110 ? `${l.text.slice(0, 110)}… (${l.len} chars)` : l.text;
    return `${l.id} [${pos}]${kind} ${t}`;
  }).join("\n");
}

const DEICTIC = /\b(this|current|that)\s+(post|article|item|tweet|story|comment|thread|message|email|review|entry|one|update|section|answer)\b|\blooking at\b|\bon (my |the )?screen\b|\bin front of me\b/i;

// ctx: { tabId, goal, settings, llm, signal, log, inject(func, args) }
// Returns { kind: "page" } or { kind: "item", text, first, label }.
export async function pickTarget(ctx, purpose) {
  const { log, inject } = ctx;
  const outline = await inject(buildOutline, [700]).catch((e) => { log("warn", `Couldn't outline the page: ${e.message}`); return null; });
  if (!outline?.lines?.length) return fallbackFocused(ctx);
  const ids = outline.lines.map((l) => l.id);
  const idx = (id) => ids.indexOf(id);
  log("info", `Outlined the page: ${outline.total} text blocks${outline.total > outline.lines.length ? ` (${outline.lines.length} near the screen sent)` : ""}.`);

  let range = null;
  if (ctx.llm) {
    try {
      const out = await chat(ctx.llm, [
        { role: "system", content: LOCATE_PROMPT },
        { role: "user", content: `Request: ${ctx.goal}\n(The assistant will ${purpose} it.)\nPage: ${outline.title} (${outline.url})\n\nOutline:\n${outlineText(outline.lines)}` },
      ], { signal: ctx.signal, maxTokens: 120 });
      const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]);
      if (j.scope === "page") { log("info", `${ctx.llm.lkModel}: the whole page.`); return { kind: "page" }; }
      if (idx(j.start) >= 0) {
        let s = idx(j.start), e = idx(j.end) >= 0 ? idx(j.end) : Math.min(ids.length - 1, s + 40);
        if (e < s) [s, e] = [e, s];
        range = { start: ids[s], end: ids[e], label: j.label || "" };
        log("info", `${ctx.llm.lkModel}: ${range.label || "a section"} (lines ${range.start}–${range.end}).`);
      } else {
        log("warn", `The text model didn't return a usable range (${out.slice(0, 120)}).`);
      }
    } catch (e) {
      log("warn", `Couldn't locate it with the text model: ${e.message}`);
    }
  }
  if (!range && ctx.settings?.apiKey) range = await rangeWithJev(ctx, outline);
  if (range === "page") return { kind: "page" };
  if (!range) return DEICTIC.test(ctx.goal) ? fallbackFocused(ctx) : { kind: "page" };

  const got = await inject(extractRange, [range.start, range.end]);
  if (!got?.text) return { kind: "page" };
  if (got.expanded) log("info", `Expanded "see more" (${got.expanded}).`);
  return { kind: "item", text: got.text, first: range.label || got.first, label: range.label };
}

// Jev only: pick the starting line (a heading/author line) with a Choice; the range
// ends before the next line that looks the same (the next post's author/title).
async function rangeWithJev(ctx, outline) {
  const lines = outline.lines;
  const cands = lines
    .map((l, i) => ({ ...l, i }))
    .filter((l) => !l.ui && (l.heading || l.link) && l.len >= 2 && l.len <= 140)
    .sort((a, b) => (a.pos === "screen" ? 0 : 1) - (b.pos === "screen" ? 0 : 1))
    .slice(0, 200)
    .sort((a, b) => a.i - b.i);
  if (!cands.length) return null;
  const s = ctx.settings;
  const res = await systemOne({
    apiBase: s.apiBase, apiKey: s.apiKey, model: s.model, signal: ctx.signal,
    state: { request: ctx.goal, page: { url: outline.url, title: outline.title }, note: "Lines marked 'on screen' are what the user is looking at now." },
    questions: {
      start: choice("Which line is the title, heading or author line where the part of the page that `request` is about begins?", {
        ...Object.fromEntries(cands.map((c) => [c.id, `"${c.text.slice(0, 120)}" (${c.pos === "screen" ? "on screen" : `${c.pos} the screen`})`])),
        whole_page: "The request is about the whole page",
      }),
    },
  }).catch((e) => { ctx.log("warn", `Couldn't ask Jev: ${e.message}`); return null; });
  const a = res?.answers?.start;
  if (!a) return null;
  if (a.choice === "whole_page") { ctx.log("info", "Jev: the whole page."); return "page"; }
  const start = cands.find((c) => c.id === a.choice);
  if (!start) return null;
  // End: just before the next candidate line that looks like this one (same kind, similar length).
  const next = cands.find((c) => c.i > start.i + 1 && c.heading === start.heading && c.link === start.link && Math.abs(c.len - start.len) < 60);
  const endI = next ? next.i - 1 : Math.min(lines.length - 1, start.i + 60);
  ctx.log("info", `Jev: starts at "${start.text.slice(0, 60)}"`, `confidence ${Math.round(a.confidence * 100)}%`);
  return { start: start.id, end: lines[endI].id, label: start.text.slice(0, 80) };
}

async function fallbackFocused(ctx) {
  const f = await ctx.inject(focusedItem, [150, 40000]).catch(() => null);
  if (!f) return { kind: "page" };
  const full = await ctx.inject(readItem, [f.k, f.attr]);
  if (!full?.text) return { kind: "page" };
  ctx.log("info", `Using the item in the middle of your screen: "${f.text.slice(0, 70)}…"`);
  return { kind: "item", text: full.text, first: full.first };
}
