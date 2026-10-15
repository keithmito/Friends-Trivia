// Tiny sound effects made with the Web Audio API — no audio files to download.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('ft-muted') === '1'; } catch { /* storage blocked */ }

// Browsers only allow sound after the person taps something; call this on taps.
export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem('ft-muted', m ? '1' : '0'); } catch { /* ignore */ }
}

function buzz(pattern) {
  if (!muted) navigator.vibrate?.(pattern);
}

function tone(freq, { at = 0, dur = 0.12, type = 'sine', vol = 0.18, slideTo = null } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noiseHit(at, vol = 0.25, dur = 0.06) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + at;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 900;
  const gain = ctx.createGain();
  gain.gain.value = vol;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(t);
}

export const sfx = {
  // Last 5 seconds: a tick each second, higher pitch for the final 2.
  tick(secondsLeft) {
    tone(secondsLeft <= 2 ? 1320 : 990, { dur: 0.05, type: 'square', vol: 0.08 });
    if (secondsLeft <= 3) buzz(15);
  },
  lockIn() {
    tone(520, { dur: 0.08, type: 'triangle', vol: 0.12 });
  },
  correct() {
    tone(660, { dur: 0.12, type: 'triangle' });
    tone(880, { at: 0.1, dur: 0.12, type: 'triangle' });
    tone(1320, { at: 0.2, dur: 0.22, type: 'triangle' });
    buzz(40);
  },
  wrong() {
    tone(220, { dur: 0.35, type: 'sawtooth', vol: 0.1, slideTo: 140 });
    buzz([80, 60, 80]);
  },
  join() {
    tone(740, { dur: 0.07, type: 'sine', vol: 0.1 });
    tone(990, { at: 0.07, dur: 0.09, type: 'sine', vol: 0.1 });
  },
  // About 2 seconds of snare rolling faster and faster, then a crash.
  drumroll(ms = 2200) {
    if (!ctx || muted) return;
    const total = ms / 1000;
    let t = 0;
    let gap = 0.09;
    while (t < total - 0.25) {
      noiseHit(t, 0.12 + 0.18 * (t / total));
      t += gap;
      gap = Math.max(0.035, gap * 0.96);
    }
    noiseHit(total - 0.2, 0.45, 0.4);
    tone(196, { at: total - 0.2, dur: 0.5, type: 'triangle', vol: 0.2 });
    tone(392, { at: total - 0.2, dur: 0.6, type: 'triangle', vol: 0.15 });
    buzz([30, 40, 30, 40, 30, 40, 200]);
  },
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.11, dur: 0.18, type: 'triangle', vol: 0.15 }));
  },
};
