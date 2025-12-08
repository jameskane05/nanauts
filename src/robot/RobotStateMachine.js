/**
 * RobotStateMachine.js - Per-robot state management
 * =============================================================================
 *
 * ROLE: Manages behavior state for each robot. Tracks current state,
 * validates transitions, and provides state metadata for the update loop.
 *
 * STATE TRACKING:
 *   - Current state per robot
 *   - Previous state (for auto-completing states to return to)
 *   - State entry time (for duration-based auto-complete)
 *   - State metadata (custom data for specific states)
 *
 * KEY METHODS:
 *   - getState(entityIndex): Get current state
 *   - setState(entityIndex, newState, metadata?): Transition to new state
 *   - canTransition(entityIndex, toState): Check if transition is valid
 *   - getActiveManagers(entityIndex): Get managers active for current state
 *   - onStateComplete(entityIndex): Handle auto-completing state finish
 *
 * INTEGRATION:
 *   - Used by RobotSystem to determine per-frame behavior
 *   - Managers check state to enable/disable their behavior
 *   - InteractionManager triggers state changes for social behaviors
 *
 * =============================================================================
 */
import { ROBOT_STATE, canInterrupt } from "./RobotBehaviorState.js";
import {
  getStateConfig,
  canTransitionFrom,
  doesStateAutoComplete,
  isStateInterruptible,
  getActiveManagers as getManagersForState,
} from "./RobotStateConfig.js";
import { Logger } from "../utils/Logger.js";

export class RobotStateMachine {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotStateMachine", false);

    // Per-robot state tracking
    this.states = new Map();
  }

  /**
   * Get or create state entry for a robot
   */
  _getStateEntry(entityIndex) {
    let entry = this.states.get(entityIndex);
    if (!entry) {
      entry = {
        currentState: ROBOT_STATE.IDLE,
        previousState: null,
        entryTime: performance.now(),
        metadata: null,
      };
      this.states.set(entityIndex, entry);
    }
    return entry;
  }

  /**
   * Get the current state for a robot
   */
  getState(entityIndex) {
    return this._getStateEntry(entityIndex).currentState;
  }

  /**
   * Get the previous state for a robot (for returning from auto-complete)
   */
  getPreviousState(entityIndex) {
    return this._getStateEntry(entityIndex).previousState;
  }

  /**
   * Get metadata associated with current state
   */
  getMetadata(entityIndex) {
    return this._getStateEntry(entityIndex).metadata;
  }

  /**
   * Get time since state was entered (ms)
   */
  getStateTime(entityIndex) {
    const entry = this._getStateEntry(entityIndex);
    return performance.now() - entry.entryTime;
  }

  /**
   * Check if a transition is valid
   */
  canTransition(entityIndex, toState) {
    const entry = this._getStateEntry(entityIndex);
    const fromState = entry.currentState;

    // Same state - no transition needed
    if (fromState === toState) return false;

    // Check if current state is interruptible
    if (!isStateInterruptible(fromState)) {
      // Can only interrupt if new state has higher priority
      if (!canInterrupt(fromState, toState)) {
        return false;
      }
    }

    // Check if transition is allowed by config
    return canTransitionFrom(fromState, toState);
  }

  /**
   * Transition to a new state
   * @param {number} entityIndex
   * @param {string} newState - State from ROBOT_STATE enum
   * @param {Object} metadata - Optional state-specific data
   * @returns {boolean} Whether transition succeeded
   */
  setState(entityIndex, newState, metadata = null) {
    const entry = this._getStateEntry(entityIndex);
    const oldState = entry.currentState;

    // Validate transition
    if (oldState === newState) {
      // Update metadata even if state unchanged
      if (metadata !== null) {
        entry.metadata = metadata;
      }
      return true;
    }

    // Check if transition is allowed
    if (!isStateInterruptible(oldState) && !canInterrupt(oldState, newState)) {
      this.logger.log(
        `Robot ${entityIndex}: Cannot transition from ${oldState} to ${newState} (not interruptible)`
      );
      return false;
    }

    // Store previous state for auto-completing states
    if (doesStateAutoComplete(newState)) {
      entry.previousState = oldState;
    }

    entry.currentState = newState;
    entry.entryTime = performance.now();
    entry.metadata = metadata;

    this.logger.log(`Robot ${entityIndex}: ${oldState} -> ${newState}`);

    return true;
  }

  /**
   * Force set state without validation (for initialization)
   */
  forceState(entityIndex, state, metadata = null) {
    const entry = this._getStateEntry(entityIndex);
    entry.previousState = entry.currentState;
    entry.currentState = state;
    entry.entryTime = performance.now();
    entry.metadata = metadata;
  }

  /**
   * Called when an auto-completing state finishes
   * Returns to previous state or falls back to default
   */
  onStateComplete(entityIndex) {
    const entry = this._getStateEntry(entityIndex);
    const currentState = entry.currentState;

    if (!doesStateAutoComplete(currentState)) {
      return;
    }

    // Return to previous state
    const returnState = entry.previousState || ROBOT_STATE.WANDERING;

    this.logger.log(
      `Robot ${entityIndex}: ${currentState} complete, returning to ${returnState}`
    );

    entry.previousState = null;
    entry.currentState = returnState;
    entry.entryTime = performance.now();
    entry.metadata = null;
  }

  /**
   * Get active manager keys for current state
   */
  getActiveManagers(entityIndex) {
    const state = this.getState(entityIndex);
    return getManagersForState(state);
  }

  /**
   * Check if a specific manager should be active
   */
  isManagerActive(entityIndex, managerKey) {
    return this.getActiveManagers(entityIndex).includes(managerKey);
  }

  /**
   * Check if robot movement is allowed in current state
   */
  isMovementAllowed(entityIndex) {
    const state = this.getState(entityIndex);
    const config = getStateConfig(state);
    // Robots 4 and 5 can navigate while panicking
    if (
      state === ROBOT_STATE.PANICKING &&
      (entityIndex === 4 || entityIndex === 5)
    ) {
      return true;
    }
    return config.movement === true;
  }

  /**
   * Check if robot should select new targets in current state
   */
  shouldSelectTargets(entityIndex) {
    const state = this.getState(entityIndex);
    const config = getStateConfig(state);
    // Robots 4 and 5 can select targets while panicking
    if (
      state === ROBOT_STATE.PANICKING &&
      (entityIndex === 4 || entityIndex === 5)
    ) {
      return true;
    }
    return config.selectsTargets === true;
  }

  /**
   * Clear state for a robot (on removal)
   */
  clear(entityIndex) {
    this.states.delete(entityIndex);
  }

  /**
   * Clear all state
   */
  clearAll() {
    this.states.clear();
  }

  /**
   * Get all robots in a specific state
   */
  getRobotsInState(state) {
    const result = [];
    for (const [entityIndex, entry] of this.states) {
      if (entry.currentState === state) {
        result.push(entityIndex);
      }
    }
    return result;
  }

  /**
   * Debug: Get state summary for all robots
   */
  getStateSummary() {
    const summary = {};
    for (const [entityIndex, entry] of this.states) {
      summary[entityIndex] = {
        state: entry.currentState,
        time: Math.floor(performance.now() - entry.entryTime),
        previous: entry.previousState,
      };
    }
    return summary;
  }
}
