// Jev picks from options; it doesn't write text. So any text we type or URL we
// open has to come from the user's prompt. These helpers over-generate candidate
// spans from the prompt; Jev then chooses which one (the "pre-parsed value
// extraction" pattern from the TypeSafe cookbooks).

const MAX_OPTIONS = 250; // Choice allows 255; leave room for "none".
const MAX_SPAN_WORDS = 14;
const TRIGGERS = /^(for|type|typing|enter|search|write|fill|with|as|to|named|called|titled|say|saying|message|query|put|into|in)$/i;

function clean(s) {
  return s
    .trim()
    .replace(/^[\s"'“”‘’`(\[{,;:]+/, "")
    .replace(/[\s"'“”‘’`)\]},;:!?]+$/, "")
    .replace(/\.$/, "")
    .trim();
}

export function textCandidates(goal) {
  const tiers = [[], [], [], []];
  const seen = new Set();
  const add = (tier, s) => {
    const c = tier === 0 ? s : clean(s);
    if (!c || seen.has(c)) return;
    seen.add(c);
    tiers[tier].push(c);
  };

  // Tier 0: explicitly quoted text is almost certainly what should be typed.
  for (const m of goal.matchAll(/["“”`]([^"“”`]{1,300})["“”`]/g)) add(0, m[1]);
  // Text after a colon ("reply: sounds good") is a strong candidate too.
  for (const m of goal.matchAll(/:\s*(.{1,300})$/g)) add(0, m[1].trim());

  const words = goal.split(/\s+/).filter(Boolean);
  // Tier 1: spans that start right after a trigger word ("search for <x>").
  for (let i = 0; i < words.length; i++) {
    if (!TRIGGERS.test(clean(words[i]))) continue;
    for (let j = i + 2; j <= Math.min(words.length, i + 1 + MAX_SPAN_WORDS); j++) add(1, words.slice(i + 1, j).join(" "));
  }
  // Tier 2: the whole prompt. Tier 3: every other contiguous span, short first.
  add(2, goal);
  for (let len = 1; len <= MAX_SPAN_WORDS; len++) {
    for (let i = 0; i + len <= words.length; i++) add(3, words.slice(i, i + len).join(" "));
  }
  return tiers.flat().slice(0, MAX_OPTIONS);
}

export function urlCandidates(goal) {
  const out = [];
  const re = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|dev|app|edu|gov|co|us|uk|de|fr|ca|me|info|tv|xyz|[a-z]{2})(?::\d+)?(?:\/[^\s"'<>]*)?)/gi;
  for (const m of goal.matchAll(re)) {
    let u = m[1].replace(/[.,;:!?)]+$/, "");
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, MAX_OPTIONS);
}
