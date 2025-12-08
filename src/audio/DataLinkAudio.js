import {
  audioContext,
  getMasterVolume,
  isAudioPaused,
} from "./audioContext.js";

const PENTATONIC = [0, 2, 4, 7, 9, 12];
const ROOT_FREQ = 220;

function freqFromDegree(degree, octaveShift = 0) {
  const semitones =
    PENTATONIC[degree % PENTATONIC.length] +
    Math.floor(degree / PENTATONIC.length) * 12 +
    octaveShift * 12;
  return ROOT_FREQ * Math.pow(2, semitones / 12);
}

export class DataLinkAudio {
  constructor() {
    this.isActive = false;
    this.masterGain = null;
    this.buildupOsc = null;
    this.buildupGain = null;
    this.buildupFilter = null;
    this.sparkleNoise = null;
    this.sparkleFilter = null;
    this.sparkleGain = null;
    this.harmonicOscs = [];
    this.harmonicGains = [];
    this.lastProgress = 0;
    this._cleanupTimeoutId = null;
  }

  _createNoiseBuffer(duration = 2) {
    const sampleRate = audioContext.sampleRate;
    const bufferSize = sampleRate * duration;
    const buffer = audioContext.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  start() {
    if (this.isActive || isAudioPaused()) return;

    // Cancel any pending cleanup and run it now to ensure clean state
    if (this._cleanupTimeoutId) {
      clearTimeout(this._cleanupTimeoutId);
      this._cleanupTimeoutId = null;
      this._cleanup();
    }

    this.isActive = true;
    this.lastProgress = 0;

    const now = audioContext.currentTime;
    const vol = getMasterVolume();

    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.connect(audioContext.destination);

    // Main buildup tone - starts low, rises with progress
    this.buildupOsc = audioContext.createOscillator();
    this.buildupOsc.type = "sine";
    this.buildupOsc.frequency.setValueAtTime(freqFromDegree(0, 0), now);

    this.buildupFilter = audioContext.createBiquadFilter();
    this.buildupFilter.type = "lowpass";
    this.buildupFilter.frequency.setValueAtTime(400, now);
    this.buildupFilter.Q.setValueAtTime(2, now);

    this.buildupGain = audioContext.createGain();
    this.buildupGain.gain.setValueAtTime(0, now);

    this.buildupOsc.connect(this.buildupFilter);
    this.buildupFilter.connect(this.buildupGain);
    this.buildupGain.connect(this.masterGain);
    this.buildupOsc.start(now);

    // Harmonic overtones that fade in as we get closer
    [1.5, 2, 3].forEach((mult, i) => {
      const osc = audioContext.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freqFromDegree(0, 0) * mult, now);

      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(0, now);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(now);

      this.harmonicOscs.push(osc);
      this.harmonicGains.push(gain);
    });

    // High sparkle noise layer
    const buf = this._createNoiseBuffer(2);
    this.sparkleNoise = audioContext.createBufferSource();
    this.sparkleNoise.buffer = buf;
    this.sparkleNoise.loop = true;

    this.sparkleFilter = audioContext.createBiquadFilter();
    this.sparkleFilter.type = "bandpass";
    this.sparkleFilter.frequency.setValueAtTime(3000, now);
    this.sparkleFilter.Q.setValueAtTime(5, now);

    this.sparkleGain = audioContext.createGain();
    this.sparkleGain.gain.setValueAtTime(0, now);

    this.sparkleNoise.connect(this.sparkleFilter);
    this.sparkleFilter.connect(this.sparkleGain);
    this.sparkleGain.connect(this.masterGain);
    this.sparkleNoise.start(now);

    // Fade in master
    this.masterGain.gain.linearRampToValueAtTime(0.7 * vol, now + 0.1);
  }

