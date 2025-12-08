/**
 * PlatformDetection.js - META QUEST AND WEBXR CAPABILITY DETECTION
 * =============================================================================
 *
 * ROLE: Detects platform capabilities to determine if the experience can run.
 * Identifies Meta Quest browser, WebXR support, and localhost/emulator bypass.
 *
 * KEY RESPONSIBILITIES:
 * - Parse user agent for OculusBrowser/Quest identifiers
 * - Check navigator.xr for WebXR API support
 * - Allow localhost bypass for development testing
 * - Apply detection results to game state
 *
 * DETECTION RESULTS:
 * - isQuest: Running in Quest browser
 * - isEmulator: Running on localhost/127.0.0.1
 * - isWebXRSupported: navigator.xr exists
 * - isSupported: isQuest OR isEmulator
 *
 * EXPORTS:
 * - detectPlatform(): Returns detection results object
 * - applyPlatformDetection(gameState): Updates game state with results
 *
 * USAGE: Called by index.js on startup to gate XR entry
 * =============================================================================
 */

import { Logger } from "./Logger.js";

const logger = new Logger("PlatformDetection", false);

/**
 * Detect platform capabilities
 * @returns {Object} Platform detection results
 */
export function detectPlatform() {
  // Check for localhost/emulator bypass
  const isEmulator =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  // Detect Meta Quest browser via user agent
  // Quest Browser includes "OculusBrowser" or "Quest" in the user agent
  const userAgent = navigator.userAgent;
  const isQuest = /OculusBrowser|Quest/i.test(userAgent);

  // Check for WebXR support
  const isWebXRSupported = "xr" in navigator;

  // Platform is supported if it's Quest OR running in emulator for development
  const isSupported = isQuest || isEmulator;

  const result = {
    isQuest,
    isEmulator,
    isWebXRSupported,
    isSupported,
    userAgent,
  };

  logger.log("Detected:", result);

  return result;
}

/**
 * Apply platform detection results to game state
 * @param {GameState} gameState - The game state instance to update
 */
export function applyPlatformDetection(gameState) {
  const platform = detectPlatform();

  gameState.setState({
    isQuest: platform.isQuest,
    isEmulator: platform.isEmulator,
    isWebXRSupported: platform.isWebXRSupported,
    isSupported: platform.isSupported,
  });

  return platform;
}
