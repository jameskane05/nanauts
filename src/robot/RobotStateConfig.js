/**
 * RobotStateConfig.js - Declarative robot state configuration
 * =============================================================================
 *
 * ROLE: Defines behavior for each robot state declaratively. Each state config
 * specifies which managers are active, whether movement is allowed, and
 * valid state transitions.
 *
 * CONFIG PROPERTIES:
 *   - movement: boolean - Whether navmesh navigation is active
 *   - selectsTargets: boolean - Whether robot picks new wander targets
 *   - managers: string[] - List of manager keys to update this frame
 *   - canTransitionTo: string[] - Valid states to transition to
 *   - autoCompletes: boolean - Returns to previous state when done
 *   - interruptible: boolean - Can be interrupted by higher-priority states
 *
 * MANAGER KEYS:
 *   - 'movement': RobotMovementManager (tilt, facing, squash)
 *   - 'jump': RobotJumpManager (off-mesh traversal)
 *   - 'audio': RobotAudioManager (engines, voices)
 *   - 'face': RobotFaceManager (expressions, look-at)
 *   - 'arms': RobotArmManager (arm animations)
 *   - 'tie': RobotTieManager (tie physics)
 *   - 'thrust': RobotEngineThrustVFX (propulsion effects)
 *   - 'scan': RobotScanManager (scanning behavior)
 *   - 'interaction': RobotInteractionManager (robot-robot)
 *
 * =============================================================================
 */
import { ROBOT_STATE } from "./RobotBehaviorState.js";

export const ROBOT_STATE_CONFIG = Object.freeze({
  [ROBOT_STATE.IDLE]: {
    movement: false,
    selectsTargets: false,
    managers: ["movement", "audio", "face", "arms", "antenna", "tie", "thrust"],
    canTransitionTo: [
      ROBOT_STATE.WANDERING,
      ROBOT_STATE.SCANNING,
      ROBOT_STATE.CHATTING,
      ROBOT_STATE.MOVING_TO_GOAL,
      ROBOT_STATE.STATIONARY,
      ROBOT_STATE.ATTENDING_PLAYER,
      ROBOT_STATE.PANICKING,
    ],
    interruptible: true,
  },

  [ROBOT_STATE.WANDERING]: {
    movement: true,
    selectsTargets: true,
    managers: ["movement", "audio", "face", "arms", "antenna", "tie", "thrust"],
    canTransitionTo: [
      ROBOT_STATE.IDLE,
      ROBOT_STATE.JUMPING,
      ROBOT_STATE.SCANNING,
      ROBOT_STATE.CHATTING,
      ROBOT_STATE.APPROACHING,
      ROBOT_STATE.MOVING_TO_GOAL,
      ROBOT_STATE.STATIONARY,
      ROBOT_STATE.ATTENDING_PLAYER,
      ROBOT_STATE.PANICKING,
    ],
    interruptible: true,
  },

  [ROBOT_STATE.JUMPING]: {
    movement: false,
    selectsTargets: false,
    managers: ["jump", "audio", "face", "arms", "antenna", "thrust"],
    canTransitionTo: [ROBOT_STATE.WANDERING, ROBOT_STATE.MOVING_TO_GOAL],
    autoCompletes: true,
    interruptible: false,
  },

  [ROBOT_STATE.SCANNING]: {
    movement: false,
    selectsTargets: false,
    managers: ["scan", "audio", "face", "arms", "antenna", "thrust"],
    canTransitionTo: [ROBOT_STATE.WANDERING, ROBOT_STATE.CHATTING],
    autoCompletes: true,
    interruptible: false,
  },

  [ROBOT_STATE.CHATTING]: {
    movement: false,
    selectsTargets: false,
    managers: [
      "interaction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [
      ROBOT_STATE.REACTING,
      ROBOT_STATE.WANDERING,
      ROBOT_STATE.STATIONARY,
    ],
    interruptible: false,
  },

  [ROBOT_STATE.REACTING]: {
    movement: false,
    selectsTargets: false,
    managers: [
      "interaction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [ROBOT_STATE.CHATTING, ROBOT_STATE.WANDERING],
    autoCompletes: true,
    interruptible: false,
  },

  [ROBOT_STATE.APPROACHING]: {
    movement: true,
    selectsTargets: false,
    managers: [
      "movement",
      "interaction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [ROBOT_STATE.CHATTING, ROBOT_STATE.WANDERING],
    interruptible: true,
  },

  [ROBOT_STATE.MOVING_TO_GOAL]: {
    movement: true,
    selectsTargets: false,
    managers: ["movement", "audio", "face", "arms", "antenna", "tie", "thrust"],
    canTransitionTo: [
      ROBOT_STATE.JUMPING,
      ROBOT_STATE.SCANNING,
      ROBOT_STATE.STATIONARY,
      ROBOT_STATE.WANDERING,
      ROBOT_STATE.ATTENDING_PLAYER,
      ROBOT_STATE.PANICKING,
    ],
    interruptible: true,
  },

  [ROBOT_STATE.STATIONARY]: {
    movement: false,
    selectsTargets: false,
    managers: ["audio", "face", "arms", "antenna", "tie", "thrust"],
    canTransitionTo: [
      ROBOT_STATE.WANDERING,
      ROBOT_STATE.MOVING_TO_GOAL,
      ROBOT_STATE.CHATTING,
    ],
    interruptible: true,
  },

  [ROBOT_STATE.ATTENDING_PLAYER]: {
    movement: true,
    selectsTargets: false,
    managers: [
      "movement",
      "playerInteraction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [
      ROBOT_STATE.FOLLOWING_PLAYER,
      ROBOT_STATE.WANDERING,
      ROBOT_STATE.STATIONARY,
    ],
    interruptible: false,
  },

  [ROBOT_STATE.FOLLOWING_PLAYER]: {
    movement: true,
    selectsTargets: false,
    managers: [
      "movement",
      "playerInteraction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [
      ROBOT_STATE.FLYING_FOLLOW,
      ROBOT_STATE.ATTENDING_PLAYER,
      ROBOT_STATE.WANDERING,
    ],
    interruptible: true,
  },

  [ROBOT_STATE.FLYING_FOLLOW]: {
    movement: false,
    selectsTargets: false,
    managers: [
      "playerInteraction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [ROBOT_STATE.FOLLOWING_PLAYER, ROBOT_STATE.WANDERING],
    interruptible: true,
  },

  [ROBOT_STATE.PANICKING]: {
    movement: false, // Stop movement during panic
    selectsTargets: false,
    managers: [
      "movement",
      "playerInteraction",
      "audio",
      "face",
      "arms",
      "antenna",
      "tie",
      "thrust",
    ],
    canTransitionTo: [ROBOT_STATE.WANDERING, ROBOT_STATE.JUMPING],
    interruptible: false,
  },
});

export function getStateConfig(state) {
  return ROBOT_STATE_CONFIG[state] || ROBOT_STATE_CONFIG[ROBOT_STATE.IDLE];
}

export function isMovementAllowed(state) {
  const config = getStateConfig(state);
  return config.movement === true;
}

export function getActiveManagers(state) {
  const config = getStateConfig(state);
  return config.managers || [];
}

export function canTransitionFrom(fromState, toState) {
  const config = getStateConfig(fromState);
  return config.canTransitionTo?.includes(toState) ?? false;
}

export function isStateInterruptible(state) {
  const config = getStateConfig(state);
  return config.interruptible !== false;
}

export function doesStateAutoComplete(state) {
  const config = getStateConfig(state);
  return config.autoCompletes === true;
}
