// Turns any value from the page into readable text, the way the Console would show it.
// Self-contained: it's sent to the page as source (Function.prototype.toString), so it can't
// use anything outside its own body.
export function serializeValue(v) {
  const seen = new WeakSet();
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const node = (n) => {
    if (n.nodeType === 3) return JSON.stringify(clip(n.textContent, 200));
    if (n.nodeType !== 1) return n.nodeName;
    const tag = n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + [...n.classList].slice(0, 3).map((c) => `.${c}`).join("");
    const text = (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ");
    return `<${tag}>${text ? ` ${JSON.stringify(clip(text, 160))}` : ""}`;
  };
  const walk = (x, d) => {
    if (x === null || x === undefined) return x;
    const t = typeof x;
    if (t === "bigint") return `${x}n`;
    if (t === "symbol") return String(x);
    if (t === "function") return `ƒ ${x.name || "anonymous"}()`;
    if (t !== "object") return x;
    if (typeof Node !== "undefined" && x instanceof Node) return node(x);
    if (x instanceof Error) return `${x.name}: ${x.message}`;
    if (x instanceof Date) return isNaN(x) ? "Invalid Date" : x.toISOString();
    if (x instanceof RegExp) return String(x);
    if (seen.has(x)) return "[circular]";
    if (d > 6) return Array.isArray(x) ? `[Array(${x.length})]` : "[Object]";
    seen.add(x);
    if (x instanceof Map) x = Object.fromEntries(x);
    if (x instanceof Set) x = [...x];
    const listy = Array.isArray(x) || ArrayBuffer.isView(x)
      || (typeof NodeList !== "undefined" && x instanceof NodeList) || (typeof HTMLCollection !== "undefined" && x instanceof HTMLCollection);
    if (listy) {
      const a = Array.from(x);
      const out = a.slice(0, 500).map((y) => walk(y, d + 1));
      if (a.length > 500) out.push(`… ${a.length - 500} more`);
      return out;
    }
    const o = {};
    let i = 0;
    for (const k in x) {
      if (i++ >= 200) { o["…"] = "more keys"; break; }
      try { o[k] = walk(x[k], d + 1); } catch (_) { o[k] = "[unreadable]"; }
    }
    return o;
  };
  const out = walk(v, 0);
  if (out === undefined) return "undefined";
  if (typeof out === "string") return out;
  const text = JSON.stringify(out, null, 2) ?? String(out);
  return text.length > 30000 ? text.slice(0, 30000) + "\n… (cut off)" : text;
}
