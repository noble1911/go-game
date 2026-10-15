// Stone sounds, synthesised with Web Audio: a short wooden click, and a rattle for captures.
let ctx = null;
let muted = false;

try {
  muted = localStorage.getItem('go.muted') === '1';
} catch {}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem('go.muted', value ? '1' : '0');
  } catch {}
}

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function click(at, gain = 0.6, pitch = 1) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  // A knock: a fast-decaying low sine plus a burst of filtered noise.
  const osc = a.createOscillator();
  const og = a.createGain();
  osc.frequency.setValueAtTime(420 * pitch, t);
  osc.frequency.exponentialRampToValueAtTime(140 * pitch, t + 0.08);
  og.gain.setValueAtTime(gain, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(og).connect(a.destination);
  osc.start(t);
  osc.stop(t + 0.12);

  const len = Math.floor(a.sampleRate * 0.03);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 2400 * pitch;
  filter.Q.value = 1.2;
  const ng = a.createGain();
  ng.gain.value = gain * 0.9;
  noise.connect(filter).connect(ng).connect(a.destination);
  noise.start(t);
}

export function playStone(captured = 0) {
  if (muted) return;
  click(0);
  for (let i = 0; i < Math.min(captured, 6); i++) click(0.09 + i * 0.05, 0.25, 1.4 + Math.random() * 0.3);
}

// Browsers only allow audio after a user gesture: call this from the first tap.
export function unlockAudio() {
  if (!muted) audio();
}
