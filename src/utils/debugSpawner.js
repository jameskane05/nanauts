/**
 * DebugSpawner.js - DEBUG URL PARAMETER HANDLING FOR GAME STATE
 * =============================================================================
 *
 * ROLE: Parses URL parameters to spawn directly into specific game states
 * during development. Allows skipping intro, jumping to gameplay, etc.
 *
 * KEY RESPONSIBILITIES:
 * - Parse URL query parameters for debug options
 * - Map state names to GAME_STATES enum values
 * - Apply state overrides for specific game states
 * - Support special presets (e.g., ROBOTS_WANDERING)
 *
 * URL PARAMETERS:
 * - ?gameState=<STATE>: Jump to specific state (PLAYING, XR_ACTIVE, etc.)
 * - ?introPlayed=true: Skip intro dialog sequence
 *
 * SPECIAL PRESETS:
 * - POST_PORTAL: Robots spawn, plays full intro sequence
 * - ROBOTS_WANDERING: Robots wandering, dialogs complete, ready for voice input
 * - PANIC_MINIGAME: Robots panicking, need to be calmed by patting
 *
 * EXPORTS:
 * - parseDebugParams(): Returns debug state object from URL
 * - applyDebugParams(gameState): Applies parsed params to game state
 * - getDebugParamsString(): Returns URL params as string for logging
 *
 * USAGE: Called by gameState.js on initialization
 * =============================================================================
 */

import { GAME_STATES } from "../gameState.js";
import { Logger } from "./Logger.js";

const logger = new Logger("DebugSpawner", false);

/**
 * Custom overrides for specific states that need non-default settings
 */
const stateOverrides = {
  // Start screen - no special overrides
  START_SCREEN: {},

  // XR Active - default state when XR starts
  XR_ACTIVE: {},

  // Playing - skip to portal placement ready state
  PLAYING: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: false,
    introPlayed: true,
    callAnswered: true,
  },

  // Portal Placement - intro complete, ready to spawn robots
  PORTAL_PLACEMENT: {
    introPlayed: true,
  },
};

/**
 * Special debug presets that don't map directly to GAME_STATES
 * These set up complex state combinations for testing specific scenarios
 */
const specialPresets = {
  // Room capture UI - for testing room capture flow
  ROOM_CAPTURE: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: true, // Force room capture UI to show
    roomCaptureFailed: false,
    introPlayed: true,
    callAnswered: true,
    portalPlacementPlayed: true, // Skip portal placement dialog
  },

  // Portal just triggered - for testing portal/robot spawn sequence
  PORTAL_TRIGGERED: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: false, // Skip room capture
    introPlayed: true,
    callAnswered: true, // Skip incoming call UI
    portalPlacementPlayed: true,
    spawnPortalImmediately: true, // Flag for RobotSpawnerSystem to auto-spawn portal
    debugPortalOffset: { x: 0, y: 0, z: -2 }, // 2m in front of player on floor
  },

  // Post-portal: Robots spawn and play full intro sequence (gathered -> presentation -> wandering)
  POST_PORTAL: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: false, // Skip room capture
    introPlayed: true,
    callAnswered: true, // Skip incoming call UI
    robotsActive: true,
    voiceInputEnabled: true,
    robotBehavior: "wandering",
    spawnRobotsImmediately: true, // Flag for RobotSpawnerSystem to auto-spawn
  },

  // Robots wandering, intro dialogs complete - ready for user to speak greeting
  ROBOTS_WANDERING: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: false,
    introPlayed: true,
    callAnswered: true,
    portalPlacementPlayed: true, // Skip portal placement dialog
    ambassadorPresentationPlayed: true, // Skip ambassador/translation dialogs
    robotsActive: true,
    voiceInputEnabled: true,
    robotBehavior: "wandering",
    spawnRobotsImmediately: true,
  },

  // Panic minigame - robots wander then randomly start panicking
  PANIC_MINIGAME: {
    currentState: 6, // GAME_STATES.PORTAL_PLACEMENT
    roomSetupRequired: false,
    introPlayed: true,
    callAnswered: true,
    portalPlacementPlayed: true,
    ambassadorPresentationPlayed: true,
    robotsActive: true,
    voiceInputEnabled: true,
    robotBehavior: "wandering",
    startPanicMinigame: true, // Flag to start panic minigame after spawn
    spawnRobotsImmediately: true,
  },
};

/**
 * Generate a default preset for any game state
 * @param {number} stateValue - The GAME_STATES value
 * @returns {Object} State preset
 */
function createDefaultPreset(stateValue) {
  return {
    currentState: stateValue,
  };
}

/**
 * Get state preset - dynamically supports all GAME_STATES plus special presets
 * @param {string} stateName - Name of the state (e.g., "PLAYING" or "ROBOTS_WANDERING")
 * @returns {Object} State preset
 */
function getStatePreset(stateName) {
  // Check special presets first
  if (stateName in specialPresets) {
    return specialPresets[stateName];
  }

  if (!(stateName in GAME_STATES)) {
    return null;
  }

  const stateValue = GAME_STATES[stateName];
  const defaultPreset = createDefaultPreset(stateValue);
  const overrides = stateOverrides[stateName] || {};

  return {
    ...defaultPreset,
    ...overrides,
  };
}

/**
 * Debug state presets - dynamically generated for all GAME_STATES plus special presets
 */
export const debugStatePresets = new Proxy(
  {},
  {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in specialPresets || prop in GAME_STATES) {
          return getStatePreset(prop);
        }
      }
      return undefined;
    },
    has(target, prop) {
      return (
        typeof prop === "string" &&
        (prop in GAME_STATES || prop in specialPresets)
      );
    },
    ownKeys() {
      return [...Object.keys(GAME_STATES), ...Object.keys(specialPresets)];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (
        typeof prop === "string" &&
        (prop in GAME_STATES || prop in specialPresets)
      ) {
        return {
          enumerable: true,
          configurable: true,
        };
      }
      return undefined;
    },
  }
);

/**
 * Parse URL parameters and build debug state
 * @returns {Object|null} State preset if debug spawn is requested, null otherwise
 */
export function getDebugSpawnState() {
  const urlParams = new URLSearchParams(window.location.search);
  // Support both "debugSpawn" and "gameState" URL params
  const gameStateParam =
    urlParams.get("debugSpawn") || urlParams.get("gameState");

  if (!gameStateParam) {
    return null;
  }

  // Try to find matching preset
  const preset = debugStatePresets[gameStateParam];

  if (!preset) {
    logger.warn(`Unknown gameState "${gameStateParam}". Available states:`, [
      ...Object.keys(GAME_STATES),
      ...Object.keys(specialPresets),
    ]);
    return null;
  }

  // Start with preset, then apply any additional URL params
  const result = { ...preset };

  // Check for additional URL parameter overrides
  if (urlParams.has("introPlayed")) {
    result.introPlayed = urlParams.get("introPlayed") !== "false";
  }

  logger.log(`Debug spawn state "${gameStateParam}":`, result);
  return result;
}

/**
 * Check if debug spawn is active
 * @returns {boolean}
 */
export function isDebugSpawnActive() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.has("debugSpawn") || urlParams.has("gameState");
}

/**
 * Get the name of the current debug spawn state
 * @returns {string|null}
 */
export function getDebugSpawnStateName() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("debugSpawn") || urlParams.get("gameState");
}

export default {
  getDebugSpawnState,
  isDebugSpawnActive,
  getDebugSpawnStateName,
  debugStatePresets,
};
