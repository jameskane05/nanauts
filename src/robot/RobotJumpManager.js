/**
 * RobotJumpManager.js - Off-mesh traversal jump physics and animation
 * =============================================================================
 *
 * ROLE: Manages the physics and animation for robot jumps during navmesh
 * off-mesh connection traversal (jumping between surfaces).
 *
 * JUMP PHASES:
 *   0. ANTICIPATION - Squat and wind-up before launch, turn to face target
 *   1. ASCENT - Launch with stretch, forward lean, rising arc
 *   2. APEX - Peak height, slight stretch, begin counter-rotation
 *   3. DESCENT - Falling with backward lean, increasing stretch
 *   4. LANDING - Impact squash, bounce overshoot, settle to neutral
 *
 * DISNEY PRINCIPLES APPLIED:
 *   - Anticipation: Squat scales with jump size (bigger jump = more wind-up)
 *   - Squash & Stretch: Volume-preserving deformation throughout arc
 *   - Follow-through: Bounce overshoot on landing, lean decay
 *   - Secondary action: Lean into jump direction, counter-rotate for landing
 *
 * KEY METHODS:
 *   - updateJump(entityIndex, agent, squashState, deltaTime): Main update
 *   - isJumping(entityIndex): Check if robot is mid-jump
 *   - getJumpProgress(entityIndex): Get normalized jump progress (0-1)
 *
 * INTEGRATION:
 *   - Called from RobotSystem when agent.state === OFFMESH
 *   - Uses RobotAudioManager for effort sound
 *   - Sets face emotion via RobotSystem.setRobotFaceEmotion
 *
 * =============================================================================
 */
import { crowd } from "navcat/blocks";
import { Logger } from "../utils/Logger.js";

