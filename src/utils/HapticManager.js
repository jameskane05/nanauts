/**
 * HapticManager.js - XR CONTROLLER HAPTIC FEEDBACK
 * =============================================================================
 *
 * ROLE: Provides a simple API for triggering haptic pulses on XR controllers
 * using the WebXR Gamepad hapticActuators API.
 *
 * KEY RESPONSIBILITIES:
 * - Access XR session input sources
 * - Find gamepad haptic actuators for left/right controllers
 * - Trigger haptic pulses with configurable intensity and duration
 * - Support both single-controller and dual-controller pulses
 *
 * API:
 * - init(world): Initialize with IWSDK world reference
 * - pulse(hand, intensity, duration): Pulse one controller
 * - pulseBoth(intensity, duration): Pulse both controllers
 *
 * INTENSITY: 0.0 to 1.0 (percentage of max vibration)
 * DURATION: Milliseconds (typically 50-200ms for feedback)
 *
 * SINGLETON PATTERN:
 * Export is pre-instantiated hapticManager singleton.
 *
 * USAGE: Import hapticManager, call init() once, then pulse() as needed
 * =============================================================================
 */

import { Logger } from "./Logger.js";

class HapticManager {
  constructor() {
    this.world = null;
    this._initialized = false;
    this.logger = new Logger("Haptic", false);
  }

  /**
   * Initialize with world reference
   * @param {World} world - IWSDK World instance
   */
  init(world) {
    this.world = world;
    this._initialized = true;
    this.logger.log("Initialized");
  }

  /**
   * Get the current XR session
   * @returns {XRSession|null}
   */
  _getSession() {
    return this.world?.renderer?.xr?.getSession() || null;
  }

  /**
   * Get gamepad for a specific hand
   * @param {string} hand - 'left' or 'right'
   * @returns {Gamepad|null}
   */
  _getGamepad(hand) {
    const session = this._getSession();
    if (!session?.inputSources) return null;

    for (const inputSource of session.inputSources) {
      if (inputSource.handedness === hand && inputSource.gamepad) {
        return inputSource.gamepad;
      }
    }
    return null;
  }

  /**
   * Trigger a haptic pulse on a controller
   * @param {string} hand - 'left', 'right', or 'both'
   * @param {number} intensity - Pulse intensity (0-1)
   * @param {number} duration - Pulse duration in milliseconds
   * @returns {boolean} - Whether pulse was triggered successfully
   */
  pulse(hand, intensity = 1.0, duration = 100) {
    if (!this._initialized) {
      this.logger.warn("Not initialized, call init(world) first");
      return false;
    }

    if (hand === "both") {
      return this.pulseBoth(intensity, duration);
    }

    const session = this._getSession();
    if (!session) {
      this.logger.log("No XR session");
      return false;
    }

    const gamepad = this._getGamepad(hand);
    if (!gamepad) {
      // Log available input sources for debugging
      const sources = session.inputSources
        ? Array.from(session.inputSources)
            .map(
              (s) => `${s.handedness}:${s.targetRayMode}:gamepad=${!!s.gamepad}`
            )
            .join(", ")
        : "none";
      this.logger.log(`No gamepad for ${hand}. InputSources: [${sources}]`);
      return false;
    }

    return this._pulseGamepad(gamepad, hand, intensity, duration);
  }

  /**
   * Trigger haptic pulse on both controllers
   * @param {number} intensity - Pulse intensity (0-1)
   * @param {number} duration - Pulse duration in milliseconds
   * @returns {boolean} - Whether at least one pulse was triggered
   */
  pulseBoth(intensity = 1.0, duration = 100) {
    const leftResult = this.pulse("left", intensity, duration);
    const rightResult = this.pulse("right", intensity, duration);
    return leftResult || rightResult;
  }

  /**
   * Internal: pulse a specific gamepad
   * @private
   */
  _pulseGamepad(gamepad, hand, intensity, duration) {
    // Clamp values
    intensity = Math.max(0, Math.min(1, intensity));
    duration = Math.max(0, duration);

    let success = false;

    // Try hapticActuators (WebXR standard for Quest)
    if (gamepad.hapticActuators && gamepad.hapticActuators.length > 0) {
      try {
        gamepad.hapticActuators[0].pulse(intensity, duration);
        success = true;
        this.logger.log(
          `Pulse ${hand}: intensity=${intensity.toFixed(
            2
          )}, duration=${duration.toFixed(0)}ms`
        );
      } catch (e) {
        this.logger.warn(`hapticActuators.pulse error: ${e.message}`);
      }
    }

    // Fallback: vibrationActuator (non-standard but some browsers support it)
    if (!success && gamepad.vibrationActuator) {
      try {
        gamepad.vibrationActuator.playEffect("dual-rumble", {
          duration: duration,
          strongMagnitude: intensity,
          weakMagnitude: intensity,
        });
        success = true;
        this.logger.log(
          `Fallback pulse ${hand}: intensity=${intensity.toFixed(
            2
          )}, duration=${duration.toFixed(0)}ms`
        );
      } catch (e) {
        this.logger.warn(`vibrationActuator.playEffect error: ${e.message}`);
      }
    }

    return success;
  }

  /**
   * Check if haptics are available
   * @returns {{ left: boolean, right: boolean }}
   */
  isAvailable() {
    const leftGamepad = this._getGamepad("left");
    const rightGamepad = this._getGamepad("right");

    return {
      left: !!(
        leftGamepad?.hapticActuators?.length > 0 ||
        leftGamepad?.vibrationActuator
      ),
      right: !!(
        rightGamepad?.hapticActuators?.length > 0 ||
        rightGamepad?.vibrationActuator
      ),
    };
  }

  /**
   * Get diagnostic info about haptic support
   * @returns {Object}
   */
  getDiagnostics() {
    const session = this._getSession();
    const diagnostics = {
      initialized: this._initialized,
      hasSession: !!session,
      inputSources: [],
      availability: this.isAvailable(),
    };

    if (session?.inputSources) {
      for (const inputSource of session.inputSources) {
        diagnostics.inputSources.push({
          handedness: inputSource.handedness,
          targetRayMode: inputSource.targetRayMode,
          hasGamepad: !!inputSource.gamepad,
          hapticActuators: inputSource.gamepad?.hapticActuators?.length || 0,
          vibrationActuator: !!inputSource.gamepad?.vibrationActuator,
        });
      }
    }

    return diagnostics;
  }
}

// Singleton instance
export const hapticManager = new HapticManager();
