/**
 * BrowserStateSystem.js - IWSDK VISIBILITY STATE TO GAME STATE SYNC
 * =============================================================================
 *
 * ROLE: ECS system that subscribes to IWSDK's visibilityState signal and
 * translates browser/XR lifecycle events into game state changes.
 *
 * KEY RESPONSIBILITIES:
 * - Subscribe to world.visibilityState signal
 * - Handle XR session lifecycle (entering, pausing, resuming, ending)
 * - Update gameState store based on visibility changes
 *
 * VISIBILITY STATES (from IWSDK):
 * - 'non-immersive': Not in XR (2D browser mode)
 * - 'visible': XR active and headset on
 * - 'hidden': XR paused (headset removed)
 * - 'visible-blurred': XR active but system UI showing
 *
 * STATE TRANSITIONS:
 * - ENTERING_XR + visible -> XR_ACTIVE (first entry)
 * - XR_ACTIVE + hidden -> XR_PAUSED (headset removed)
 * - XR_PAUSED + visible -> resume previous state
 * - any + non-immersive -> START_SCREEN (session ended)
 *
 * USAGE: Registered as ECS system in index.js, runs automatically
 * =============================================================================
 */

import { createSystem } from "@iwsdk/core";
import { GAME_STATES, gameState } from "../gameState.js";
import { Logger } from "../utils/Logger.js";

export class BrowserStateSystem extends createSystem({}, {}) {
  init() {
    this.logger = new Logger("BrowserStateSystem", false);
    this.logger.log("Initializing");

    // Subscribe to IWSDK's visibilityState signal
    this.world.visibilityState.subscribe((visState) => {
      this.handleVisibilityChange(visState);
    });
  }

  /**
   * Handle IWSDK visibilityState changes
   * @param {string} visState - 'non-immersive' | 'visible' | 'hidden' | 'visible-blurred'
   */
  handleVisibilityChange(visState) {
    const current = gameState.getState();
    const oldVisState = current.visibilityState;

    // Early return if no change - prevents firing state:changed every frame
    if (oldVisState === visState) {
      return;
    }

    // Update the raw visibility state
    gameState.setState({ visibilityState: visState });

    this.logger.log(`visibilityState: ${oldVisState} -> ${visState}`);

    if (visState === "visible") {
      // XR session is active and visible
      this.handleXRVisible(current);
    } else if (visState === "visible-blurred") {
      // System UI showing (Quest button pressed) - can show 2D overlay
      this.handleXRPaused(current, "blurred");
    } else if (visState === "hidden") {
      // Headset removed
      this.handleXRPaused(current, "hidden");
    } else if (visState === "non-immersive") {
      // XR session ended or not started
      this.handleXREnded(current);
    }
  }

  /**
   * XR became visible (session active)
   */
  handleXRVisible(current) {
    if (current.currentState === GAME_STATES.ENTERING_XR) {
      // Determine correct state based on game progress
      let targetState = GAME_STATES.XR_ACTIVE;

      // If intro/call already done and robots not spawned, resume portal placement
      if (
        current.introPlayed &&
        current.callAnswered &&
        !current.robotsActive
      ) {
        targetState = GAME_STATES.PORTAL_PLACEMENT;
        this.logger.log("XR entry -> PORTAL_PLACEMENT (resuming placement)");
      } else {
        this.logger.log("XR entry -> XR_ACTIVE");
      }

      gameState.setState({
        isXRActive: true,
        xrPauseReason: null,
        currentState: targetState,
        hasEnteredXR: true,
      });
    } else if (current.currentState === GAME_STATES.XR_PAUSED) {
      // Resuming from pause
      const resumeState = current.stateBeforePause || GAME_STATES.XR_ACTIVE;
      this.logger.log(`Resuming XR -> ${resumeState}`);
      gameState.setState({
        isXRActive: true,
        xrPauseReason: null,
        currentState: resumeState,
      });
    }
    // If already in XR_ACTIVE or PLAYING, no state change needed
  }

  /**
   * XR paused (headset removed or system UI)
   * @param {Object} current - Current game state
   * @param {string} reason - "blurred" (system UI) or "hidden" (headset removed)
   */
  handleXRPaused(current, reason) {
    // Only pause if we're in an active XR state
    if (
      current.currentState >= GAME_STATES.XR_ACTIVE &&
      current.currentState !== GAME_STATES.XR_PAUSED
    ) {
      this.logger.log(
        `XR paused (${reason}), saving state: ${current.currentState}`
      );
      gameState.setState({
        isXRActive: false,
        xrPauseReason: reason,
        stateBeforePause: current.currentState,
        currentState: GAME_STATES.XR_PAUSED,
      });
    }
  }

  /**
   * XR session ended completely
   */
  handleXREnded(current) {
    // Only handle if we were in XR
    if (current.isXRActive || current.currentState >= GAME_STATES.XR_ACTIVE) {
      this.logger.log("XR session ended -> START_SCREEN");
      gameState.setState({
        isXRActive: false,
        stateBeforePause: null,
        currentState: GAME_STATES.START_SCREEN,
      });
    }
  }

  update(delta, time) {
    // No per-frame updates needed - all logic is event-driven via visibilityState subscription
  }

  destroy() {
    this.logger.log("Destroyed");
  }
}
