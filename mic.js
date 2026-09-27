const status = (t) => (document.getElementById("status").textContent = t);
document.getElementById("allow").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status("Thanks! You can close this tab and click the mic in Jev again.");
    chrome.runtime.sendMessage({ type: "voice:micGranted" }).catch(() => {});
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    status(e.name === "NotAllowedError"
      ? "Chrome blocked the microphone. Click the icon at the left of the address bar, allow Microphone, then try again."
      : `Couldn't open the microphone: ${e.message}`);
  }
};
