// Expressive speech, ported from LiveKit Agents' expressive mode
// (livekit-agents/livekit/agents/tts/_provider_format.py). The text model writes one
// marker dialect, <expr type="…" label="…"/>, taught per TTS provider with only the
// types and labels that provider supports; before synthesis each marker is lowered to
// the provider's native markup. The Agents SDK does this lowering on the client, so the
// same native markup goes over the same Inference TTS WebSocket Docent already uses.
//
// Supported here: Cartesia (sonic-3: <emotion/>, <speed/>, <volume/>, <break/>, <spell>)
// and Fish Audio (s2 family: [very excited], [laughing], [break], [emphasis] word,
// [whispering] …). Other voices get the markers stripped, so they're never read aloud.

const PREAMBLE = `You control speech delivery with a single XML marker tag: <expr/>. Every marker has a type attribute. Use only the marker types listed below, and where a type lists a label vocabulary, only those labels. Use the markers often and diversify them so the voice never sounds flat while ensuring the markers are appropriate for the moment. Write the words themselves the way people talk: use contractions ("I'm", "you're", "don't") — spelled-out forms like "I am" or "do not" sound stiff when spoken.

Just as important is knowing when NOT to reach for a marker. Reserve surprise openers like "oh" or "ah" for genuine surprise — an ordinary request isn't one. Don't stack markers on short replies or decorate every sentence. If a reaction wouldn't happen in a real conversation, skip it — there's always another genuine beat to lean into.

Match your delivery to the REGISTER of the moment, and reassess every turn. When the moment is professional, high-stakes, or emotionally heavy — bad news, an emergency, real distress — keep delivery composed and restrained. When the moment is casual, playful, or celebratory, let it loosen and brighten. A serious turn in an otherwise casual conversation still gets a composed reply.`;

const CARTESIA = `1. Emotion - sets the emotional tone. Self-closing; place before EVERY sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions. Best results: neutral, angry, excited, content, sad, scared.
   Also available: happy, enthusiastic, elated, triumphant, amazed, surprised, flirtatious, curious, peaceful, serene, calm, grateful, affectionate, sympathetic, mysterious, frustrated, disgusted, sarcastic, ironic, dejected, melancholic, disappointed, apologetic, hesitant, confused, anxious, panicked, proud, confident, contemplative, determined, joking/comedic.

2. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="1s"/> - label is a duration in seconds or milliseconds.

3. Prosody - adjusts pacing and loudness from that point on. Self-closing.
   <expr type="prosody" label="slow"/> slower    <expr type="prosody" label="fast"/> faster
   <expr type="prosody" label="soft"/> quieter    <expr type="prosody" label="loud"/> louder
   Labels are a fixed vocabulary: slow, fast, soft, loud.

4. Spell - wraps text read character by character (codes, IDs, or a spelled-out name).
   <expr type="spell">A7X9</expr>
   Keep punctuation out of a spell marker — a period inside is read as "dot"; add spaces inside for grouped pauses (<expr type="spell">ABC 123</expr>).

This voice has no non-verbal sounds and no free-form delivery descriptions — do not invent other types or labels.

Examples:
  <expr type="expression" label="excited"/> I can't wait to tell you! <expr type="expression" label="happy"/> This is going to be great!
  <expr type="expression" label="curious"/> Really? <expr type="break" label="500ms"/> <expr type="expression" label="excited"/> Tell me more!
  Your code is <expr type="spell">A7X9</expr>. <expr type="break" label="1s"/> <expr type="expression" label="calm"/> Got it?`;