export class RobotJumpManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotJumpManager", false);

    // Jump state per robot
    this.jumpState = new Map();

    // Jump timing configuration
    this.config = {
      minDuration: 0.75, // Fastest possible jump (tiny hop)
      maxDuration: 1.4, // Slowest jump (big leap)
      durationPerMeter: 0.3, // Extra seconds per meter of distance
      minAnticipation: 0.2, // Shortest wind-up (small hop)
      maxAnticipation: 0.4, // Longest wind-up (big jump)
      landingTransitionDuration: 0.5, // Blend to nav facing/tilt after landing
    };

    // Lean intensity configuration
    this.leanConfig = {
      baseLeanForward: 0.25, // Base forward lean during ascent
      baseLeanBack: 0.45, // Base backward lean during descent
      windUpLean: -0.2, // Backward lean during anticipation
      leanSmoothing: 10, // Lerp speed for lean
    };

    // Squash/stretch configuration for jumps
    this.squashConfig = {
      anticipationSquash: 0.6, // Max squash during anticipation
      launchStretch: 1.0, // Stretch on launch
      apexStretch: 0.3, // Stretch at apex
      descentStretch: 0.5, // Additional stretch during descent
      landingSquash: -0.4, // Squash on landing impact
    };
  }

  getJumpState(entityIndex) {
    let state = this.jumpState.get(entityIndex);
    if (!state) {
      state = {
        isActive: false,
        startTime: 0,
        duration: 0,
        anticipationEnd: 0,
        startPosition: null,
        endPosition: null,
        targetAngle: null,
        startAngle: null,
        currentFacing: null,
        currentLean: 0,
        progress: 0,
        phase: "none", // 'anticipation', 'ascent', 'apex', 'descent', 'landing', 'none'
      };
      this.jumpState.set(entityIndex, state);
    }
    return state;
  }

  isJumping(entityIndex) {
    const state = this.jumpState.get(entityIndex);
    return state?.isActive || false;
  }

  getJumpProgress(entityIndex) {
    const state = this.jumpState.get(entityIndex);
    return state?.progress || 0;
  }

  getAnticipationEnd(entityIndex) {
    const state = this.jumpState.get(entityIndex);
    return state?.anticipationEnd || 0;
  }

  getCurrentFacing(entityIndex) {
    const state = this.jumpState.get(entityIndex);
    return state?.currentFacing;
  }

  getCurrentLean(entityIndex) {
    const state = this.jumpState.get(entityIndex);
    return state?.currentLean || 0;
  }

  /**
   * Start a jump for a robot
   * @param {number} entityIndex
   * @param {Array} startPos - [x, y, z]
   * @param {Array} endPos - [x, y, z]
   * @param {number} currentFacing - Current Y rotation angle
   * @param {number} durationMultiplier - Character-specific jump duration multiplier
   */
  startJump(
    entityIndex,
    startPos,
    endPos,
    currentFacing,
    durationMultiplier = 1.0
  ) {
    const state = this.getJumpState(entityIndex);

    // Calculate jump metrics
    const dx = endPos[0] - startPos[0];
    const dz = endPos[2] - startPos[2];
    const horizDist = Math.sqrt(dx * dx + dz * dz);
    const heightDiff = Math.abs(endPos[1] - startPos[1]);
    const totalDist = horizDist + heightDiff;

    // Duration scales with distance and character weight
    const baseDuration = Math.min(
      this.config.maxDuration,
      this.config.minDuration + totalDist * this.config.durationPerMeter
    );
    const duration = baseDuration * durationMultiplier;

    // Anticipation scales with jump size
    const jumpNormalized = Math.min(1, totalDist / 2);
    const anticipationTime =
      this.config.minAnticipation +
      (this.config.maxAnticipation - this.config.minAnticipation) *
        jumpNormalized;
    const anticipationEnd = anticipationTime / duration;

    // Calculate target facing direction
    const targetAngle = Math.atan2(dx, dz);

    state.isActive = true;
    state.startTime = performance.now();
    state.duration = duration;
    state.anticipationEnd = anticipationEnd;
    state.startPosition = [...startPos];
    state.endPosition = [...endPos];
    state.targetAngle = targetAngle;
    state.startAngle = currentFacing;
    state.currentFacing = currentFacing;
    state.currentLean = 0;
    state.progress = 0;
    state.phase = "anticipation";

    // Play effort sound
    const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
    if (voice) voice.effort();

    // Set awe face at start of jump
    this.robotSystem.setRobotFaceEmotion(entityIndex, "awe");

    this.logger.log(
      `Robot ${entityIndex} started jump: dist=${totalDist.toFixed(
        2
      )}m, duration=${duration.toFixed(2)}s`
    );
  }

  /**
   * Complete a jump (called when animation finishes)
   * @param {number} entityIndex
   * @param {number} agentId
   */
  completeJump(entityIndex, agentId) {
    const state = this.jumpState.get(entityIndex);
    if (!state) return;

    state.isActive = false;
    state.phase = "none";

    // Complete the navcat off-mesh connection
    if (this.robotSystem.agents) {
      crowd.completeOffMeshConnection(this.robotSystem.agents, agentId);
    }

    // Reset face to content after landing
    this.robotSystem.setRobotFaceEmotion(entityIndex, "content");

    this.logger.log(`Robot ${entityIndex} completed jump`);
  }

  /**
   * Update jump animation for a robot
   * @param {number} entityIndex
   * @param {Object} agent - Navcat crowd agent
   * @param {Object} squashState - From RobotMovementManager
   * @param {number} deltaTime
   * @returns {Object} { position, facing, lean, squash, isComplete, phase }
   */
  updateJump(entityIndex, agent, squashState, deltaTime) {
    const state = this.getJumpState(entityIndex);
    const anim = agent.offMeshAnimation;

    if (!state.isActive || !anim) {
      return null;
    }

    // Advance animation time
    anim.t += deltaTime;
    const progress = Math.min(1, anim.t / state.duration);
    state.progress = progress;

    // Check if jump is complete
    if (anim.t >= state.duration) {
      // Store landing state for smooth transition
      squashState.landingFacing = state.currentFacing;
      squashState.landingTilt = state.currentLean;
      squashState.landingTransitionTimer = 0;
      squashState.landingTransitionDuration =
        this.config.landingTransitionDuration;
      squashState.jumpProgress = 1.0;
      squashState.jumpAnticipationEnd = 0;

      return {
        position: [...state.endPosition],
        facing: state.currentFacing,
        lean: state.currentLean,
        squash: this.squashConfig.landingSquash,
        isComplete: true,
        phase: "landing",
      };
    }

    // Store progress for arm animations
    squashState.jumpProgress = progress;
    squashState.jumpAnticipationEnd = state.anticipationEnd;

    // Calculate position
    const position = this._calculatePosition(state, progress);

    // Calculate facing (turn to face jump direction)
    const facing = this._calculateFacing(state, progress, deltaTime);
    state.currentFacing = facing;

    // Calculate lean (forward/back tilt)
    const lean = this._calculateLean(state, progress, deltaTime);
    state.currentLean = lean;

    // Calculate squash/stretch
    const squash = this._calculateSquash(state, progress);

    // Update agent position
    agent.position[0] = position[0];
    agent.position[1] = position[1];
    agent.position[2] = position[2];

    return {
      position,
      facing,
      lean,
      squash,
      isComplete: false,
      phase: state.phase,
    };
  }

  /**
   * Calculate jump position with parabolic arc
   */
  _calculatePosition(state, progress) {
    const anticipationEnd = state.anticipationEnd;

    // During anticipation, stay in place
    let movementProgress = 0;
    if (progress >= anticipationEnd) {
      // Remap progress so movement happens in remaining time
      const linearProgress =
        (progress - anticipationEnd) / (1 - anticipationEnd);

      // Easing for floating robot: gentle thrust, smooth glide, soft landing
      const t = linearProgress;
      if (t < 0.5) {
        // Gentle acceleration
        movementProgress = 2 * t * t;
      } else {
        // Smooth deceleration
        movementProgress = 1 - Math.pow(-2 * t + 2, 2) / 2;
      }
    }

    // Horizontal interpolation
    const x =
      state.startPosition[0] +
      (state.endPosition[0] - state.startPosition[0]) * movementProgress;
    const z =
      state.startPosition[2] +
      (state.endPosition[2] - state.startPosition[2]) * movementProgress;

    // Vertical arc calculation
    const startY = state.startPosition[1];
    const endY = state.endPosition[1];
    const heightDiff = Math.abs(endY - startY);

    const dx = state.endPosition[0] - state.startPosition[0];
    const dz = state.endPosition[2] - state.startPosition[2];
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);

    // Arc height scales with height difference
    const arcHeight = Math.max(0.3, 0.3 + heightDiff * 0.4);
    const apexY = Math.max(startY, endY) + arcHeight;
    const ascentHeight = apexY - startY;
    const descentHeight = apexY - endY;

    // Calculate apex point (asymmetric for different height jumps)
    const totalVerticalTravel = ascentHeight + descentHeight;
    const apexPoint =
      totalVerticalTravel > 0.01 ? ascentHeight / totalVerticalTravel : 0.5;

    // Vertical easing - different for ascent vs descent
    let verticalProgress;
    if (movementProgress < apexPoint) {
      const ascentT = movementProgress / apexPoint;
      verticalProgress = ascentT * 0.5;
    } else {
      const descentT = (movementProgress - apexPoint) / (1 - apexPoint);
      const easedDescent = Math.pow(descentT, 0.2);
      verticalProgress = 0.5 + easedDescent * 0.5;
    }

    // Parabolic arc
    const parabola =
      -4 * arcHeight * Math.pow(verticalProgress - 0.5, 2) + arcHeight;
    const y =
      startY +
      (endY - startY) * verticalProgress +
      (verticalProgress > 0 ? parabola : 0);

    // Update phase based on progress
    if (progress < anticipationEnd) {
      state.phase = "anticipation";
    } else if (movementProgress < apexPoint) {
      state.phase = "ascent";
    } else if (movementProgress < apexPoint + 0.1) {
      state.phase = "apex";
    } else if (movementProgress < 0.95) {
      state.phase = "descent";
    } else {
      state.phase = "landing";
    }

    return [x, y, z];
  }

  /**
   * Calculate facing angle during jump (smooth turn toward target)
   */
  _calculateFacing(state, progress, deltaTime) {
    if (state.targetAngle === null) return state.currentFacing;

    let angleDiff = state.targetAngle - state.currentFacing;

    // Normalize to [-PI, PI]
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

    // Turn faster during anticipation, then lock in
    const turnSpeed = progress < state.anticipationEnd ? 12.0 : 6.0;
    const turnLerp = 1 - Math.exp(-turnSpeed * deltaTime);

    return state.currentFacing + angleDiff * turnLerp;
  }

  /**
   * Calculate forward/back lean during jump
   */
  _calculateLean(state, progress, deltaTime) {
    const anticipationEnd = state.anticipationEnd;
    const lc = this.leanConfig;

    // Calculate intensities based on jump geometry
    const dx = state.endPosition[0] - state.startPosition[0];
    const dz = state.endPosition[2] - state.startPosition[2];
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const startY = state.startPosition[1];
    const endY = state.endPosition[1];
    const heightDiff = Math.abs(endY - startY);
    const arcHeight = Math.max(0.3, 0.3 + heightDiff * 0.4);
    const apexY = Math.max(startY, endY) + arcHeight;
    const ascentHeight = apexY - startY;
    const descentHeight = apexY - endY;

    // Lateral factor for lean intensity
    const lateralFactor = Math.pow(horizontalDist, 1.3);
    const forwardIntensity = Math.min(
      2.2,
      Math.max(0.25, lateralFactor * 0.8 + ascentHeight * 0.3)
    );
    const backwardIntensity = Math.min(
      2.2,
      Math.max(0.25, lateralFactor * 0.9 + descentHeight * 0.2)
    );

    const baseLeanForward = lc.baseLeanForward * forwardIntensity;
    const baseLeanBack = lc.baseLeanBack * backwardIntensity;
    const windUpLean = lc.windUpLean * forwardIntensity;

    let targetLean = 0;

    if (progress < anticipationEnd) {
      // Anticipation: lean backwards to gather momentum
      const anticipationProgress = progress / anticipationEnd;
      if (anticipationProgress < 0.7) {
        const pullBackCurve = Math.sin(
          (anticipationProgress / 0.7) * Math.PI * 0.5
        );
        targetLean = windUpLean * pullBackCurve;
      } else {
        const releaseProgress = (anticipationProgress - 0.7) / 0.3;
        targetLean = windUpLean * (1 - releaseProgress * 1.3);
      }
    } else {
      const airProgress = (progress - anticipationEnd) / (1 - anticipationEnd);
      if (airProgress < 0.2) {
        // Ascent: forward momentum
        const ascentCurve = Math.sin((airProgress / 0.3) * Math.PI * 0.5);
        targetLean = baseLeanForward * ascentCurve;
      } else {
        // Counter-rotation: lean back as thrusters fire early
        const descentProgress = (airProgress - 0.3) / 0.7;
        targetLean =
          baseLeanForward - descentProgress * (baseLeanForward + baseLeanBack);
      }
    }

    // Smooth the lean
    const leanLerp = 1 - Math.exp(-lc.leanSmoothing * deltaTime);
    return state.currentLean + (targetLean - state.currentLean) * leanLerp;
  }

  /**
   * Calculate squash/stretch during jump
   */
  _calculateSquash(state, progress) {
    const anticipationEnd = state.anticipationEnd;
    const sc = this.squashConfig;

    // Calculate jump intensity for scaling
    const dx = state.endPosition[0] - state.startPosition[0];
    const dz = state.endPosition[2] - state.startPosition[2];
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const startY = state.startPosition[1];
    const endY = state.endPosition[1];
    const heightDiff = Math.abs(endY - startY);
    const arcHeight = Math.max(0.3, 0.3 + heightDiff * 0.4);
    const apexY = Math.max(startY, endY) + arcHeight;
    const ascentHeight = apexY - startY;

    const jumpIntensity = Math.min(
      1.5,
      Math.max(0.6, (ascentHeight + horizontalDist * 0.5) / 0.8)
    );

    if (progress < anticipationEnd) {
      // Anticipation: squash scales with jump size
      return (
        -Math.sin((progress / anticipationEnd) * Math.PI) *
        sc.anticipationSquash *
        jumpIntensity
      );
    }

    const airProgress = (progress - anticipationEnd) / (1 - anticipationEnd);

    if (airProgress < 0.25) {
      // Launch: stretch upward
      return Math.sin((airProgress / 0.25) * Math.PI) * sc.launchStretch;
    } else if (airProgress < 0.55) {
      // Apex: slight stretch
      return sc.apexStretch;
    } else if (airProgress < 0.85) {
      // Descent: increasing stretch
      const descentProgress = (airProgress - 0.55) / 0.3;
      return sc.apexStretch + descentProgress * sc.descentStretch;
    } else {
      // Pre-landing: anticipate squash
      const landProgress = (airProgress - 0.85) / 0.15;
      return 0.8 - landProgress * 1.5;
    }
  }

  /**
   * Update landing recovery (called after jump completes)
   * @param {Object} squashState
   * @param {number} deltaTime
   * @param {Object} squashConfig - From RobotMovementManager
   * @returns {number} Target squash value
   */
  updateLandingRecovery(squashState, deltaTime, squashConfig) {
    if (squashState.landingTimer >= squashConfig.landingRecovery) {
      return 0;
    }

    squashState.landingTimer += deltaTime;
    const progress = squashState.landingTimer / squashConfig.landingRecovery;

    if (progress < squashConfig.bouncePeak) {
      // Quick snap from squash to stretch overshoot
      const snapProgress = progress / squashConfig.bouncePeak;
      const eased = snapProgress * snapProgress * (3 - 2 * snapProgress);
      return -0.4 + (0.4 + squashConfig.bounceOvershoot) * eased;
    } else {
      // Settle from overshoot to neutral
      const settleProgress =
        (progress - squashConfig.bouncePeak) / (1 - squashConfig.bouncePeak);
      const eased = 1 - Math.pow(1 - settleProgress, 2);
      return squashConfig.bounceOvershoot * (1 - eased);
    }
  }

  /**
   * Decay residual jump lean when not jumping
   * @param {Object} squashState
   * @param {number} deltaTime
   */
  decayJumpLean(squashState, deltaTime) {
    if (!squashState.jumpLean) return;

    const leanLerp = 1 - Math.exp(-10 * deltaTime);
    squashState.jumpLean *= 1 - leanLerp;

    if (Math.abs(squashState.jumpLean) < 0.001) {
      squashState.jumpLean = 0;
    }
  }

  clear(entityIndex) {
    this.jumpState.delete(entityIndex);
  }

  clearAll() {
    this.jumpState.clear();
  }
}
