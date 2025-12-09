/**
 * Game State Management
 * Central state store with event emitter pattern for the IWSDK Quest MR game.
 */

import {
  getDebugSpawnState,
  isDebugSpawnActive,
} from "./utils/DebugSpawner.js";
import { Logger } from "./utils/Logger.js";

export const GAME_STATES = {
  PLATFORM_CHECK: -2,
  UNSUPPORTED_PLATFORM: -1,
  LOADING: 0,
  START_SCREEN: 1,
  ENTERING_XR: 2,
  XR_ACTIVE: 3, // XR session started, visibilityState === 'visible'
  XR_PAUSED: 4, // XR paused (headset removed), visibilityState === 'hidden'/'visible-blurred'
  PLAYING: 5, // Actual gameplay in progress (intro playing)
  PORTAL_PLACEMENT: 6, // Intro complete, waiting for user to place robot portal
  // Game-specific states can be added here as needed
};

/**
 * Get the name of a game state from its numeric value
 */
export function getStateName(stateValue) {
  for (const [name, value] of Object.entries(GAME_STATES)) {
    if (value === stateValue) {
      return name;
    }
  }
  return "UNKNOWN";
}

/**
 * Reactive game state class with event emitter pattern
 */
export class GameState {
  constructor() {
    this.logger = new Logger("GameState", false);

    // Check for debug spawn state
    this.debugSpawnState = getDebugSpawnState();
    this.isDebugMode = isDebugSpawnActive();

    if (this.isDebugMode) {
      this.logger.log("Debug mode active:", this.debugSpawnState);
    }

    this.state = {
      currentState: GAME_STATES.PLATFORM_CHECK,

      // Platform info (set by platformDetection)
      isQuest: false,
      isEmulator: false,
      isWebXRSupported: false,
      isSupported: false,

      // Loading progress
      loadingProgress: 0,

      // XR session state
      isXRActive: false,
      hasEnteredXR: false, // True once user has entered XR at least once (for "RE-ENTER" vs "START")
      xrPauseReason: null, // "blurred" (system UI) or "hidden" (headset off) or null
      visibilityState: "non-immersive", // IWSDK values: 'non-immersive'|'visible'|'hidden'|'visible-blurred'
      stateBeforePause: null, // Stores state before XR pause for resume

      // Audio state
      musicVolume: 0.5, // Default 50%
      sfxVolume: 1.0, // Default 100%
      currentMusic: null,

      // Accessibility
      captionsEnabled: true,

      // UI state management (used by UIStateManager)
      roomSetupRequired: null, // null = unknown, true = need room capture, false = room ready
      roomCaptureFailed: false, // True if room capture was attempted but failed (can only try once)
      callRingPlayed: false, // True after incoming call ring has played (prevents re-ring on XR re-entry)
      callAnswered: false, // True after user answers incoming call
      introPlayed: false, // True after intro sequence completes
      portalPlacementPlayed: false, // True after portal placement dialog completes
      ambassadorPresentationPlayed: false, // True after robots are introduced

      // Robot/AI interaction state
      robotsActive: false, // True when robots have spawned and are wandering
      voiceInputEnabled: false, // True when voice recording UI is active
      goalPlacementEnabled: false, // True when hit-test goal placement is enabled

      // Robot behavior states
      friendlyGreetingReceived: false, // True after player gives friendly greeting
      greetingResult: null, // "positive" | "negative" | null - set after interpret, triggers dialog
      reassuranceResult: null, // "positive" | "negative" | null - set after reassurance interpret
      interpretMode: "greeting", // "greeting" | "reassurance" - what AI should look for
      robotsMovingToGoal: false, // True while robots are navigating to goal
      robotsAtGoal: false, // True when all robots have reached goal
      robotBehavior: "wandering", // "gathered" | "wandering" | "moving_to_goal" | "stationary"
      firstCalmCompleted: false, // True momentarily when first robot calmed in panic minigame
      secondCalmCompleted: false, // True momentarily when second robot calmed in panic minigame
      thirdCalmCompleted: false, // True momentarily when third robot calmed in panic minigame

      // Minigame state
      minigameActive: false, // True when panic minigame is active (disables voice input)
      panicMinigameCompleted: false, // True momentarily when panic minigame finishes

      // Input mode tracking (controllers vs hand tracking)
      inputMode: "controllers", // "controllers" | "hands" - determines UI prompts

      // Handedness preference (which wrist to mount UI on)
      handedness: "right", // "left" | "right" - determines wrist UI placement

      // Portal spawn location (used as goal destination)
      portalSpawnPosition: null, // {x, y, z} of initial portal

      // World reference (set after World.create)
      world: null,
    };

    this.eventListeners = {};
  }

  /**
   * Check if debug spawn is active
   * @returns {boolean}
   */
  hasDebugSpawn() {
    return this.isDebugMode && this.debugSpawnState !== null;
  }

  /**
   * Get the debug spawn state to apply after XR starts
   * @returns {Object|null} Debug state overrides or null
   */
  getDebugSpawnState() {
    return this.debugSpawnState;
  }

  /**
   * Get current state (returns a copy)
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Update state with new values
   * @param {Object} newState - State updates to apply
   */
  setState(newState) {
    const oldState = { ...this.state };

    // If transitioning to XR_ACTIVE and we have debug spawn state, merge it immediately
    // This ensures all listeners see the final debug state, not an intermediate state
    if (
      newState.currentState === GAME_STATES.XR_ACTIVE &&
      oldState.currentState !== GAME_STATES.XR_ACTIVE &&
      this.debugSpawnState &&
      !this._debugStateApplied
    ) {
      this._debugStateApplied = true;
      this.logger.log(
        "Merging debug spawn state with XR_ACTIVE transition:",
        this.debugSpawnState
      );
      newState = { ...newState, ...this.debugSpawnState };
      this.logger.log(
        "Merged state roomSetupRequired:",
        newState.roomSetupRequired
      );
    }

    this.state = { ...this.state, ...newState };

    // Debug: log roomSetupRequired changes
    if (
      newState.roomSetupRequired !== undefined &&
      newState.roomSetupRequired !== oldState.roomSetupRequired
    ) {
      this.logger.log(
        `roomSetupRequired changed: ${oldState.roomSetupRequired} -> ${newState.roomSetupRequired}`
      );
    }

    // Log state changes for currentState
    if (
      newState.currentState !== undefined &&
      newState.currentState !== oldState.currentState
    ) {
      this.logger.log(
        `State changed: ${getStateName(
          oldState.currentState
        )} -> ${getStateName(newState.currentState)}`
      );
    }

    // Log XR active changes
    if (
      newState.isXRActive !== undefined &&
      newState.isXRActive !== oldState.isXRActive
    ) {
      this.logger.log(`XR Active: ${newState.isXRActive}`);
    }

    this.emit("state:changed", this.state, oldState);
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }

  /**
   * Remove event listener
   */
  off(event, callback) {
    if (this.eventListeners[event]) {
      const index = this.eventListeners[event].indexOf(callback);
      if (index > -1) {
        this.eventListeners[event].splice(index, 1);
      }
    }
  }

  /**
   * Emit an event
   */
  emit(event, ...args) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach((callback) => callback(...args));
    }
  }

  /**
   * Set the IWSDK World reference
   */
  setWorld(world) {
    this.state.world = world;
  }

  /**
   * Get the IWSDK World reference
   */
  getWorld() {
    return this.state.world;
  }
}

// Export singleton instance
export const gameState = new GameState();