  update(progress) {
    if (!this.isActive || isAudioPaused()) return;

    // Validate progress - must be a finite number
    if (!Number.isFinite(progress)) {
      return;
    }

    const now = audioContext.currentTime;
    const vol = getMasterVolume();

    // Clamp progress
    progress = Math.max(0, Math.min(1, progress));

    // Main tone rises in pitch and volume
    const baseFreq = freqFromDegree(0, 0);
    const targetFreq = baseFreq * (1 + progress * 1.5); // Rise up to 1.5 octaves

    // Validate targetFreq - must be a finite number
    if (!Number.isFinite(targetFreq)) {
      return;
    }

    if (this.buildupOsc) {
      this.buildupOsc.frequency.setTargetAtTime(targetFreq, now, 0.05);
    }
    if (this.buildupGain) {
      this.buildupGain.gain.setTargetAtTime(0.08 * progress * vol, now, 0.05);
    }
    if (this.buildupFilter) {
      this.buildupFilter.frequency.setTargetAtTime(
        400 + progress * 2000,
        now,
        0.05
      );
    }

    // Harmonics fade in progressively
    this.harmonicGains.forEach((gain, i) => {
      const threshold = 0.3 + i * 0.2; // 0.3, 0.5, 0.7
      const harmonicProgress = Math.max(
        0,
        (progress - threshold) / (1 - threshold)
      );
      gain.gain.setTargetAtTime(0.04 * harmonicProgress * vol, now, 0.05);

      // Also shift harmonic frequencies up
      if (this.harmonicOscs[i]) {
        const mult = [1.5, 2, 3][i];
        this.harmonicOscs[i].frequency.setTargetAtTime(
          targetFreq * mult,
          now,
          0.05
        );
      }
    });

    // Sparkle intensifies as we approach connection
    if (this.sparkleGain) {
      const sparkleIntensity = Math.pow(progress, 2); // Quadratic ramp
      this.sparkleGain.gain.setTargetAtTime(
        0.025 * sparkleIntensity * vol,
        now,
        0.05
      );
    }
    if (this.sparkleFilter) {
      this.sparkleFilter.frequency.setTargetAtTime(
        3000 + progress * 5000,
        now,
        0.05
      );
    }

    this.lastProgress = progress;
  }

  playConnection() {
    if (isAudioPaused()) return;

    const now = audioContext.currentTime;
    const vol = 0.15 * getMasterVolume();

    // Triumphant ascending arpeggio
    const degrees = [0, 2, 4, 5, 7];
    degrees.forEach((deg, i) => {
      const freq = freqFromDegree(deg, 1);
      const osc = audioContext.createOscillator();
      osc.type = "sine";

      const gain = audioContext.createGain();
      const delay = i * 0.05;
      const duration = 0.15 + (degrees.length - i) * 0.03;

      osc.frequency.setValueAtTime(freq, now + delay);
      osc.frequency.linearRampToValueAtTime(
        freq * 1.02,
        now + delay + duration
      );

      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(
        vol * (1 - i * 0.1),
        now + delay + 0.01
      );
      gain.gain.setValueAtTime(
        vol * (1 - i * 0.1),
        now + delay + duration * 0.6
      );
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);

      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start(now + delay);
      osc.stop(now + delay + duration + 0.05);
    });

    // Bright shimmer burst
    const shimmerOsc = audioContext.createOscillator();
    shimmerOsc.type = "triangle";
    shimmerOsc.frequency.setValueAtTime(freqFromDegree(7, 2), now);
    shimmerOsc.frequency.exponentialRampToValueAtTime(
      freqFromDegree(4, 3),
      now + 0.3
    );

    const shimmerGain = audioContext.createGain();
    shimmerGain.gain.setValueAtTime(0, now);
    shimmerGain.gain.linearRampToValueAtTime(vol * 0.6, now + 0.02);
    shimmerGain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(audioContext.destination);
    shimmerOsc.start(now);
    shimmerOsc.stop(now + 0.4);

    // Satisfying "thunk" bass hit
    const bassOsc = audioContext.createOscillator();
    bassOsc.type = "sine";
    bassOsc.frequency.setValueAtTime(freqFromDegree(0, -1), now);
    bassOsc.frequency.exponentialRampToValueAtTime(
      freqFromDegree(0, -2),
      now + 0.15
    );

    const bassGain = audioContext.createGain();
    bassGain.gain.setValueAtTime(vol * 1.2, now);
    bassGain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

    bassOsc.connect(bassGain);
    bassGain.connect(audioContext.destination);
    bassOsc.start(now);
    bassOsc.stop(now + 0.25);
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;

    const now = audioContext.currentTime;

    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, now, 0.05);
    }

    // Cancel any existing cleanup timeout before scheduling new one
    if (this._cleanupTimeoutId) {
      clearTimeout(this._cleanupTimeoutId);
    }
    this._cleanupTimeoutId = setTimeout(() => {
      this._cleanupTimeoutId = null;
      this._cleanup();
    }, 200);
  }

  _cleanup() {
    try {
      if (this.buildupOsc) {
        this.buildupOsc.stop();
        this.buildupOsc = null;
      }
      this.buildupGain = null;
      this.buildupFilter = null;

      this.harmonicOscs.forEach((o) => {
        try {
          o.stop();
        } catch (e) {}
      });
      this.harmonicOscs = [];
      this.harmonicGains = [];

      if (this.sparkleNoise) {
        this.sparkleNoise.stop();
        this.sparkleNoise = null;
      }
      this.sparkleFilter = null;
      this.sparkleGain = null;
      this.masterGain = null;
    } catch (e) {}
  }

  dispose() {
    this.stop();
  }
}
