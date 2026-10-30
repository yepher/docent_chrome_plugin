// The offscreen document holds everything a service worker can't: audio, the mic, the
// clipboard and the workers that run models in the browser.

export async function ensureOffscreen() {
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (has) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "USER_MEDIA", "WORKERS", "CLIPBOARD"],
      justification: "Play text-to-speech, capture the microphone for voice questions, run the in-browser Laya and LFM3-Omni models in workers, and read or write the clipboard when you ask.",
    });
  } catch (e) {
    if (!/single offscreen|already/i.test(e.message)) throw e;
  }
}
