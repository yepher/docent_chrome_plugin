// The signal processing around LFM3-Omni's speech models: log-mel features for what it hears
// (ported from feature_extraction_lfm3_omni.py) and an inverse STFT for what it says
// (modeling_liquid_codec.py). The model's sizes aren't powers of two, so the FFT is mixed-radix.

function fft(re, im, inverse) {
  const n = re.length;
  if (n === 1) return [re, im];
  const p = n % 2 === 0 ? 2 : n % 5 === 0 ? 5 : n, m = n / p, sign = inverse ? 1 : -1;
  const subs = [];
  for (let k = 0; k < p; k++) {
    const r = new Float64Array(m), i = new Float64Array(m);
    for (let j = 0; j < m; j++) { r[j] = re[j * p + k]; i[j] = im[j * p + k]; }
    subs.push(fft(r, i, inverse));
  }
  const R = new Float64Array(n), I = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let a = 0, b = 0;
    for (let k = 0; k < p; k++) {
      const w = (sign * 2 * Math.PI * k * t) / n, c = Math.cos(w), s = Math.sin(w), x = subs[k][0][t % m], y = subs[k][1][t % m];
      a += x * c - y * s;
      b += x * s + y * c;
    }
    R[t] = a; I[t] = b;
  }
  return [R, I];
}
const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

// ---------- hearing: 16 kHz samples to 128 log-mel bands ----------
const MEL_BANDS = 128, MEL_FFT = 400, MEL_HOP = 160, MEL_BINS = MEL_FFT / 2 + 1, MEL_RATE = 16000;
let melBank = null;
function melFilters() {
  if (melBank) return melBank;
  const mel = (f) => (f < 1000 ? (3 * f) / 200 : 15 + (27 * Math.log(f / 1000)) / Math.log(6.4));
  const hz = (m) => (m < 15 ? (200 * m) / 3 : 1000 * 6.4 ** ((m - 15) / 27));
  const top = mel(MEL_RATE / 2), pts = Array.from({ length: MEL_BANDS + 2 }, (_, i) => hz((top * i) / (MEL_BANDS + 1)));
  melBank = Array.from({ length: MEL_BANDS }, (_, m) => {
    const f = new Float64Array(MEL_BINS), norm = 2 / (pts[m + 2] - pts[m]);
    for (let b = 0; b < MEL_BINS; b++) {
      const at = (b * (MEL_RATE / 2)) / (MEL_BINS - 1);
      f[b] = norm * Math.max(0, Math.min((at - pts[m]) / (pts[m + 1] - pts[m]), (pts[m + 2] - at) / (pts[m + 2] - pts[m + 1])));
    }
    return f;
  });
  return melBank;
}

export function logMel(pcm) {
  const n = pcm.length < MEL_FFT ? MEL_FFT : pcm.length + (((-(pcm.length - MEL_FFT) % MEL_HOP) + MEL_HOP) % MEL_HOP);
  const x = new Float32Array(n);
  x.set(pcm);
  const frames = 1 + (n - MEL_FFT) / MEL_HOP, win = hann(MEL_FFT), bank = melFilters(), out = new Float32Array(MEL_BANDS * frames);
  for (let f = 0; f < frames; f++) {
    const re = new Float64Array(MEL_FFT);
    for (let i = 0; i < MEL_FFT; i++) re[i] = x[f * MEL_HOP + i] * win[i];
    const [R, I] = fft(re, new Float64Array(MEL_FFT));
    for (let m = 0; m < MEL_BANDS; m++) {
      let sum = 0;
      for (let k = 0; k < MEL_BINS; k++) sum += bank[m][k] * (R[k] * R[k] + I[k] * I[k]);
      out[m * frames + f] = (Math.max(-12, Math.log10(sum)) + 4) / 4;
    }
  }
  return { data: out, frames };
}

// ---------- speaking: STFT features to 24 kHz samples, a chunk at a time ----------
const STFT_FFT = 1280, STFT_HOP = 320, STFT_BINS = STFT_FFT / 2 + 1, STFT_TRIM = 480;
const WINDOW = hann(STFT_FFT);

export class Istft {
  constructor(maxFrames) {
    const len = maxFrames * STFT_HOP + STFT_FFT;
    this.audio = new Float64Array(len);
    this.envelope = new Float64Array(len);
    this.done = 0;   // STFT frames added
    this.sent = STFT_TRIM;   // the first samples are only half covered by frames
  }

  // features: [frames, 1282], log magnitude then angle. Adds the frames not seen yet and
  // returns the samples no later frame can change (final: everything left).
  push(features, frames, final) {
    for (let f = this.done; f < frames; f++) {
      const off = f * 2 * STFT_BINS, re = new Float64Array(STFT_FFT), im = new Float64Array(STFT_FFT);
      for (let k = 0; k < STFT_BINS; k++) {
        const m = Math.exp(features[off + k]), a = features[off + STFT_BINS + k];
        re[k] = m * Math.cos(a);
        im[k] = m * Math.sin(a);
        if (k && k < STFT_FFT / 2) { re[STFT_FFT - k] = re[k]; im[STFT_FFT - k] = -im[k]; }
      }
      const [x] = fft(re, im, true);
      for (let i = 0; i < STFT_FFT; i++) {
        this.audio[f * STFT_HOP + i] += (x[i] / STFT_FFT) * WINDOW[i];
        this.envelope[f * STFT_HOP + i] += WINDOW[i] * WINDOW[i];
      }
    }
    this.done = Math.max(this.done, frames);
    const end = final ? (this.done - 1) * STFT_HOP + STFT_FFT - STFT_TRIM : this.done * STFT_HOP;
    const pcm = new Int16Array(Math.max(0, end - this.sent));
    for (let i = 0; i < pcm.length; i++) {
      const v = this.audio[this.sent + i] / this.envelope[this.sent + i];
      pcm[i] = Math.max(-1, Math.min(1, v)) * 32767;
    }
    this.sent += pcm.length;
    return pcm;
  }
}