const FISH_EMOTIONS = ["regretful", "hopeful", "happy", "excited", "curious", "surprised", "sad", "empathetic", "sarcastic", "calm", "angry", "worried", "nervous", "confident", "grateful", "delighted", "disappointed", "frustrated", "determined"];
const FISH_SOUNDS = ["laughing", "chuckling", "clear throat", "sighing", "gasping", "groaning", "yawning", "sobbing"];
const FISH_TONES = ["whispering", "soft", "shouting", "hurried"];
const FISH_SOUND_ALIASES = { laugh: "laughing", chuckle: "chuckling", sigh: "sighing", gasp: "gasping", groan: "groaning", yawn: "yawning", sob: "sobbing", cry: "sobbing" };
const FISH = `1. Emotion - sets how a sentence sounds. Self-closing; place at the START of a sentence.
   <expr type="expression" label="EMOTION"/>
   Labels are a fixed vocabulary, NOT free-form descriptions: ${FISH_EMOTIONS.join(", ")}.
   Give every sentence its own emotion marker — repeat the same label to carry a feeling across sentences, or switch labels when the feeling shifts.

2. Sounds - a non-verbal sound between sentences. Self-closing.
   <expr type="sound" label="laughing"/>
   Labels are a fixed vocabulary: ${FISH_SOUNDS.join(", ")}.
   Use non-verbal sounds sparingly, and never the same one twice in a row — reach for one only where it genuinely fits. An enabled sound gets over-used otherwise.

3. Pauses - insert silence when appropriate. Self-closing.
   <expr type="break" label="500ms"/> or <expr type="break" label="2s"/>.
   NEVER place a break next to a period, question mark, exclamation point, or ellipsis — sentence punctuation already pauses, and a break beside it double-pauses. Most replies need no break markers at all; reserve them for a deliberate mid-sentence beat before a key detail (a date, a name, a number).

4. Tone - wraps a span delivered in a distinct style.
   <expr type="prosody" label="whispering">don't tell anyone yet.</expr>
   Labels are a fixed vocabulary: ${FISH_TONES.join(", ")}.
   Use a tone only where the moment clearly calls for one — most sentences need none. Never nest tone markers, and always close the tag with </expr>.

5. Emphasis - stresses exactly the ONE word it wraps.
   Are you <expr type="prosody" label="emphasis">sure</expr> you want to do this?
   Wrap a single word, never a phrase. Never nest it, and always close it with </expr>.

Write for the EAR, not the page: no em or en dashes anywhere in spoken text — use a comma or a period for a short beat, or a break marker for a real pause. Avoid semicolons, mid-sentence colons, and parenthetical asides; rewrite them as separate sentences or commas.

At heavy moments reach for empathetic, sad, regretful, or hopeful — never a bright label like "happy" or "excited" against hard news; bright labels belong to bright moments. Whispering and soft belong to gentle or conspiratorial beats; shouting only to genuinely high-energy ones. Laughter belongs only in genuinely playful or celebratory beats, never at a serious moment. Save fillers for relaxed moments — never in an emergency or against grave news.

Examples:
  <expr type="expression" label="excited"/> That's hilarious! <expr type="sound" label="laughing"/> <expr type="expression" label="happy"/> You always lighten the mood.
  <expr type="expression" label="empathetic"/> <expr type="sound" label="clear throat"/> That sounds like a <expr type="prosody" label="emphasis">really</expr> difficult experience.
  <expr type="expression" label="frustrated"/> <expr type="sound" label="sighing"/> I've been going in circles with this all morning. <expr type="expression" label="determined"/> Okay. One more try.
  <expr type="expression" label="happy"/> You're all set for <expr type="break" label="500ms"/> Thursday the <expr type="prosody" label="emphasis">ninth</expr>. <expr type="expression" label="curious"/> Is there anything else I can help you with?
  <expr type="expression" label="delighted"/> <expr type="prosody" label="whispering">Okay, don't tell anyone yet</expr> <expr type="expression" label="excited"/> but I think we actually pulled it off!
  <expr type="expression" label="curious"/> Um, uh... really? <expr type="expression" label="sad"/> Well, I'm really sorry to hear that.`;

const BLOCKS = { cartesia: CARTESIA, fishaudio: FISH };
const PROVIDER_NAMES = { cartesia: "Cartesia", fishaudio: "Fish Audio" };

// Which markup dialect a voice ("provider/model:voice") speaks, or null if none.
export function providerOf(voiceId) {
  const model = String(voiceId || "").split(":")[0];
  const [provider, name = ""] = model.split("/");
  if (provider === "cartesia" && /^sonic-3/.test(name)) return "cartesia";
  if (provider === "fishaudio" && /^s2/.test(name)) return "fishaudio";
  return null;
}
export const supportsExpressive = (voiceId) => !!providerOf(voiceId);

// Instructions for a script with several speakers: speakers = [{ name, voice }].
export function scriptInstructions(speakers) {
  const withProv = speakers.map((sp) => ({ ...sp, provider: providerOf(sp.voice) }));
  const provs = [...new Set(withProv.map((x) => x.provider).filter(Boolean))];
  if (!provs.length) return "";
  const intro = "The script is spoken by expressive text-to-speech voices. Mark up each line's delivery as follows.";
  const plain = withProv.filter((x) => !x.provider).map((x) => x.name);
  const plainNote = plain.length ? `\n\n${plain.join(" and ")}'s voice has no expressive controls: write their lines without any markers.` : "";
  if (provs.length === 1) return `${intro}\n\n${PREAMBLE}\n\n${BLOCKS[provs[0]]}${plainNote}`;
  const per = provs.map((p) => {
    const names = withProv.filter((x) => x.provider === p).map((x) => x.name).join(" and ");
    return `Markers for ${names}'s lines (${PROVIDER_NAMES[p]} voice):\n${BLOCKS[p]}`;
  }).join("\n\n");
  return `${intro}\n\n${PREAMBLE}\n\nThe two hosts use different voices with different markers. Use only the markers listed for the host speaking the line.\n\n${per}${plainNote}`;
}

