/**
 * AudioAmplitudeSystem - ECS System for real-time audio amplitude tracking
 *
 * Integrates AudioAnalyzer with the game loop and exposes amplitude values
 * for use by:
 * - Haptic feedback (via HapticManager)
 * - Visual animations
 * - Any audio-reactive effects
 */

import { createSystem } from "@iwsdk/core";
import { gameState, GAME_STATES } from "../gameState.js";
import { getAudioAnalyzer } from "../utils/AudioAnalyzer.js";
import { hapticManager } from "../utils/HapticManager.js";
import { Logger } from "../utils/Logger.js";

export class AudioAmplitudeSystem extends createSystem({}, {}) {
  init() {
    this.logger = new Logger("AudioAmplitude", false);
    this.logger.log("Initializing");

    this.analyzer = getAudioAnalyzer();

    // Cached amplitude values (accessed directly, not via gameState)
    this._amplitude = 0;
    this._smoothedAmplitude = 0;

    // Track audio elements we've connected for analysis
    this.connectedElements = new Map();

    // Haptic feedback configuration
    this.hapticEnabled = true;
    this.hapticThreshold = 0.02; // Minimum amplitude to trigger haptics (lowered for quiet audio)
    this.hapticIntensityScale = 2.0; // Scale factor for haptic intensity (boosted)
    this.hapticMinDuration = 30; // Minimum haptic pulse duration (ms)
    this.hapticMaxDuration = 100; // Maximum haptic pulse duration (ms)

    // Rate limit haptic pulses to avoid overwhelming the controllers
    this._lastHapticTime = 0;
    this._hapticCooldown = 50; // Minimum ms between haptic pulses

    // Listen for XR active to initialize analyzer
    gameState.on("state:changed", (newState, oldState) => {
      if (
        newState.currentState !== oldState.currentState &&
        newState.currentState >= GAME_STATES.XR_ACTIVE &&
        !this.analyzer._initialized
      ) {
        this.analyzer.init();
      }
    });
  }

  /**
   * Connect an HTML audio element for amplitude analysis
   * @param {HTMLAudioElement} element - Audio element to analyze
   * @param {string} trackId - Unique track identifier
   */
  connectAudioElement(element, trackId) {
    if (!this.analyzer._initialized) {
      this.analyzer.init();
    }
    this.analyzer.connectAudioElement(element, trackId);
    this.connectedElements.set(trackId, element);
  }

  /**
   * Disconnect a track from analysis
   * @param {string} trackId - Track identifier
   */
  disconnectAudioElement(trackId) {
    this.analyzer.disconnect(trackId);
    this.connectedElements.delete(trackId);
  }

  /**
   * Configure haptic feedback
   * @param {Object} config - Haptic configuration
   */
  setHapticConfig(config) {
    if (config.enabled !== undefined) this.hapticEnabled = config.enabled;
    if (config.threshold !== undefined) this.hapticThreshold = config.threshold;
    if (config.intensityScale !== undefined)
      this.hapticIntensityScale = config.intensityScale;
    if (config.minDuration !== undefined)
      this.hapticMinDuration = config.minDuration;
    if (config.maxDuration !== undefined)
      this.hapticMaxDuration = config.maxDuration;
  }

  update(delta, time) {
    // Update the analyzer
    this.analyzer.update();

    // Cache amplitude values for direct access (avoid gameState spam)
    this._amplitude = this.analyzer.getAmplitude();
    this._smoothedAmplitude = this.analyzer.getSmoothedAmplitude();

    // Debug: log amplitude periodically
    if (!this._lastDebugLog) this._lastDebugLog = 0;
    const now = performance.now();
    if (now - this._lastDebugLog > 1000) {
      this._lastDebugLog = now;
      const sources = this.analyzer.sources?.size || 0;
      if (sources > 0 || this._smoothedAmplitude > 0) {
        this.logger.log(
          `amplitude=${this._amplitude.toFixed(
            3
          )}, smoothed=${this._smoothedAmplitude.toFixed(
            3
          )}, sources=${sources}`
        );
      }
    }

    // Trigger haptics based on audio amplitude (with rate limiting)
    if (this.hapticEnabled && this._smoothedAmplitude > this.hapticThreshold) {
      if (now - this._lastHapticTime >= this._hapticCooldown) {
        this._lastHapticTime = now;
        this.triggerAudioHaptics(this._smoothedAmplitude);
      }
    }
  }

  /**
   * Trigger haptic feedback based on audio amplitude using HapticManager
   * @param {number} amplitude - Current amplitude (0-1)
   */
  triggerAudioHaptics(amplitude) {
    // Normalize amplitude above threshold
    const normalizedAmplitude =
      (amplitude - this.hapticThreshold) / (1 - this.hapticThreshold);
    const intensity = Math.min(
      1,
      normalizedAmplitude * this.hapticIntensityScale
    );
    const duration =
      this.hapticMinDuration +
      (this.hapticMaxDuration - this.hapticMinDuration) * normalizedAmplitude;

    // Debug: log haptic trigger (rate-limited by the update() cooldown)
    this.logger.log(
      `Triggering haptic: intensity=${intensity.toFixed(
        2
      )}, duration=${duration.toFixed(0)}ms`
    );

    // Use HapticManager for the actual pulse
    const success = hapticManager.pulseBoth(intensity, duration);
    if (!success) {
      this.logger.log(`HapticManager.pulseBoth returned false`);
    }
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

  destroy() {
    this.logger.log("Destroying");
    this.analyzer.destroy();
  }
}
