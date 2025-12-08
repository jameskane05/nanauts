import { audioContext, createPanner, getMasterVolume } from "./audioContext.js";

export class RobotScanner {
  constructor() {
    this.isScanning = false;
    this.panner = createPanner();
    this.panner.connect(audioContext.destination);

    this.masterGain = null;
    this.beepOsc = null;

    this._intervalId = null;
    this._startTime = 0;
    this._lastBeepTime = 0;
    this._beepIndex = 0;

    // Happy electronic beep parameters
    this.baseFreq = 800; // Higher base = brighter/happier
    // Major pentatonic intervals for happy sound
    this.beepNotes = [1, 1.125, 1.25, 1.5, 1.667, 2]; // C, D, E, G, A, C (octave)
  }

  setPosition(x, y, z) {
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(x, audioContext.currentTime);
      this.panner.positionY.setValueAtTime(y, audioContext.currentTime);
      this.panner.positionZ.setValueAtTime(z, audioContext.currentTime);
    } else {
      this.panner.setPosition(x, y, z);
    }
  }

  start() {
    if (this.isScanning) return;
    this.isScanning = true;

    const now = audioContext.currentTime;
    this._startTime = now;
    this._lastBeepTime = now;
    this._beepIndex = 0;

    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.connect(this.panner);

    // Fade in
    this.masterGain.gain.linearRampToValueAtTime(1.0, now + 0.05);

    // Play initial "hello!" rising beep sequence
    this._playStartBeeps(now);

    // Start the beep loop
    this._animateBeeps();
  }

  _playStartBeeps(startTime) {
    const masterVolume = getMasterVolume();
    const vol = 0.08 * masterVolume;

    // Quick ascending "boop-boop-beep!"
    const notes = [this.baseFreq, this.baseFreq * 1.25, this.baseFreq * 1.5];
    notes.forEach((freq, i) => {
      const t = startTime + i * 0.08;
      this._playBeep(freq, t, 0.06, vol);
    });
  }

  _playBeep(freq, startTime, duration, volume) {
    const osc = audioContext.createOscillator();
    osc.type = "square"; // Electronic/robotic character
    osc.frequency.setValueAtTime(freq, startTime);

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, startTime);
    // Quick attack, short sustain, quick release
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
    gain.gain.setValueAtTime(volume * 0.7, startTime + duration * 0.3);
    gain.gain.linearRampToValueAtTime(0, startTime + duration);

    osc.connect(gain);
    gain.connect(this.masterGain);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  _playDoubleBeep(freq1, freq2, startTime, volume) {
    // Quick two-note chirp like R2D2
    this._playBeep(freq1, startTime, 0.05, volume);
    this._playBeep(freq2, startTime + 0.06, 0.05, volume);
  }

  _animateBeeps() {
    if (!this.isScanning) return;

    // Use setInterval for XR compatibility (regular rAF doesn't fire in XR)
    this._intervalId = setInterval(() => {
      if (!this.isScanning) {
        clearInterval(this._intervalId);
        this._intervalId = null;
        return;
      }

      const now = audioContext.currentTime;
      const masterVolume = getMasterVolume();
      const vol = 0.06 * masterVolume;

      // Play beeps at varying intervals (faster = more excited scanning)
      const beepInterval = 0.18 + Math.random() * 0.15;

      if (now - this._lastBeepTime >= beepInterval) {
        this._lastBeepTime = now;

        // Pick a random pattern
        const pattern = Math.random();
        const noteIdx = this._beepIndex % this.beepNotes.length;
        const freq = this.baseFreq * this.beepNotes[noteIdx];

        if (pattern < 0.4) {
          // Single beep at current note
          this._playBeep(freq, now, 0.08, vol);
        } else if (pattern < 0.7) {
          // Rising double beep (curious "hmm?")
          const nextFreq =
            this.baseFreq *
            this.beepNotes[(noteIdx + 2) % this.beepNotes.length];
          this._playDoubleBeep(freq, nextFreq, now, vol);
        } else if (pattern < 0.85) {
          // Descending double beep (acknowledging "uh-huh")
          const prevFreq =
            this.baseFreq *
            this.beepNotes[
              (noteIdx + this.beepNotes.length - 1) % this.beepNotes.length
            ];
          this._playDoubleBeep(freq, prevFreq, now, vol);
        } else {
          // Triple excited beep
          const mid =
            this.baseFreq *
            this.beepNotes[(noteIdx + 1) % this.beepNotes.length];
          const high =
            this.baseFreq *
            this.beepNotes[(noteIdx + 3) % this.beepNotes.length];
          this._playBeep(freq, now, 0.04, vol);
          this._playBeep(mid, now + 0.05, 0.04, vol);
          this._playBeep(high, now + 0.1, 0.06, vol);
        }

        this._beepIndex++;
      }
    }, 50); // Check every 50ms
  }

  stop() {
    if (!this.isScanning) return;
    this.isScanning = false;

    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }

    const now = audioContext.currentTime;
    const masterVolume = getMasterVolume();
    const vol = 0.07 * masterVolume;

    // Play "done!" descending flourish
    const notes = [this.baseFreq * 1.5, this.baseFreq * 1.25, this.baseFreq];
    notes.forEach((freq, i) => {
      this._playBeep(freq, now + i * 0.07, 0.06, vol);
    });

    // Fade out master
    if (this.masterGain) {
      this.masterGain.gain.linearRampToValueAtTime(0, now + 0.35);
    }

    // Clean up after fade
    setTimeout(() => {
      this.masterGain = null;
    }, 400);
  }
}
