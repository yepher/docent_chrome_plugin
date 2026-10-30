// Can this computer run LFM3-Omni? assess() turns what the browser reports into reasons a
// person can act on, before anything is downloaded. Used by the worker (GPU and disk) and
// lfm.js (which adds the CPU and memory, known only to extension pages).
//
// The numbers are measured on the q4f16 decoder: its largest GPU buffer is 262,144,000 bytes,
// and it fails on its first run without shader-f16. Loading uses about 1.7 GB of GPU memory
// plus a 1.4 GB copy of the weights in JavaScript. WebGPU doesn't report GPU memory, so
// system memory is the only guide (it's all one pool on integrated GPUs and Apple Silicon).

const GB = 1e9, GIB = 2 ** 30, BUFFER_NEEDED = 262144000;
const BLOCK_BELOW_MEMORY = 6 * GIB, WARN_BELOW_MEMORY = 10 * GIB;

const diskText = (n) => `${+(n / GB).toFixed(1)} GB`;
const memoryText = (n) => `${Math.round(n / GIB)} GB`; // memory is sold in binary gigabytes
const gpuName = (f) => f.description || [f.vendor, f.architecture].filter(Boolean).join(" ") || "your GPU";

export function assess(f) {
  const problems = [], warnings = [];
  if (!f.webgpu) {
    problems.push("This browser doesn't offer WebGPU. Use Chrome or Edge 113 or newer, and check that WebGPU isn't turned off in chrome://flags or by your organization.");
  } else if (!f.adapter) {
    problems.push("Chrome couldn't find a GPU it can use. Turn on \"Use graphics acceleration when available\" in Chrome's System settings and update your graphics driver. chrome://gpu shows what's blocked.");
  } else if (f.software) {
    problems.push(`WebGPU is running in software on the CPU (${gpuName(f)}), not on a GPU, which is too slow for this model. Turn on graphics acceleration in Chrome's System settings; chrome://gpu shows what's blocked.`);
  } else {
    if (!f.shaderF16) problems.push(`${gpuName(f)} doesn't support 16-bit numbers in shaders (shader-f16), which this model needs. Updating the graphics driver may help.`);
    const buffer = Math.min(f.maxBufferSize, f.maxStorageBufferBindingSize);
    if (buffer < BUFFER_NEEDED) problems.push(`${gpuName(f)} allows GPU buffers of ${Math.round(buffer / 1048576)} MB, and this model needs 250 MB.`);
  }
  if (f.memoryBytes && f.memoryBytes < BLOCK_BELOW_MEMORY) problems.push(`This computer has ${memoryText(f.memoryBytes)} of memory, and the model needs about 3 GB free while it loads, which won't fit alongside the system and browser. At least 8 GB is recommended.`);
  else if (f.memoryBytes && f.memoryBytes < WARN_BELOW_MEMORY) warnings.push(`This computer has ${memoryText(f.memoryBytes)} of memory, so close other apps if the model fails to load.`);
  if (f.freeBytes != null && f.freeBytes < f.neededBytes) problems.push(`The model needs ${diskText(f.neededBytes)} of disk space, and the browser has ${diskText(f.freeBytes)} available.`);
  const cpu = f.cpuModel ? `${f.cpuModel}${f.cpuCores ? `, ${f.cpuCores} cores` : ""}` : "";
  const parts = [cpu, f.memoryBytes ? `${memoryText(f.memoryBytes)} memory` : "", f.adapter ? `GPU: ${gpuName(f)}` : ""];
  return { ok: !problems.length, problems, warnings, summary: parts.filter(Boolean).join(" · ") };
}
