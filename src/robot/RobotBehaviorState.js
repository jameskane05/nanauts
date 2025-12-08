/**
 * RobotBehaviorState.js - Robot behavior state enum and utilities
 * =============================================================================
 *
 * ROLE: Defines all possible robot behavior states for the state machine.
 * These states determine which managers are active and what behaviors
 * are allowed at any given moment.
 *
 * STATE CATEGORIES:
 *   - Movement states: IDLE, WANDERING, MOVING_TO_GOAL, STATIONARY
 *   - Action states: JUMPING, SCANNING
 *   - Social states: CHATTING, REACTING, APPROACHING
 *
 * TRANSITIONS:
 *   - Some states auto-complete and return to previous (JUMPING, SCANNING)
 *   - Others require explicit transitions (WANDERING -> STATIONARY)
 *   - Social states have priority and can interrupt movement
 *
 * =============================================================================
 */

export const ROBOT_STATE = Object.freeze({
  IDLE: "idle",
  WANDERING: "wandering",
  JUMPING: "jumping",
  SCANNING: "scanning",
  CHATTING: "chatting",
  REACTING: "reacting",
  APPROACHING: "approaching",
  MOVING_TO_GOAL: "moving_to_goal",
  STATIONARY: "stationary",
  ATTENDING_PLAYER: "attending_player",
  FOLLOWING_PLAYER: "following_player",
  FLYING_FOLLOW: "flying_follow",
  PANICKING: "panicking",
});

export const ROBOT_STATE_PRIORITY = Object.freeze({
  [ROBOT_STATE.IDLE]: 0,
  [ROBOT_STATE.WANDERING]: 1,
  [ROBOT_STATE.MOVING_TO_GOAL]: 2,
  [ROBOT_STATE.APPROACHING]: 3,
  [ROBOT_STATE.SCANNING]: 4,
  [ROBOT_STATE.CHATTING]: 5,
  [ROBOT_STATE.REACTING]: 6,
  [ROBOT_STATE.JUMPING]: 7,
  [ROBOT_STATE.STATIONARY]: 8,
  [ROBOT_STATE.ATTENDING_PLAYER]: 9,
  [ROBOT_STATE.FOLLOWING_PLAYER]: 10,
  [ROBOT_STATE.FLYING_FOLLOW]: 10,
  [ROBOT_STATE.PANICKING]: 11,
});

export function isMovementState(state) {
  return (
    state === ROBOT_STATE.WANDERING ||
    state === ROBOT_STATE.MOVING_TO_GOAL ||
    state === ROBOT_STATE.APPROACHING ||
    state === ROBOT_STATE.FOLLOWING_PLAYER ||
    state === ROBOT_STATE.PANICKING
  );
}

export function isActionState(state) {
  return state === ROBOT_STATE.JUMPING || state === ROBOT_STATE.SCANNING;
}

export function isSocialState(state) {
  return state === ROBOT_STATE.CHATTING || state === ROBOT_STATE.REACTING;
}

export function isPlayerInteractionState(state) {
  return (
    state === ROBOT_STATE.ATTENDING_PLAYER ||
    state === ROBOT_STATE.FOLLOWING_PLAYER ||
    state === ROBOT_STATE.FLYING_FOLLOW
  );
}

export function isAutoCompletingState(state) {
  return (
    state === ROBOT_STATE.JUMPING ||
    state === ROBOT_STATE.SCANNING ||
    state === ROBOT_STATE.REACTING
  );
}

export function canInterrupt(currentState, newState) {
  const currentPriority = ROBOT_STATE_PRIORITY[currentState] ?? 0;
  const newPriority = ROBOT_STATE_PRIORITY[newState] ?? 0;
  return newPriority >= currentPriority;
}