// ---- lowering <expr> markers to native markup ----
const ATTR = /([\w-]+)\s*=\s*"([^"]*)"/g;
const attrs = (s) => Object.fromEntries([...String(s || "").matchAll(ATTR)].map((m) => [m[1], m[2]]));
const WRAP = /([^\S\r\n]*)<expr\b(?=[^>]*type="(?:prosody|spell)")([^>]*?)>([\s\S]*?)<\/expr\s*>/g;
const SELF = /([^\S\r\n]*)<expr\b([^>]*?)\/\s*>/g;
const OPEN = /([^\S\r\n]*)<expr\b([^>]*?)\/?\s*>/g;
const CLOSE = /([^\S\r\n]*)<\/expr\s*>/g;
const UNCLOSED = /(<expr\b(?=[^>]*type="(?:expression|break|sound)")[^>]*[^/>\s])\s*>/g;
const CARTESIA_PROSODY = { slow: '<speed ratio="0.85"/>', fast: '<speed ratio="1.2"/>', soft: '<volume ratio="0.9"/>', loud: '<volume ratio="1.3"/>' };

// Replacement for a removed marker without leaving a doubled space behind.
function keep(pre, kept, full, end) {
  if (kept) return pre + kept;
  if (!pre) return "";
  return /\s/.test(full.charAt(end)) ? "" : pre;
}

export function convert(provider, text) {
  let t = String(text || "").replace(UNCLOSED, "$1/>");
  if (!/<\/?expr/.test(t)) return t;
  t = t.replace(WRAP, (m, pre, a, inner, off, full) => {
    const at = attrs(a), label = (at.label || "").trim().toLowerCase();
    let out = inner;
    if (at.type === "spell") out = provider === "cartesia" ? `<spell>${inner}</spell>` : inner;
    else if (provider === "cartesia") out = (CARTESIA_PROSODY[label] || "") + inner;
    else if (provider === "fishaudio") out = label === "emphasis" ? `[emphasis] ${inner.trim()}` : FISH_TONES.includes(label) ? `[${label}] ${inner}` : inner;
    return keep(pre, out, full, off + m.length);
  });
  t = t.replace(SELF, (m, pre, a, off, full) => {
    const at = attrs(a), type = at.type || "", label = (at.label || "").trim();
    let out = "";
    if (type === "expression") {
      if (provider === "cartesia") out = `<emotion value="${label}"/>`;
      else if (provider === "fishaudio") out = `[${/^very /i.test(label) ? label : `very ${label}`}]`;
    } else if (type === "sound") {
      if (provider === "fishaudio") out = `[${FISH_SOUND_ALIASES[label.toLowerCase()] || label}]`;
    } else if (type === "break") {
      if (provider === "cartesia") out = `<break time="${label}"/>`;
      else if (provider === "fishaudio") out = seconds(label) >= 1 ? "[long-break]" : "[break]";
    } else if (type === "prosody") {
      const l = label.toLowerCase();
      if (provider === "cartesia") out = CARTESIA_PROSODY[l] || "";
      else if (provider === "fishaudio") out = FISH_TONES.includes(l) ? `[${l}]` : "";
    }
    return keep(pre, out, full, off + m.length);
  });
  // stray unpaired markers never reach the voice as literal text
  t = t.replace(OPEN, (m, pre, a, off, full) => keep(pre, "", full, off + m.length));
  t = t.replace(CLOSE, (m, pre, off, full) => keep(pre, "", full, off + m.length));
  return t;
}

function seconds(label) {
  const raw = String(label).trim().toLowerCase();
  const n = raw.endsWith("ms") ? parseFloat(raw) / 1000 : parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

// For transcripts: the words only.
export function strip(text) {
  let t = String(text || "").replace(UNCLOSED, "$1/>");
  t = t.replace(WRAP, (m, pre, a, inner, off, full) => keep(pre, inner, full, off + m.length));
  t = t.replace(OPEN, (m, pre, a, off, full) => keep(pre, "", full, off + m.length));
  t = t.replace(CLOSE, (m, pre, off, full) => keep(pre, "", full, off + m.length));
  return t.replace(/[^\S\r\n]{2,}/g, " ").replace(/^\s+/, "");
}

// Voice text for one voice: native markup, or plain words for voices without it.
export function forVoice(voiceId, text) {
  const p = providerOf(voiceId);
  return p ? convert(p, text) : strip(text);
}
