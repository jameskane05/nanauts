import {
  audioContext,
  createPanner,
  getMasterVolume,
  isAudioPaused,
} from "./audioContext.js";

export class PortalAudio {
  constructor() {
    this.isActive = false;
    this.panner = createPanner();
    this.panner.connect(audioContext.destination);
    this.position = { x: 0, y: 0, z: 0 };
    this.rumbleOsc = null;
    this.rumbleLfo = null;
    this.rumbleGain = null;
    this.harmonicOscs = [];
    this.harmonicGains = [];
    this.harmonicLfos = [];
    this.sparkleNoise = null;
    this.sparkleFilter = null;
    this.sparkleGain = null;
    this.sparkleLfo = null;
    this.whooshNoise = null;
    this.whooshFilter = null;
    this.whooshGain = null;
    this.delayNode = null;
    this.delayGain = null;
    this.masterGain = null;
    this.currentPhase = null;
    this.lastRobotSpawned = -1;
    this.warpShotInterval = null;
    this.lastProgress = 0;
  }

  setPosition(x, y, z) {
    this.position = { x, y, z };
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(x, audioContext.currentTime);
      this.panner.positionY.setValueAtTime(y, audioContext.currentTime);
      this.panner.positionZ.setValueAtTime(z, audioContext.currentTime);
    } else {
      this.panner.setPosition(x, y, z);
    }
  }

  _createNoiseBuffer(duration = 2, type = "white") {
    const sampleRate = audioContext.sampleRate;
    const bufferSize = sampleRate * duration;
    const buffer = audioContext.createBuffer(1, bufferSize, sampleRate);
    const data = buffer.getChannelData(0);
    if (type === "white") {
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    } else if (type === "pink") {
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }
    return buffer;
  }

  playPlacement() {
    if (isAudioPaused()) return;
    const now = audioContext.currentTime;
    const vol = 0.05 * getMasterVolume();
    const osc = audioContext.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.2);
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.02);
    gain.gain.setValueAtTime(vol, now + 0.1);
    gain.gain.linearRampToValueAtTime(0, now + 0.2);
    osc.connect(gain);
    gain.connect(this.panner);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  startEntrance() {
    if (this.isActive || isAudioPaused()) return;
    this.isActive = true;
    this.currentPhase = "opening";
    this.lastRobotSpawned = -1;
    const now = audioContext.currentTime;
    const vol = getMasterVolume();
    this.masterGain = audioContext.createGain();
    this.masterGain.gain.setValueAtTime(0, now);
    this.masterGain.connect(this.panner);
    this.delayNode = audioContext.createDelay(1.0);
    this.delayNode.delayTime.setValueAtTime(0.15, now);
    this.delayGain = audioContext.createGain();
    this.delayGain.gain.setValueAtTime(0.3, now);
    this.delayNode.connect(this.delayGain);
    this.delayGain.connect(this.masterGain);
    this._createRumbleLayer(now, vol);
    this._createHarmonicLayer(now, vol);
    this._createSparkleLayer(now, vol);
    this._createWhooshLayer(now, vol);
    this.masterGain.gain.linearRampToValueAtTime(1.0, now + 0.1);
  }

  _createRumbleLayer(now, vol) {
    this.rumbleOsc = audioContext.createOscillator();
    this.rumbleOsc.type = "sine";
    this.rumbleOsc.frequency.setValueAtTime(45, now);
    this.rumbleLfo = audioContext.createOscillator();
    this.rumbleLfo.type = "sine";
    this.rumbleLfo.frequency.setValueAtTime(2, now);
    const modGain = audioContext.createGain();
    modGain.gain.setValueAtTime(8, now);
    this.rumbleGain = audioContext.createGain();
    this.rumbleGain.gain.setValueAtTime(0, now);
    this.rumbleLfo.connect(modGain);
    modGain.connect(this.rumbleOsc.frequency);
    this.rumbleOsc.connect(this.rumbleGain);
    this.rumbleGain.connect(this.masterGain);
    this.rumbleGain.connect(this.delayNode);
    this.rumbleOsc.start(now);
    this.rumbleLfo.start(now);
    this.rumbleGain.gain.linearRampToValueAtTime(0.15 * vol, now + 0.5);
  }

  _createHarmonicLayer(now, vol) {
    [80, 160, 240, 320].forEach((freq, i) => {
      const osc = audioContext.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now);
      const lfo = audioContext.createOscillator();
      lfo.type = "sine";
      lfo.frequency.setValueAtTime(0.5 + i * 0.3, now);
      const lfoGain = audioContext.createGain();
      lfoGain.gain.setValueAtTime(freq * 0.08, now);
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(now);
      const gain = audioContext.createGain();
      const baseVol = (0.05 - i * 0.01) * vol;
      gain.gain.setValueAtTime(0, now);
      osc.connect(gain);
      gain.connect(this.masterGain);
      gain.connect(this.delayNode);
      osc.start(now);
      this.harmonicOscs.push(osc);
      this.harmonicGains.push({ gain, baseVol, baseFreq: freq, lfoGain });
      this.harmonicLfos.push(lfo);
    });
  }

  _createSparkleLayer(now) {
    const buf = this._createNoiseBuffer(2, "white");
    this.sparkleNoise = audioContext.createBufferSource();
    this.sparkleNoise.buffer = buf;
    this.sparkleNoise.loop = true;
    this.sparkleFilter = audioContext.createBiquadFilter();
    this.sparkleFilter.type = "bandpass";
    this.sparkleFilter.frequency.setValueAtTime(2000, now);
    this.sparkleFilter.Q.setValueAtTime(8, now);
    this.sparkleLfo = audioContext.createOscillator();
    this.sparkleLfo.type = "sine";
    this.sparkleLfo.frequency.setValueAtTime(4, now);
    const lfoGain = audioContext.createGain();
    lfoGain.gain.setValueAtTime(1000, now);
    this.sparkleGain = audioContext.createGain();
    this.sparkleGain.gain.setValueAtTime(0, now);
    this.sparkleLfo.connect(lfoGain);
    lfoGain.connect(this.sparkleFilter.frequency);
    this.sparkleNoise.connect(this.sparkleFilter);
    this.sparkleFilter.connect(this.sparkleGain);
    this.sparkleGain.connect(this.masterGain);
    this.sparkleNoise.start(now);
    this.sparkleLfo.start(now);
  }

  _createWhooshLayer(now) {
    const buf = this._createNoiseBuffer(2, "pink");
    this.whooshNoise = audioContext.createBufferSource();
    this.whooshNoise.buffer = buf;
    this.whooshNoise.loop = true;
    this.whooshFilter = audioContext.createBiquadFilter();
    this.whooshFilter.type = "lowpass";
    this.whooshFilter.frequency.setValueAtTime(400, now);
    this.whooshFilter.Q.setValueAtTime(2, now);
    this.whooshGain = audioContext.createGain();
    this.whooshGain.gain.setValueAtTime(0, now);
    this.whooshNoise.connect(this.whooshFilter);
    this.whooshFilter.connect(this.whooshGain);
    this.whooshGain.connect(this.masterGain);
    this.whooshNoise.start(now);
  }

  _playWarpShot() {
    if (!this.isActive || isAudioPaused()) return;
    const now = audioContext.currentTime;
    const vol = 0.08 * getMasterVolume();
    const startFreq = 800 + Math.random() * 600;
    const osc = audioContext.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.exponentialRampToValueAtTime(80, now + 0.12);
    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3000, now);
    filter.frequency.exponentialRampToValueAtTime(200, now + 0.1);
    filter.Q.setValueAtTime(5, now);
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  _startWarpShots() {
    if (this.warpShotInterval) return;
    let shotCount = 0;
    const fireShot = () => {
      if (!this.isActive || this.currentPhase !== "opening") {
        this._stopWarpShots();
        return;
      }
      this._playWarpShot();
      shotCount++;
      const delay = 60 + Math.random() * 80;
      this.warpShotInterval = setTimeout(fireShot, delay);
    };
    fireShot();
  }

  _stopWarpShots() {
    if (this.warpShotInterval) {
      clearTimeout(this.warpShotInterval);
      this.warpShotInterval = null;
    }
  }

  playRobotEmergence(robotIndex) {
    if (!this.isActive || isAudioPaused()) return;
    const now = audioContext.currentTime;
    const vol = 0.12 * getMasterVolume();
    const baseFreq = 300 + robotIndex * 50;
    const osc = audioContext.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 2, now + 0.15);
    const osc2 = audioContext.createOscillator();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(baseFreq * 1.5, now);
    osc2.frequency.exponentialRampToValueAtTime(baseFreq * 3, now + 0.15);
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.02);
    gain.gain.linearRampToValueAtTime(0, now + 0.2);
    const gain2 = audioContext.createGain();
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.linearRampToValueAtTime(vol * 0.5, now + 0.02);
    gain2.gain.linearRampToValueAtTime(0, now + 0.2);
    osc.connect(gain);
    osc2.connect(gain2);
    gain.connect(this.masterGain);
    gain2.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.25);
    osc2.start(now);
    osc2.stop(now + 0.25);
  }

  updateEntrance(phase, progress, robotsSpawned = 0) {
    if (!this.isActive) return;
    const now = audioContext.currentTime;
    const vol = getMasterVolume();
    if (phase !== this.currentPhase) this.currentPhase = phase;
    if (robotsSpawned > this.lastRobotSpawned && robotsSpawned > 0) {
      this.playRobotEmergence(robotsSpawned - 1);
      this.lastRobotSpawned = robotsSpawned;
    }
    if (phase === "opening") this._updateOpening(progress, vol, now);
    else if (phase === "holding") this._updateHolding(vol, now);
    else if (phase === "spawning") this._updateSpawning(vol, now);
    else if (phase === "closing") this._updateClosing(progress, vol, now);
  }

  _updateOpening(progress, vol, now) {
    if (progress > 0.05 && this.lastProgress <= 0.05) {
      this._startWarpShots();
    }
    this.lastProgress = progress;
    if (this.rumbleGain)
      this.rumbleGain.gain.setTargetAtTime(
        (0.15 + progress * 0.1) * vol,
        now,
        0.1
      );
    if (this.rumbleOsc)
      this.rumbleOsc.frequency.setTargetAtTime(45 + progress * 15, now, 0.1);
    this.harmonicGains.forEach(({ gain, baseVol, baseFreq, lfoGain }, i) => {
      gain.gain.setTargetAtTime(baseVol * progress, now, 0.05);
      if (this.harmonicOscs[i])
        this.harmonicOscs[i].frequency.setTargetAtTime(
          baseFreq * (1 + progress * 0.3),
          now,
          0.1
        );
      if (lfoGain)
        lfoGain.gain.setTargetAtTime(
          baseFreq * (0.08 + progress * 0.12),
          now,
          0.1
        );
    });
    if (this.sparkleGain)
      this.sparkleGain.gain.setTargetAtTime(0.06 * progress * vol, now, 0.05);
    if (this.sparkleFilter)
      this.sparkleFilter.frequency.setTargetAtTime(
        2000 + progress * 4000,
        now,
        0.1
      );
    if (this.whooshGain)
      this.whooshGain.gain.setTargetAtTime(
        0.12 * Math.sin(progress * Math.PI) * vol,
        now,
        0.05
      );
    if (this.whooshFilter)
      this.whooshFilter.frequency.setTargetAtTime(
        400 + progress * 800,
        now,
        0.1
      );
  }

  _updateHolding(vol, now) {
    this._stopWarpShots();
    if (this.rumbleGain)
      this.rumbleGain.gain.setTargetAtTime(0.2 * vol, now, 0.1);
    this.harmonicGains.forEach(({ gain, baseVol }) =>
      gain.gain.setTargetAtTime(baseVol * 0.7, now, 0.05)
    );
    if (this.sparkleGain)
      this.sparkleGain.gain.setTargetAtTime(0.06 * vol, now, 0.05);
    if (this.whooshGain)
      this.whooshGain.gain.setTargetAtTime(0.04 * vol, now, 0.05);
  }

  _updateSpawning(vol, now) {
    this._stopWarpShots();
    if (this.rumbleGain)
      this.rumbleGain.gain.setTargetAtTime(0.15 * vol, now, 0.1);
    this.harmonicGains.forEach(({ gain, baseVol }) =>
      gain.gain.setTargetAtTime(baseVol * 0.5, now, 0.05)
    );
    if (this.sparkleGain)
      this.sparkleGain.gain.setTargetAtTime(
        (0.04 + Math.sin(now * 8) * 0.015) * vol,
        now,
        0.02
      );
    if (this.whooshGain)
      this.whooshGain.gain.setTargetAtTime(0.025 * vol, now, 0.05);
  }

  _updateClosing(progress, vol, now) {
    this._stopWarpShots();
    const inv = 1 - progress;
    if (this.rumbleGain)
      this.rumbleGain.gain.setTargetAtTime(0.15 * inv * vol, now, 0.05);
    if (this.rumbleOsc)
      this.rumbleOsc.frequency.setTargetAtTime(60 - progress * 20, now, 0.1);
    this.harmonicGains.forEach(({ gain, baseVol, baseFreq, lfoGain }, i) => {
      gain.gain.setTargetAtTime(baseVol * inv * 0.5, now, 0.05);
      if (this.harmonicOscs[i])
        this.harmonicOscs[i].frequency.setTargetAtTime(
          baseFreq * (1 - progress * 0.3),
          now,
          0.1
        );
      if (lfoGain)
        lfoGain.gain.setTargetAtTime(baseFreq * 0.04 * inv, now, 0.1);
    });
    if (this.sparkleGain)
      this.sparkleGain.gain.setTargetAtTime(0.04 * inv * vol, now, 0.05);
    if (this.sparkleFilter)
      this.sparkleFilter.frequency.setTargetAtTime(2000 * inv + 500, now, 0.1);
    if (this.whooshGain)
      this.whooshGain.gain.setTargetAtTime(
        0.1 * Math.sin(progress * Math.PI) * vol,
        now,
        0.05
      );
  }

  stop() {
    if (!this.isActive) return;
    this.isActive = false;
    this.currentPhase = null;
    this._stopWarpShots();
    if (this.masterGain)
      this.masterGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.1);
    setTimeout(() => this._cleanup(), 300);
  }

  _cleanup() {
    try {
      this._stopWarpShots();
      this.lastProgress = 0;
      if (this.rumbleOsc) {
        this.rumbleOsc.stop();
        this.rumbleOsc = null;
      }
      if (this.rumbleLfo) {
        this.rumbleLfo.stop();
        this.rumbleLfo = null;
      }
      this.rumbleGain = null;
      this.harmonicOscs.forEach((o) => {
        try {
          o.stop();
        } catch (e) {}
      });
      this.harmonicLfos.forEach((o) => {
        try {
          o.stop();
        } catch (e) {}
      });
      this.harmonicOscs = [];
      this.harmonicGains = [];
      this.harmonicLfos = [];
      if (this.sparkleNoise) {
        this.sparkleNoise.stop();
        this.sparkleNoise = null;
      }
      if (this.sparkleLfo) {
        this.sparkleLfo.stop();
        this.sparkleLfo = null;
      }
      this.sparkleFilter = null;
      this.sparkleGain = null;
      if (this.whooshNoise) {
        this.whooshNoise.stop();
        this.whooshNoise = null;
      }
      this.whooshFilter = null;
      this.whooshGain = null;
      this.delayNode = null;
      this.delayGain = null;
      this.masterGain = null;
    } catch (e) {}
  }

  dispose() {
    this.stop();
    this.panner.disconnect();
  }
}
