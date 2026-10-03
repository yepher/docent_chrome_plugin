// Videos: the transcript of the video on the page, from its captions, so questions and
// summaries can be answered from what is said, and each answer can point at the moment
// it comes from. Injected functions: self-contained.

// Runs in the page's own world (MAIN), because YouTube's caption track list lives on its
// player object. Returns null when the page has no video with captions, { error } when
// the captions couldn't be read, or
//   { site, title, author, duration, lang, langName, auto, blocks: [{ t: seconds, text }] }
// where each block is about half a minute of speech.
export async function videoTranscript(prefLang) {
  const clean = (t) => String(t || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const group = (cues) => {
    const blocks = [];
    let cur = null, prev = "";
    for (const c of cues) {
      if (!c.text || c.text === prev) continue; // rolling captions repeat the last line
      prev = c.text;
      if (!cur || cur.text.length >= 320 || c.t - cur.t >= 40) { cur = { t: Math.floor(c.t), text: c.text }; blocks.push(cur); }
      else cur.text += " " + c.text;
    }
    return blocks;
  };
  const want = String(prefLang || "en").toLowerCase().split("-")[0];
  const base = (code) => String(code || "").toLowerCase().split("-")[0];
  // Your language first, then English, then whatever there is; written captions before auto-generated.
  const rank = (code, auto) => (base(code) === want ? 0 : base(code) === "en" ? 2 : 4) + (auto ? 1 : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- YouTube ----
  const player = document.querySelector("#movie_player, .html5-video-player");
  const pr = player?.getPlayerResponse?.();
  if (pr?.videoDetails) {
    const d = pr.videoDetails;
    const meta = { site: "youtube", title: d.title || document.title, author: d.author || "", duration: Number(d.lengthSeconds) || 0 };
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return { ...meta, error: "this video has no captions" };
    const track = [...tracks].sort((a, b) => rank(a.languageCode, a.kind === "asr") - rank(b.languageCode, b.kind === "asr"))[0];
    const get = async (url) => {
      try {
        const u = new URL(url, location.href);
        u.searchParams.set("fmt", "json3");
        const res = await fetch(u.href);
        const body = res.ok ? await res.text() : "";
        return body ? JSON.parse(body) : null;
      } catch (_) { return null; }
    };
    let j = await get(track.baseUrl);
    if (!j?.events) {
      // YouTube sometimes answers only requests carrying the player's own token. Borrow it
      // from the request the player makes when captions are switched on.
      const own = () => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.includes("/api/timedtext") && /[?&]pot=/.test(n)).pop();
      let seen = own();
      if (!seen && player.toggleSubtitlesOn) {
        const was = player.isSubtitlesOn?.();
        player.toggleSubtitlesOn();
        for (let i = 0; i < 12 && !(seen = own()); i++) await sleep(250);
        if (!was) player.toggleSubtitles?.();
      }
      if (seen) {
        const from = new URL(seen), to = new URL(track.baseUrl, location.href);
        for (const [k, v] of from.searchParams) if (!to.searchParams.has(k) && !["kind", "tlang", "name", "lang", "fmt"].includes(k)) to.searchParams.set(k, v);
        j = await get(to.href);
      }
    }
    if (!j?.events) return { ...meta, error: "YouTube didn't return the captions" };
    const cues = j.events.filter((e) => e.segs).map((e) => ({ t: (e.tStartMs || 0) / 1000, text: clean(e.segs.map((s) => s.utf8 || "").join("")) }));
    return { ...meta, lang: track.languageCode, langName: track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode, auto: track.kind === "asr", blocks: group(cues) };
  }

  // ---- any <video> with <track> captions ----
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const v = [...document.querySelectorAll("video")].sort((a, b) => area(b) - area(a))[0];
  if (!v) return null;
  const tts = [...v.textTracks].filter((t) => t.kind === "subtitles" || t.kind === "captions");
  if (!tts.length) return null;
  const tt = tts.sort((a, b) => rank(a.language, false) - rank(b.language, false))[0];
  const was = tt.mode;
  if (was === "disabled") tt.mode = "hidden"; // cues only load once the track is switched on
  for (let i = 0; i < 12 && !tt.cues?.length; i++) await sleep(250);
  const cues = [...(tt.cues || [])].map((c) => ({ t: c.startTime, text: clean(c.text) }));
  tt.mode = was;
  const meta = { site: "html5", title: document.title, author: "", duration: Math.round(v.duration) || 0 };
  if (!cues.length) return { ...meta, error: "the video's captions didn't load" };
  return { ...meta, lang: tt.language || "", langName: tt.label || tt.language || "", auto: false, blocks: group(cues) };
}

// Jump the page's main video to a moment and play from there.
export function seekVideo(seconds) {
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const v = [...document.querySelectorAll("video")].sort((a, b) => area(b) - area(a))[0];
  if (!v) return false;
  v.currentTime = seconds;
  v.play?.()?.catch?.(() => {});
  const r = v.getBoundingClientRect();
  if (r.bottom < 80 || r.top > innerHeight - 80) v.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
