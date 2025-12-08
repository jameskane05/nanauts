/**
 * LipSyncManager.js - AUDIO-DRIVEN PHONEME ANIMATION
 * =============================================================================
 *
 * ROLE: Analyzes audio in real-time to drive lip sync animation. Uses formant
 * analysis (F1/F2 frequencies) to detect vowel shapes and maps them to viseme
 * frames in a sprite sheet.
 *
 * KEY RESPONSIBILITIES:
 * - Create AudioContext and AnalyserNode for frequency analysis
 * - Extract formant frequencies (F1/F2) from FFT data
 * - Map formants to viseme frames (16-frame sprite sheet)
 * - Rate-limit updates (~20fps) for performance
 * - Fire onFrameChange callback with frame index and UV coordinates
 *
 * FORMANT ANALYSIS:
 * F1 (300-800Hz): Jaw openness (low=closed, high=open)
 * F2 (800-2500Hz): Tongue position (low=back, high=front)
 * Combined to select from 16 viseme frames.
 *
 * SPRITE SHEET:
 * 4x4 grid (16 frames), UV coordinates calculated from frame index.
 * Frame 0 = mouth closed, higher frames = more open/varied shapes.
 *
 * SMOOTHING:
 * Target frame lerped toward current to avoid jarring transitions.
 * Update interval limits frame changes to ~50ms minimum.
 *
 * USAGE: Created by DialogManager, attached to audio elements during playback
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";

export class LipSyncManager {
  constructor(options = {}) {
    this.logger = new Logger("LipSync", options.debug || false);

    // Sprite sheet config (4 columns x 4 rows = 16 frames)
    this.cols = options.cols || 4;
    this.rows = options.rows || 4;
    this.totalFrames = this.cols * this.rows;

    // Update rate limiting (ms between frame updates, ~4fps at 250ms)
    this.updateInterval = 50;
    this.lastUpdateTime = 0;

    // Current frame
    this.currentFrame = 0;
    this.targetFrame = 0;

    // Audio context and nodes
    this.audioContext = null;
    this.analyser = null;
    this.audioSource = null;
    this.audioElement = null;

    // Analysis data
    this.frequencyData = null;
    this.timeDomainData = null;

    // Formant analysis
    this.binHz = 0; // Hz per FFT bin

    // Callback when frame changes
    this.onFrameChange = options.onFrameChange || null;

    // Viseme mapping based on standard phoneme chart (4x4 grid = 16 frames)
    // Reference: 1000_F_506427836 mouth shapes chart
    //
    // Row 0: 0=neutral, 1=surprised/wide, 2=smile teeth, 3=big smile
    // Row 1: 4=open AH, 5=round O, 6=neutral teeth, 7=slight smile
    // Row 2: 8=shocked open, 9=medium open, 10=smile, 11=teeth showing
    // Row 3: 12=open, 13=tongue out (L), 14=closed rest, 15=closed neutral
    //
    // Chart mapping (1-12 + specials):
    // 1=B,M,P (closed) | 2=Ch,J,Sh | 3=U,H,U | 4=Oo,Uu,W
    // 5=A,E,I | 6=D,G,K,N,S,T,X,Y,Z | 7=O | 8=Th
    // 9=F,V | 10=Ee | 11=L | 12=R
    // neutral, rest, smile, surprised
    this.visemeFrames = {
      // Silence/rest states
      silence: 14, // Closed rest mouth
      neutral: 0, // Neutral expression
      rest: 15, // Closed neutral

      // Chart position 1: B, M, P - closed bilabials
      BMP: 14, // Closed lips

      // Chart position 2: Ch, J, Sh - palatals
      CHJ: 6, // Slightly open, teeth visible

      // Chart position 3: U, H, U - open unrounded
      UHU: 9, // Medium open mouth

      // Chart position 4: Oo, Uu, W - rounded
      OOW: 5, // Round O pursed lips

      // Chart position 5: A, E, I - open front vowels
      AEI: 4, // Open with teeth visible

      // Chart position 6: D, G, K, N, S, T, X, Y, Z - alveolar/velar consonants
      consonants: 7, // Slight smile, teeth showing

      // Chart position 7: O - back round vowel
      OH: 5, // Round open

      // Chart position 8: Th - dental fricative
      TH: 9, // Medium open (tongue position)

      // Chart position 9: F, V - labiodental
      FV: 11, // Teeth on lip

      // Chart position 10: Ee - high front vowel
      EE: 2, // Wide smile, teeth showing

      // Chart position 11: L - lateral
      L: 13, // Tongue visible

      // Chart position 12: R - retroflex
      R: 5, // Slightly rounded

      // Special expressions
      smile: 3, // Big smile
      surprised: 1, // Surprised/wide open

      // Legacy mappings for formant analysis
      IH: 6, // Short I (kit)
      EH: 9, // Short E (bed)
      AE: 4, // Short A (cat)
      AH: 8, // Open AH (father)
      AW: 5, // AW (caught)
      OO: 5, // OO (food)
      UH: 9, // Short U (but)
    };

    this._animationId = null;
    this._isPlaying = false;
  }

  async initialize() {
    try {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

      // Create analyser node - larger FFT for better frequency resolution
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048; // Better frequency resolution for formants
      this.analyser.smoothingTimeConstant = 0.7;

      const bufferLength = this.analyser.frequencyBinCount;
      this.frequencyData = new Uint8Array(bufferLength);
      this.timeDomainData = new Uint8Array(bufferLength);

      // Calculate Hz per bin (sample rate / FFT size)
      // Will be set properly after audio loads
      this.binHz = 44100 / this.analyser.fftSize; // ~21.5 Hz per bin

      this.logger.log(
        "Initialized with FFT size:",
        this.analyser.fftSize,
        "binHz:",
        this.binHz.toFixed(1)
      );
      return true;
    } catch (e) {
      this.logger.error("Failed to initialize:", e);
      return false;
    }
  }

  async loadAudio(src) {
    if (!this.audioContext) {
      await this.initialize();
    }

    // Resume context if suspended
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Create audio element
    this.audioElement = document.createElement("audio");
    this.audioElement.src = src;
    this.audioElement.crossOrigin = "anonymous";
    this.audioElement.loop = false;

    // Wait for it to load
    await new Promise((resolve, reject) => {
      this.audioElement.addEventListener("canplaythrough", resolve, {
        once: true,
      });
      this.audioElement.addEventListener("error", reject, { once: true });
      this.audioElement.load();
    });

    // Connect to analyser
    this.audioSource = this.audioContext.createMediaElementSource(
      this.audioElement
    );
    this.audioSource.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    // Update binHz with actual sample rate
    this.binHz = this.audioContext.sampleRate / this.analyser.fftSize;

    this.logger.log(
      "Audio loaded:",
      src,
      "sampleRate:",
      this.audioContext.sampleRate
    );
  }

  play() {
    if (!this.audioElement) {
      this.logger.warn("No audio element to play");
      return;
    }

    this._isPlaying = true;

    // Resume audio context first (may be suspended)
    const playAudio = async () => {
      try {
        if (this.audioContext?.state === "suspended") {
          this.logger.log("Resuming suspended AudioContext...");
          await this.audioContext.resume();
        }
        await this.audioElement.play();
        this.logger.log("Audio playback started");
      } catch (e) {
        this.logger.error("Audio play failed:", e.message);
        // Try again after a short delay (browser may need time)
        setTimeout(async () => {
          try {
            await this.audioElement.play();
            this.logger.log("Audio playback started (retry)");
          } catch (e2) {
            this.logger.error("Audio play retry failed:", e2.message);
          }
        }, 100);
      }
    };

    playAudio();
    this._startAnalysis();

    this.audioElement.addEventListener(
      "ended",
      () => {
        this._isPlaying = false;
        this._stopAnalysis();
        this.currentFrame = 0;
        if (this.onFrameChange) this.onFrameChange(0, this.getUV(0));
      },
      { once: true }
    );
  }

  stop() {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    }
    this._isPlaying = false;
    this._stopAnalysis();
  }

  _startAnalysis() {
    // Analysis is now driven by updateAnalysis() called from DialogManager each XR frame
    this._analysisActive = true;
  }

  _stopAnalysis() {
    this._analysisActive = false;
  }

  /**
   * Update audio analysis - call this each XR frame from DialogManager
   */
  updateAnalysis() {
    if (!this._isPlaying || !this._analysisActive || !this.analyser) return;

    const now = performance.now();

    // Rate limit updates (still want ~20fps for lip sync, not every XR frame)
    if (now - this.lastUpdateTime < this.updateInterval) return;
    this.lastUpdateTime = now;

    // Get frequency and time domain data
    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeDomainData);

    // Calculate amplitude
    const amplitude = this._getAmplitude();

    // Check for silence first
    if (amplitude < 0.015) {
      this.targetFrame = this.visemeFrames.silence;
    } else {
      // Find formants and map to viseme
      const { f1, f2 } = this._findFormants();
      const highFreqEnergy = this._getHighFrequencyEnergy();

      this.targetFrame = this._formantToViseme(
        f1,
        f2,
        amplitude,
        highFreqEnergy
      );
    }

    this.currentFrame = this.targetFrame;

    // Notify callback
    if (this.onFrameChange) {
      this.onFrameChange(this.currentFrame, this.getUV(this.currentFrame));
    }
  }

  _getAmplitude() {
    // Calculate RMS amplitude from time domain data
    let sum = 0;
    for (let i = 0; i < this.timeDomainData.length; i++) {
      const val = (this.timeDomainData[i] - 128) / 128;
      sum += val * val;
    }
    return Math.sqrt(sum / this.timeDomainData.length);
  }

  _getHighFrequencyEnergy() {
    // Energy in 2500-8000 Hz range (consonants, sibilants)
    const startBin = Math.floor(2500 / this.binHz);
    const endBin = Math.min(
      Math.floor(8000 / this.binHz),
      this.frequencyData.length - 1
    );

    let sum = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += this.frequencyData[i];
    }
    return sum / (endBin - startBin + 1) / 255;
  }

  _findFormants() {
    // F1 range: 250-900 Hz (jaw openness)
    // F2 range: 800-2500 Hz (tongue front/back)

    const f1Start = Math.floor(250 / this.binHz);
    const f1End = Math.floor(900 / this.binHz);
    const f2Start = Math.floor(800 / this.binHz);
    const f2End = Math.floor(2500 / this.binHz);

    // Find peak in F1 range
    let f1Bin = f1Start;
    let f1Max = 0;
    for (let i = f1Start; i <= f1End && i < this.frequencyData.length; i++) {
      if (this.frequencyData[i] > f1Max) {
        f1Max = this.frequencyData[i];
        f1Bin = i;
      }
    }

    // Find peak in F2 range (must be different from F1)
    let f2Bin = f2Start;
    let f2Max = 0;
    for (let i = f2Start; i <= f2End && i < this.frequencyData.length; i++) {
      // Skip if too close to F1 peak
      if (Math.abs(i - f1Bin) < 3) continue;
      if (this.frequencyData[i] > f2Max) {
        f2Max = this.frequencyData[i];
        f2Bin = i;
      }
    }

    const f1 = f1Bin * this.binHz;
    const f2 = f2Bin * this.binHz;

    return { f1, f2, f1Strength: f1Max / 255, f2Strength: f2Max / 255 };
  }

  _formantToViseme(f1, f2, amplitude, highFreqEnergy) {
    // Chart mapping based on phonetics reference:
    // 1=B,M,P | 2=Ch,J,Sh | 3=U,H,U | 4=Oo,Uu,W | 5=A,E,I | 6=consonants
    // 7=O | 8=Th | 9=F,V | 10=Ee | 11=L | 12=R

    // Sibilants (S, SH, Z, CH, J) - high frequency energy = chart pos 2 or 6
    if (highFreqEnergy > 0.5) {
      return this.visemeFrames.CHJ; // Ch, J, Sh sounds
    }

    // Very low amplitude = silence (chart: rest)
    if (amplitude < 0.03) {
      return this.visemeFrames.silence;
    }

    // F, V detection - mid-high frequency with specific pattern = chart pos 9
    if (highFreqEnergy > 0.35 && amplitude < 0.15) {
      return this.visemeFrames.FV;
    }

    // Normalize formants for vowel classification
    // F1: low = closed, high = open (250-800 Hz range)
    // F2: low = back/round, high = front/spread (800-2500 Hz range)
    const f1Norm = Math.max(0, Math.min(1, (f1 - 250) / 550));
    const f2Norm = Math.max(0, Math.min(1, (f2 - 800) / 1700));

    // Wide open mouth (high F1 or loud) - chart pos 5 (A,E,I) or 3 (U,H,U)
    if (f1Norm > 0.6 || amplitude > 0.25) {
      if (f2Norm > 0.5) {
        return this.visemeFrames.AEI; // Chart 5: A, E, I - open front
      }
      if (f2Norm < 0.25) {
        return this.visemeFrames.AH; // Wide open back (surprised)
      }
      return this.visemeFrames.UHU; // Chart 3: U, H, U - open central
    }

    // Medium open mouth
    if (f1Norm > 0.35) {
      if (f2Norm > 0.55) {
        return this.visemeFrames.EH; // Mid front vowels
      }
      if (f2Norm < 0.3) {
        return this.visemeFrames.OH; // Chart 7: O - back round
      }
      return this.visemeFrames.UH; // Central vowels
    }

    // Closed/narrow positions
    if (f2Norm > 0.6) {
      // High front = EE (chart pos 10)
      return this.visemeFrames.EE;
    }
    if (f2Norm < 0.25) {
      // High back round = OO, W (chart pos 4)
      return this.visemeFrames.OOW;
    }

    // Default consonants or neutral (chart pos 6 for consonants)
    if (amplitude > 0.08) {
      return this.visemeFrames.consonants;
    }

    return this.visemeFrames.neutral;
  }

  /**
   * Get UV coordinates for a frame index
   * Returns { u, v, uSize, vSize } for texture coordinates
   * Includes small margin to prevent adjacent frame bleed
   */
  getUV(frameIndex) {
    // Clamp frame index to valid range
    frameIndex = Math.max(0, Math.min(frameIndex, this.totalFrames - 1));

    const col = frameIndex % this.cols;
    const row = Math.floor(frameIndex / this.cols);

    const cellWidth = 1 / this.cols; // 0.25 for 4 cols
    const cellHeight = 1 / this.rows; // 0.25 for 4 rows

    // Margin to crop out edge pixels (as fraction of cell size)
    const margin = 0.02; // 2% inset on each edge

    // Shrink the displayed area by margin on all sides
    const uSize = cellWidth * (1 - margin * 2);
    const vSize = cellHeight * (1 - margin * 2);

    // UV origin is bottom-left, sprite sheet origin is top-left
    // For row 0 (top of sprite), we want v = 0.75 (3/4 up from bottom)
    // For row 3 (bottom of sprite), we want v = 0
    // Add margin offset to start slightly inside the cell
    const u = col * cellWidth + cellWidth * margin;
    const v = (this.rows - 1 - row) * cellHeight + cellHeight * margin;

    return { u, v, uSize, vSize };
  }

  destroy() {
    this.stop();
    if (this.audioElement) {
      this.audioElement.src = "";
      this.audioElement = null;
    }
    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = null;
    }
    this.analyser = null;
    // Don't close audioContext as it may be shared
  }
}
