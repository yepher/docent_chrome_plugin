// LFM3-Omni: the text model that runs on this computer (lfm-worker.js, via the offscreen
// document), as an alternative to LiveKit Inference. Works in the service worker and the popup.

import { ensureOffscreen } from "./offscreen-doc.js";

export const LFM_NAME = "LFM3-Omni-2B";

async function toLfm(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
  if (!res) throw new Error("LFM3-Omni didn't answer (the offscreen document isn't available).");
  if (res.error) throw new Error(res.error);
  return res;
}
export const lfmLoad = async () => (await toLfm({ type: "lfm:load" })).info;
export const lfmStatus = () => toLfm({ type: "lfm:status" });
export const lfmClear = () => toLfm({ type: "lfm:clear" });

// Same contract as LiveKit's chat(): onDelta(textSoFar) as tokens arrive, returns the full
// text, and a stop rejects with an AbortError like fetch.
export async function lfmChat(messages, { onDelta, signal, maxTokens = 800 } = {}) {
  const aborted = () => new DOMException("Stopped", "AbortError");
  if (signal?.aborted) throw aborted();
  const reqId = crypto.randomUUID();
  const onMessage = (m) => { if (m?.type === "lfm:delta" && m.reqId === reqId) onDelta?.(m.text); };
  const abort = () => toLfm({ type: "lfm:abort", reqId }).catch(() => {});
  chrome.runtime.onMessage.addListener(onMessage);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const res = await toLfm({ type: "lfm:chat", reqId, messages, maxTokens });
    if (res.aborted) throw aborted();
    return res.text;
  } finally {
    chrome.runtime.onMessage.removeListener(onMessage);
    signal?.removeEventListener("abort", abort);
  }
}
