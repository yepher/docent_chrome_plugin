// Functions injected into the page with chrome.scripting.executeScript.
// Each must be fully self-contained (no closures over module scope).

// Index the interactive elements on the page and tag each with data-jev-id.
export function snapshotPage(maxElements, textChars) {
  const SEL = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]",
    "[role=radio]", "[role=switch]", "[role=option]", "[role=combobox]", "[role=searchbox]",
    "[role=textbox]", "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);
  const squash = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  document.querySelectorAll("[data-jev-id]").forEach((e) => e.removeAttribute("data-jev-id"));

  const vh = innerHeight, vw = innerWidth;
  const found = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    // Skip elements nested inside another clickable we already have (e.g. <span> in <a>).
    if (el.parentElement && el.parentElement.closest("a[href],button") && !el.matches("input,textarea,select")) continue;
    seen.add(el);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    const dist = inView ? 0 : r.top >= vh ? r.top - vh : -r.bottom;
    found.push({ el, inView, dist });
  }
  found.sort((a, b) => (a.inView === b.inView ? a.dist - b.dist : a.inView ? -1 : 1));
  const picked = found.slice(0, maxElements);
  // Present in document order so the list reads like the page.
  picked.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (t.trim()) return t;
    }
    if (el.labels && el.labels[0]) return el.labels[0].innerText;
    for (const attr of ["data-tooltip", "data-original-title", "data-title", "tooltip", "data-tip", "data-label", "data-name", "data-command", "data-id"]) {
      const v = el.getAttribute(attr);
      if (v && /[a-z]/i.test(v)) return v;
    }
    const desc = el.getAttribute("aria-describedby");
    if (desc) {
      const t = desc.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (t.trim()) return t;
    }
    const svgTitle = el.querySelector("svg title");
    if (svgTitle && svgTitle.textContent.trim()) return svgTitle.textContent;
    // Icon sprites often name the command: <use href="#svg-icon-extrude-button">
    const use = el.querySelector("use");
    const href = use && (use.getAttribute("href") || use.getAttribute("xlink:href"));
    if (href) return href.replace(/^.*#/, "").replace(/(^svg-?|icon-?|-?button$)/gi, "").replace(/[-_]+/g, " ").trim();
    return "";
  };

  const elements = picked.map(({ el, inView }, i) => {
    const id = "e" + (i + 1);
    el.setAttribute("data-jev-id", id);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    let kind = "click";
    let what;
    const label = squash(labelOf(el), 80);
    const text = squash(el.innerText || el.value || "", 80);
    const img = el.querySelector && el.querySelector("img[alt]");
    const name = label || text || squash(el.getAttribute("title"), 80) || squash(img && img.alt, 80);
    const extra = [];
    let options;

    if ((tag === "input" && TEXT_INPUTS.has(type)) || tag === "textarea" || el.isContentEditable ||
        role === "textbox" || role === "searchbox" || (role === "combobox" && tag === "input")) {
      kind = "type";
      what = role === "searchbox" || type === "search" ? "search box" : tag === "textarea" || el.isContentEditable ? "text area" : `${type || "text"} field`;
      const ph = el.getAttribute("placeholder");
      if (label) extra.push(`label "${label}"`);
      if (ph) extra.push(`placeholder "${squash(ph, 60)}"`);
      if (el.name) extra.push(`name "${squash(el.name, 40)}"`);
      const v = type === "password" ? (el.value ? "(filled)" : "") : squash(el.value || (el.isContentEditable ? el.innerText : ""), 60);
      extra.push(v ? `current value "${v}"` : "empty");
    } else if (tag === "select") {
      kind = "select";
      what = "dropdown";
      options = [...el.options].map((o) => squash(o.text, 60)).filter(Boolean).slice(0, 60);
      if (label) extra.push(`label "${label}"`);
      extra.push(`selected "${squash(el.selectedOptions[0]?.text, 60)}"`);
      extra.push(`options: ${options.slice(0, 8).join(", ")}${options.length > 8 ? ", ..." : ""}`);
    } else if (type === "checkbox" || type === "radio" || role === "checkbox" || role === "radio" || role === "switch") {
      what = type || role;
      extra.push(`"${name || el.name || ""}"`);
      const checked = el.checked ?? el.getAttribute("aria-checked") === "true";
      extra.push(checked ? "checked" : "not checked");
    } else if (tag === "a") {
      what = "link";
      extra.push(`"${name}"`);
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:")) extra.push(`to ${squash(href, 60)}`);
    } else {
      what = role || (tag === "input" ? `${type} button` : tag === "button" ? "button" : tag);
      extra.push(`"${name || squash(el.value, 60)}"`);
    }
    if (!inView) extra.push("(off screen)");
    const shownName = name || label || squash(el.getAttribute("placeholder"), 80);
    return { id, kind, name: shownName, desc: `${what} ${extra.join(", ")}`.trim(), options };
  });

  let text = "";
  let lines = [];
  try {
    const raw = document.body.innerText || "";
    text = squash(raw, textChars);
    const seenLines = new Set();
    for (const l of raw.split(/[\n\t]/)) {
      const s = squash(l, 200);
      if (!s || seenLines.has(s) || !/[\p{L}\p{N}]/u.test(s)) continue;
      seenLines.add(s);
      lines.push(s);
      if (lines.length >= 400) break;
    }
  } catch (_) {}
  return {
    url: location.href,
    title: document.title,
    text,
    lines,
    elements,
    atTop: scrollY <= 2,
    atBottom: innerHeight + scrollY >= document.documentElement.scrollHeight - 2,
  };
}

