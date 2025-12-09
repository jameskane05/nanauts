import {
  audioContext,
  createPanner,
  getMasterVolume,
  isAudioPaused,
} from "./audioContext.js";

export class RobotEngine {
  constructor(pitchOffset = 0) {
    // Convert semitones to frequency multiplier
    this.pitchMultiplier = Math.pow(2, pitchOffset / 12);
    this.baseFreq = 180 * this.pitchMultiplier;

    this.oscillator = audioContext.createOscillator();
    this.oscillator.type = "sine";
    this.oscillator.frequency.setValueAtTime(this.baseFreq, 0);

    this.lfo = audioContext.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.setValueAtTime(8, 0);

    this.modGain = audioContext.createGain();
    this.modGain.gain.setValueAtTime(4, 0);

    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0, 0);

    this.panner = createPanner();

    this.lfo.connect(this.modGain);
    this.modGain.connect(this.oscillator.frequency);

    this.oscillator.connect(this.masterGain);
    this.masterGain.connect(this.panner);
    this.panner.connect(audioContext.destination);

    this.oscillator.start();
    this.lfo.start();

    this.isRunning = true;
    this._targetVolume = 0;
    this._isPaused = false;
  }

  setPosition(x, y, z) {
    if (!this.isRunning) return;
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(x, audioContext.currentTime);
      this.panner.positionY.setValueAtTime(y, audioContext.currentTime);
      this.panner.positionZ.setValueAtTime(z, audioContext.currentTime);
    } else {
      this.panner.setPosition(x, y, z);
    }
  }

  setVolume(percent) {
    if (!this.isRunning) return;
    this._targetVolume =
      Math.max(0, Math.min(1, percent)) * 0.12 * getMasterVolume();
    if (!this._isPaused && !isAudioPaused()) {
      this.masterGain.gain.setTargetAtTime(
        this._targetVolume,
        audioContext.currentTime,
        0.1
      );
    }
  }

  pause() {
    if (!this.isRunning || this._isPaused) return;
    this._isPaused = true;
    this.masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.05);
  }

  resume() {
    if (!this.isRunning || !this._isPaused) return;
    this._isPaused = false;
    this.masterGain.gain.setTargetAtTime(
      this._targetVolume,
      audioContext.currentTime,
      0.1
    );
  }

  setPitch(percent) {
    if (!this.isRunning) return;
    const p = Math.max(0, Math.min(1, percent));
    const freq = this.baseFreq + p * (100 * this.pitchMultiplier);
    const lfoFreq = 8 + p * 7;
    const modDepth = 4 + p * 4;

    this.oscillator.frequency.setTargetAtTime(
      freq,
      audioContext.currentTime,
      0.1
    );
    this.lfo.frequency.setTargetAtTime(lfoFreq, audioContext.currentTime, 0.1);
    this.modGain.gain.setTargetAtTime(modDepth, audioContext.currentTime, 0.1);
  }

  setSpeedAndAcceleration(speed, maxSpeed, isJumping = false) {
    const speedPercent = Math.abs(speed) / maxSpeed;

    if (speedPercent < 0.1 && !isJumping) {
      this.setVolume(0);
      return;
    }

    if (isJumping) {
      this.setPitch(Math.min(1, speedPercent + 0.3));
      this.setVolume(0.4);
    } else {
      this.setPitch(speedPercent);
      this.setVolume(speedPercent * 0.5);
    }
  }

  stop() {
    if (!this.isRunning) return;
    this.masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.05);
    setTimeout(() => {
      try {
        this.oscillator.stop();
        this.lfo.stop();
      } catch (e) {}
      this.isRunning = false;
    }, 100);
  }
}
