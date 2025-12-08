/**
 * AudioAnalyzer.js - REAL-TIME AUDIO AMPLITUDE ANALYSIS
 * =============================================================================
 *
 * ROLE: Analyzes audio streams in real-time using Web Audio API to provide
 * normalized amplitude values for audio-reactive effects (haptics, visuals).
 *
 * KEY RESPONSIBILITIES:
 * - Create and manage AudioContext and AnalyserNode
 * - Connect audio sources (HTML audio elements, media streams)
 * - Extract frequency data via FFT analysis
 * - Calculate normalized amplitude (0-1) with smoothing
 * - Support multiple simultaneous audio sources
 *
 * AMPLITUDE CALCULATION:
 * Uses frequency bin data from AnalyserNode, averages amplitudes,
 * and applies exponential smoothing for stable output.
 *
 * SINGLETON PATTERN:
 * Use getAudioAnalyzer() to get/create the shared instance.
 * Ensures single AudioContext for browser autoplay policy compliance.
 *
 * EXPORTS:
 * - AudioAnalyzer class
 * - getAudioAnalyzer(): Returns singleton instance
 *
 * USAGE: Used by AudioAmplitudeSystem for haptics, SpatialUIManager for visuals
 * =============================================================================
 */

import { Logger } from "./Logger.js";

export class AudioAnalyzer {
  constructor(options = {}) {
    this.logger = new Logger("AudioAnalyzer", false);
    this.fftSize = options.fftSize || 256;
    this.smoothingTimeConstant = options.smoothingTimeConstant || 0.8;
    this.minDecibels = options.minDecibels || -90;
    this.maxDecibels = options.maxDecibels || -10;
    
    this.audioContext = null;
    this.analyser = null;
    this.dataArray = null;
    this.sources = new Map(); // trackId -> { source, gainNode }
    
    this._amplitude = 0;
    this._smoothedAmplitude = 0;
    this._smoothingFactor = options.amplitudeSmoothing || 0.3;
    
    this._initialized = false;
  }

  /**
   * Initialize the Web Audio API context and analyser
   * Must be called after a user gesture (click/tap) due to autoplay policies
   */
  init() {
    if (this._initialized) return;
    
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = this.fftSize;
      this.analyser.smoothingTimeConstant = this.smoothingTimeConstant;
      this.analyser.minDecibels = this.minDecibels;
      this.analyser.maxDecibels = this.maxDecibels;
      
      // Connect analyser to destination (speakers)
      this.analyser.connect(this.audioContext.destination);
      
      // Create data array for frequency analysis
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      
      this._initialized = true;
      this.logger.log("Initialized");
    } catch (error) {
      this.logger.error("Failed to initialize:", error);
    }
  }

  /**
   * Connect an HTML audio element for analysis
   * @param {HTMLAudioElement} audioElement - The audio element to analyze
   * @param {string} trackId - Unique identifier for this track
   * @returns {MediaElementAudioSourceNode|null}
   */
  connectAudioElement(audioElement, trackId) {
    if (!this._initialized) this.init();
    if (!this.audioContext || !audioElement) return null;
    
    // Check if already connected
    if (this.sources.has(trackId)) {
      return this.sources.get(trackId).source;
    }
    
    try {
      // Resume context if suspended (autoplay policy)
      if (this.audioContext.state === "suspended") {
        this.audioContext.resume();
      }
      
      // Create media element source
      const source = this.audioContext.createMediaElementSource(audioElement);
      
      // Create gain node for this track
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1.0;
      
      // Connect: source -> gainNode -> analyser (which is already connected to destination)
      source.connect(gainNode);
      gainNode.connect(this.analyser);
      
      this.sources.set(trackId, { source, gainNode, element: audioElement });
      this.logger.log(`Connected track: ${trackId}`);
      
      return source;
    } catch (error) {
      this.logger.error(`Failed to connect audio element:`, error);
      return null;
    }
  }

  /**
   * Disconnect a track from analysis
   * @param {string} trackId - Track identifier
   */
  disconnect(trackId) {
    const trackData = this.sources.get(trackId);
    if (trackData) {
      try {
        trackData.gainNode.disconnect();
        trackData.source.disconnect();
      } catch (e) {
        // May already be disconnected
      }
      this.sources.delete(trackId);
      this.logger.log(`Disconnected track: ${trackId}`);
    }
  }

  /**
   * Disconnect all tracks
   */
  disconnectAll() {
    for (const trackId of this.sources.keys()) {
      this.disconnect(trackId);
    }
  }

  /**
   * Update amplitude analysis - call this each frame
   */
  update() {
    if (!this.analyser || !this.dataArray) {
      this._amplitude = 0;
      this._smoothedAmplitude = 0;
      return;
    }
    
    // Get time domain data (waveform)
    this.analyser.getByteTimeDomainData(this.dataArray);
    
    // Calculate RMS (root mean square) for overall amplitude
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      // Convert from 0-255 to -1 to 1
      const sample = (this.dataArray[i] - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / this.dataArray.length);
    
    // Normalize to 0-1 range (RMS of full-scale sine wave is ~0.707)
    this._amplitude = Math.min(1, rms * 1.414);
    
    // Apply smoothing for less jittery output
    this._smoothedAmplitude = this._smoothedAmplitude * (1 - this._smoothingFactor) 
                           + this._amplitude * this._smoothingFactor;
  }

  /**
   * Get the current raw amplitude (0-1)
   * @returns {number}
   */
  getAmplitude() {
    return this._amplitude;
  }

  /**
   * Get the smoothed amplitude (0-1) - better for haptics/visuals
   * @returns {number}
   */
  getSmoothedAmplitude() {
    return this._smoothedAmplitude;
  }

  /**
   * Get frequency data for more detailed analysis
   * @returns {Uint8Array|null}
   */
  getFrequencyData() {
    if (!this.analyser) return null;
    
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(freqData);
    return freqData;
  }

  /**
   * Get amplitude for specific frequency bands
   * @returns {{ bass: number, mid: number, high: number }}
   */
  getFrequencyBands() {
    const freqData = this.getFrequencyData();
    if (!freqData) return { bass: 0, mid: 0, high: 0 };
    
    const binCount = freqData.length;
    const bassEnd = Math.floor(binCount * 0.1);    // ~0-200Hz
    const midEnd = Math.floor(binCount * 0.5);     // ~200-2000Hz
    
    let bassSum = 0, midSum = 0, highSum = 0;
    
    for (let i = 0; i < binCount; i++) {
      const value = freqData[i] / 255;
      if (i < bassEnd) bassSum += value;
      else if (i < midEnd) midSum += value;
      else highSum += value;
    }
    
    return {
      bass: bassSum / bassEnd,
      mid: midSum / (midEnd - bassEnd),
      high: highSum / (binCount - midEnd),
    };
  }

  /**
   * Set the gain for a specific track
   * @param {string} trackId - Track identifier
   * @param {number} gain - Gain value (0-1)
   */
  setTrackGain(trackId, gain) {
    const trackData = this.sources.get(trackId);
    if (trackData && trackData.gainNode) {
      trackData.gainNode.gain.value = gain;
    }
  }

  /**
   * Destroy the analyzer and release resources
   */
  destroy() {
    this.disconnectAll();
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    this.analyser = null;
    this.dataArray = null;
    this._initialized = false;
    
    this.logger.log("Destroyed");
  }
}

// Singleton instance for global access
let globalAnalyzer = null;

export function getAudioAnalyzer() {
  if (!globalAnalyzer) {
    globalAnalyzer = new AudioAnalyzer();
  }
  return globalAnalyzer;
}

export default AudioAnalyzer;

