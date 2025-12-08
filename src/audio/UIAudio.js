import { audioContext, getMasterVolume } from "./audioContext.js";

const UI_VOLUME_SCALE = 0.6;

const PENTATONIC = [0, 2, 4, 7, 9, 12];
const ROOT_FREQ = 440;

function freqFromDegree(degree, octaveShift = 0) {
  const semitones =
    PENTATONIC[degree % PENTATONIC.length] +
    Math.floor(degree / PENTATONIC.length) * 12 +
    octaveShift * 12;
  return ROOT_FREQ * Math.pow(2, semitones / 12);
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class UIAudioManager {
  constructor() {
    this._lastPlayTime = 0;
    this._minInterval = 30;
  }

  _canPlay() {
    const now = performance.now();
    if (now - this._lastPlayTime < this._minInterval) return false;
    this._lastPlayTime = now;
    return true;
  }

  _playTone(
    frequency,
    duration,
    delay = 0,
    volume = 0.1,
    type = "sine",
    pitchBend = 0
  ) {
    const osc = audioContext.createOscillator();
    osc.type = type;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, 0);

    const finalVolume = volume * getMasterVolume() * UI_VOLUME_SCALE;

    osc.connect(gain);
    gain.connect(audioContext.destination);

    const startTime = audioContext.currentTime + delay;
    const endTime = startTime + duration;

    osc.frequency.setValueAtTime(frequency, startTime);
    if (pitchBend !== 0) {
      osc.frequency.linearRampToValueAtTime(frequency + pitchBend, endTime);
    }

    // Soft attack/release envelope
    const attackTime = Math.min(0.02, duration * 0.15);
    const releaseTime = Math.min(0.04, duration * 0.3);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(finalVolume, startTime + attackTime);
    gain.gain.setValueAtTime(finalVolume, endTime - releaseTime);
    gain.gain.exponentialRampToValueAtTime(0.001, endTime);

    osc.start(startTime);
    osc.stop(endTime + 0.01);
  }

  _playFilteredTone(
    frequency,
    duration,
    delay = 0,
    volume = 0.1,
    filterFreq = 2000
  ) {
    const osc = audioContext.createOscillator();
    osc.type = "triangle";

    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;
    filter.Q.value = 1;

    const gain = audioContext.createGain();
    const finalVolume = volume * getMasterVolume() * UI_VOLUME_SCALE;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);

    const startTime = audioContext.currentTime + delay;
    const endTime = startTime + duration;

    osc.frequency.setValueAtTime(frequency, startTime);

    const attackTime = Math.min(0.015, duration * 0.1);
    const releaseTime = Math.min(0.05, duration * 0.35);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(finalVolume, startTime + attackTime);
    gain.gain.setValueAtTime(finalVolume * 0.8, endTime - releaseTime);
    gain.gain.exponentialRampToValueAtTime(0.001, endTime);

    osc.start(startTime);
    osc.stop(endTime + 0.01);
  }

  hover() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(pick([2, 3, 4]), 1);
    this._playFilteredTone(freq, 0.06, 0, 0.05, 1800);
  }

  press() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(pick([0, 2, 4]), 0);
    this._playTone(freq, 0.08, 0, 0.12, "sine", 15);
    this._playTone(freq * 2, 0.06, 0.005, 0.04, "sine", 10);
  }

  release() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(pick([3, 4, 5]), 1);
    this._playFilteredTone(freq, 0.05, 0, 0.06, 1500);
  }

  confirm() {
    if (!this._canPlay()) return;
    const baseFreq = freqFromDegree(0, 0);
    this._playTone(baseFreq, 0.1, 0, 0.1, "sine", 0);
    this._playTone(baseFreq * 1.5, 0.1, 0.08, 0.1, "sine", 20);
    this._playTone(baseFreq * 2, 0.15, 0.16, 0.08, "sine", 30);
  }

  cancel() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(3, 0);
    this._playTone(freq, 0.12, 0, 0.1, "sine", -40);
    this._playTone(freq * 0.75, 0.15, 0.08, 0.08, "triangle", -30);
  }

  toggle(enabled = true) {
    if (!this._canPlay()) return;
    if (enabled) {
      const freq = freqFromDegree(2, 0);
      this._playTone(freq, 0.06, 0, 0.1, "sine", 30);
      this._playTone(freq * 1.25, 0.08, 0.05, 0.08, "sine", 20);
    } else {
      const freq = freqFromDegree(4, 0);
      this._playTone(freq, 0.06, 0, 0.1, "sine", -20);
      this._playTone(freq * 0.8, 0.08, 0.05, 0.08, "sine", -15);
    }
  }

  error() {
    if (!this._canPlay()) return;
    const freq = 280;
    this._playTone(freq, 0.1, 0, 0.12, "triangle", 0);
    this._playTone(freq * 0.9, 0.12, 0.12, 0.1, "triangle", -10);
  }

  notification() {
    if (!this._canPlay()) return;
    const baseFreq = freqFromDegree(4, 1);
    this._playTone(baseFreq, 0.08, 0, 0.08, "sine", 0);
    this._playTone(baseFreq * 1.2, 0.1, 0.1, 0.07, "sine", 15);
    this._playTone(baseFreq, 0.06, 0.22, 0.05, "sine", 0);
  }

  panelOpen() {
    if (!this._canPlay()) return;
    const degrees = [0, 2, 4];
    degrees.forEach((deg, i) => {
      const freq = freqFromDegree(deg, 0);
      this._playFilteredTone(freq, 0.08, i * 0.04, 0.08, 2200);
    });
  }

  panelClose() {
    if (!this._canPlay()) return;
    const degrees = [4, 2, 0];
    degrees.forEach((deg, i) => {
      const freq = freqFromDegree(deg, 0);
      this._playFilteredTone(freq, 0.06, i * 0.035, 0.07, 1800);
    });
  }

  callRing() {
    if (!this._canPlay()) return;
    const freq1 = freqFromDegree(4, 1);
    const freq2 = freqFromDegree(2, 1);
    this._playTone(freq1, 0.12, 0, 0.1, "sine", 0);
    this._playTone(freq2, 0.12, 0.15, 0.1, "sine", 0);
    this._playTone(freq1, 0.12, 0.3, 0.1, "sine", 0);
  }

  callAnswer() {
    if (!this._canPlay()) return;
    const degrees = [0, 2, 4, 5];
    degrees.forEach((deg, i) => {
      const freq = freqFromDegree(deg, 0);
      this._playTone(freq, 0.1 + i * 0.02, i * 0.06, 0.09, "sine", 20);
    });
  }

  callEnd() {
    if (!this._canPlay()) return;
    const degrees = [5, 4, 2, 0];
    degrees.forEach((deg, i) => {
      const freq = freqFromDegree(deg, 0);
      this._playTone(
        freq,
        0.1 - i * 0.01,
        i * 0.07,
        0.08 - i * 0.01,
        "sine",
        -15
      );
    });
  }

  voiceStart() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(0, 1);
    this._playTone(freq, 0.15, 0, 0.1, "sine", 60);
    this._playTone(freq * 1.5, 0.12, 0.02, 0.06, "sine", 40);
  }

  voiceStop() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(4, 1);
    this._playTone(freq, 0.1, 0, 0.08, "sine", -30);
    this._playTone(freq * 0.75, 0.12, 0.06, 0.05, "sine", -20);
  }

  success() {
    if (!this._canPlay()) return;
    const baseFreq = freqFromDegree(0, 0);
    this._playTone(baseFreq, 0.1, 0, 0.1, "sine", 0);
    this._playTone(baseFreq * 1.25, 0.1, 0.08, 0.1, "sine", 0);
    this._playTone(baseFreq * 1.5, 0.12, 0.16, 0.1, "sine", 0);
    this._playTone(baseFreq * 2, 0.18, 0.26, 0.08, "sine", 40);
  }

  scoreUp() {
    if (!this._canPlay()) return;
    const baseFreq = freqFromDegree(2, 1);
    this._playTone(baseFreq, 0.06, 0, 0.1, "sine", 30);
    this._playTone(baseFreq * 1.33, 0.08, 0.05, 0.08, "sine", 25);
    this._playTone(baseFreq * 1.5, 0.1, 0.11, 0.06, "sine", 20);
  }

  tick() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(pick([0, 2, 4]), 1);
    this._playFilteredTone(freq, 0.03, 0, 0.04, 1200);
  }

  subtle() {
    if (!this._canPlay()) return;
    const freq = freqFromDegree(pick([2, 3, 4]), 1);
    this._playFilteredTone(freq, 0.04, 0, 0.03, 1000);
  }
}

export const uiAudio = new UIAudioManager();