// Readable page text (keeps line breaks) for the text model.
export function pageText(maxChars) {
  const raw = (document.body && document.body.innerText) || "";
  const text = raw.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, maxChars);
  return { url: location.href, title: document.title, text };
}

// Outline the elements an answer refers to, so you can check it on the page.
export function highlightElements(ids, ms) {
  document.querySelectorAll(".__jev_hl").forEach((n) => n.remove());
  const boxes = [];
  ids.forEach((id, i) => {
    const el = document.querySelector(`[data-jev-id="${id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "__jev_hl";
    Object.assign(box.style, {
      position: "absolute", left: `${r.left + scrollX - 3}px`, top: `${r.top + scrollY - 3}px`,
      width: `${r.width + 6}px`, height: `${r.height + 6}px`, border: "2px solid #22c55e",
      borderRadius: "4px", background: "rgba(34,197,94,.12)", zIndex: 2147483647, pointerEvents: "none",
    });
    const tag = document.createElement("span");
    tag.textContent = String(i + 1);
    Object.assign(tag.style, {
      position: "absolute", right: "-8px", top: "-9px", font: "bold 10px/14px system-ui", color: "#fff",
      background: "#16a34a", borderRadius: "3px", padding: "0 4px",
    });
    box.append(tag);
    document.body.append(box);
    boxes.push(box);
  });
  if (boxes.length) setTimeout(() => boxes.forEach((b) => b.remove()), ms);
  return boxes.length;
}

// Perform one action. Returns {ok, note}.
export async function performAction(action) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const find = (id) => document.querySelector(`[data-jev-id="${id}"]`);
  const flash = async (el) => {
    const prev = el.style.outline, prevOff = el.style.outlineOffset;
    el.style.outline = "3px solid #6366f1";
    el.style.outlineOffset = "2px";
    await wait(450);
    el.style.outline = prev;
    el.style.outlineOffset = prevOff;
  };

  switch (action.type) {
    case "scroll_down":
    case "scroll_up":
      window.scrollBy({ top: (action.type === "scroll_down" ? 1 : -1) * innerHeight * 0.8, behavior: "instant" });
      return { ok: true };
    case "go_back":
      history.back();
      return { ok: true };
  }

  const el = find(action.id);
  if (!el) return { ok: false, note: "element no longer on the page" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await flash(el);

  if (action.type === "click") {
    // Keep the agent in this tab instead of spawning new ones.
    const a = el.closest("a[target]");
    if (a && a.target !== "_self") a.target = "_self";
    el.focus?.();
    el.click();
    return { ok: true };
  }

  if (action.type === "type") {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, action.text);
    } else {
      // Use the native setter so React/Vue controlled inputs notice the change.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter ? setter.call(el, action.text) : (el.value = action.text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: action.text, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (action.submit) {
      await wait(150);
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const notPrevented = el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keypress", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      // Synthetic keys don't submit forms natively; do it ourselves.
      if (notPrevented && el.form) {
        el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
      }
    }
    return { ok: true };
  }

  if (action.type === "select") {
    const opt = [...el.options].find((o) => o.text.replace(/\s+/g, " ").trim().startsWith(action.value));
    if (!opt) return { ok: false, note: `option "${action.value}" not found` };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }

  return { ok: false, note: `unknown action ${action.type}` };
}
