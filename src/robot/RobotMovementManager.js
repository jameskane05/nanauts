/**
 * RobotMovementManager.js - Procedural movement animation (tilt, squash, banking)
 * =============================================================================
 *
 * ROLE: Manages all procedural animation that makes robots feel physical and
 * alive during movement. Applies Lasseter animation principles for appeal.
 *
 * ANIMATION SYSTEMS:
 *   - TILT: Forward lean when accelerating, backward when braking
 *   - BANKING: Lean into turns like a motorcycle
 *   - SQUASH/STRETCH: Compression on landing, stretch during jumps
 *   - ANTICIPATION: Wind-up squat before movement starts
 *   - FOLLOW-THROUGH: Overshoot and settle after stopping
 *   - IDLE FIDGET: Subtle breathing/sway when stationary
 *
 * STATE MAPS (keyed by entity index):
 *   - robotTiltState: Forward/back tilt and left/right bank
 *   - robotFacingState: Y rotation and turn rate smoothing
 *   - robotSquashState: Vertical scale + jump animation state
 *   - robotAnticipationState: Pre-movement wind-up
 *   - robotFollowThroughState: Post-movement settle
 *
 * KEY METHODS:
 *   - updateTilt(entityIndex, speed, accel, deltaTime): Update tilt/bank
 *   - updateFacing(entityIndex, targetAngle, deltaTime): Smooth Y rotation
 *   - updateSquash(entityIndex, deltaTime): Squash/stretch + jump handling
 *   - updateAnticipation/FollowThrough(): Secondary motion
 *   - getIdleFidget(entityIndex, time): Idle breathing animation
 *
 * DESIGN: "Feel it, don't see it" - subtle enough to be subconscious but
 * noticeable when removed. Quick recovery from extremes creates elastic feel.
 *
 * COORDINATE SYSTEM: Robot forward is -Y (Blender convention).
 * =============================================================================
 */
import { Logger } from "../utils/Logger.js";
import { MathUtils } from "three";

export class RobotMovementManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotMovementManager", false);

    // Pre-computed sin table for fast oscillation lookups (256 samples = ~1.4 degree resolution)
    this._sinTable = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      this._sinTable[i] = Math.sin((i / 256) * Math.PI * 2);
    }

    // Tilt state per robot
    this.robotTiltState = new Map();

    // Facing/turn state per robot
    this.robotFacingState = new Map();

    // Squash/stretch state per robot
    this.robotSquashState = new Map();

    // Anticipation state per robot (wind-up before actions)
    this.robotAnticipationState = new Map();

    // Follow-through state per robot (overshoot after actions)
    this.robotFollowThroughState = new Map();

    // Tilt configuration
    this.tiltConfig = {
      maxTilt: 0.25,
      accelerationScale: 0.05,
      cruiseTilt: 0.12,
      lerpSpeed: 5,
    };

    // Turn configuration
    this.turnConfig = {
      maxTurnSpeed: 4.0,
    };

    // Squash/stretch configuration - tuned for "feel it, don't see it"
    // Key: quick recovery from extreme poses creates elastic feel without being obvious
    this.squashConfig = {
      maxSquash: 0.2, // Subtle squash
      maxStretch: 0.12, // Subtle stretch
      landingRecovery: 0.18, // Quick recovery
      bounceOvershoot: 0.1, // Gentle bounce back
      bouncePeak: 0.2, // When bounce peaks (20% through recovery)
      lerpSpeed: 20, // Smooth transitions
    };

    // Anticipation configuration (wind-up before actions)
    this.anticipationConfig = {
      startMoveDuration: 0.12, // Duration of squat before accelerating
      startMoveSquash: -0.15, // Squat amount before starting
      stopDuration: 0.15, // Duration of forward lean before stopping
      stopLean: 0.08, // Extra forward lean when stopping
      turnWindupDuration: 0.1, // Brief lean opposite to turn
      turnWindupAmount: 0.06, // Opposite lean amount
    };

    // Follow-through configuration (overshoot after actions)
    this.followThroughConfig = {
      stopOvershoot: 0.04, // Backward lean overshoot when stopping
      stopSettleDuration: 0.25, // Time to settle after stopping
      turnOvershoot: 1.15, // Overshoot turn by 15%
      turnSettleSpeed: 8, // Spring back speed
    };

    // Idle fidget configuration (small movements when stationary)
    this.idleConfig = {
      fidgetIntervalMin: 1.5, // Min seconds between fidgets
      fidgetIntervalMax: 4.0, // Max seconds between fidgets
      fidgetDuration: 0.4, // Duration of each fidget
      maxTiltFidget: 0.03, // Max body tilt during fidget
      maxBankFidget: 0.04, // Max bank during fidget
    };

    // Idle state per robot
    this.robotIdleState = new Map();

    // Continuous hover/float state per robot
    this.robotHoverState = new Map();

    // Hover configuration - subtle continuous floating motion
    this.hoverConfig = {
      // Circular drift in XZ plane
      driftRadius: 0.008, // Very subtle ~8mm circular drift
      driftFrequency: 0.3, // Slow drift cycle (0.3 Hz = ~3.3 sec per circle)
      driftFrequencyVariance: 0.1, // Randomize frequency per robot
      // Vertical bob
      bobAmplitude: 0.006, // ~6mm vertical bob
      bobFrequency: 0.5, // Slightly faster than drift
      bobFrequencyVariance: 0.15,
      // Thruster tilt following drift direction
      tiltAmount: 0.025, // Max tilt in radians (~1.4 degrees)
      tiltLag: 0.15, // Tilt lags behind position slightly for organic feel
      // Secondary wobble disabled for performance
      wobbleAmplitude: 0,
      wobbleFrequency: 1.2,
    };
  }

  getTiltState(entityIndex) {
    let state = this.robotTiltState.get(entityIndex);
    if (!state) {
      state = {
        prevSpeed: 0,
        currentTilt: 0,
        currentBank: 0,
      };
      this.robotTiltState.set(entityIndex, state);
    }
    return state;
  }

  getFacingState(entityIndex, initialAngle = 0) {
    let state = this.robotFacingState.get(entityIndex);
    if (!state) {
      state = { currentFacing: initialAngle };
      this.robotFacingState.set(entityIndex, state);
    }
    return state;
  }

  getSquashState(entityIndex, baseScale = 1) {
    let state = this.robotSquashState.get(entityIndex);
    if (!state) {
      state = {
        currentSquash: 0,
        isJumping: false,
        jumpProgress: 0,
        landingTimer: 0,
        baseScale: baseScale,
        // Jump rotation state
        jumpTargetAngle: null, // Target facing angle during jump
        jumpStartAngle: null, // Facing angle when jump started
        jumpLean: 0, // Forward/back lean during jump
        currentJumpFacing: null, // Current smoothed facing during jump
      };
      this.robotSquashState.set(entityIndex, state);
    }
    return state;
  }

  getAnticipationState(entityIndex) {
    let state = this.robotAnticipationState.get(entityIndex);
    if (!state) {
      state = {
        phase: "none", // "none", "start", "stop", "turn"
        timer: 0,
        wasMoving: false,
        prevTurnRate: 0,
        anticipationSquash: 0, // Additional squash from anticipation
        anticipationTilt: 0, // Additional tilt from anticipation
      };
      this.robotAnticipationState.set(entityIndex, state);
    }
    return state;
  }

  getFollowThroughState(entityIndex) {
    let state = this.robotFollowThroughState.get(entityIndex);
    if (!state) {
      state = {
        phase: "none", // "none", "settling"
        timer: 0,
        overshootTilt: 0, // Current overshoot amount
        overshootVelocity: 0, // Spring velocity for settling
      };
      this.robotFollowThroughState.set(entityIndex, state);
    }
    return state;
  }

  getIdleState(entityIndex) {
    let state = this.robotIdleState.get(entityIndex);
    if (!state) {
      const cfg = this.idleConfig;
      state = {
        nextFidgetTime:
          performance.now() / 1000 +
          cfg.fidgetIntervalMin +
          Math.random() * (cfg.fidgetIntervalMax - cfg.fidgetIntervalMin),
        isFidgeting: false,
        fidgetTimer: 0,
        fidgetTilt: 0, // Target tilt for this fidget
        fidgetBank: 0, // Target bank for this fidget
        currentFidgetTilt: 0, // Smoothed current values
        currentFidgetBank: 0,
      };
      this.robotIdleState.set(entityIndex, state);
    }
    return state;
  }

  getHoverState(entityIndex) {
    let state = this.robotHoverState.get(entityIndex);
    if (!state) {
      const cfg = this.hoverConfig;
      // Randomize phases and frequencies per robot for variety
      state = {
        // Phase offsets (0-2PI) for desynchronization
        driftPhase: Math.random() * Math.PI * 2,
        bobPhase: Math.random() * Math.PI * 2,
        wobblePhaseX: Math.random() * Math.PI * 2,
        wobblePhaseZ: Math.random() * Math.PI * 2,
        // Per-robot frequency variations
        driftFreq:
          cfg.driftFrequency +
          (Math.random() - 0.5) * 2 * cfg.driftFrequencyVariance,
        bobFreq:
          cfg.bobFrequency +
          (Math.random() - 0.5) * 2 * cfg.bobFrequencyVariance,
        // Current smooth tilt values (lagged behind position)
        currentTiltX: 0,
        currentTiltZ: 0,
        // Drift direction randomization (some robots drift CW, some CCW)
        driftDirection: Math.random() > 0.5 ? 1 : -1,
      };
      this.robotHoverState.set(entityIndex, state);
    }
    return state;
  }

  /**
   * Get all movement states in a single call (performance optimization).
   * Reduces multiple Map.get() operations to one consolidated lookup.
   * @param {number} entityIndex
   * @param {number} baseScale - Base scale for squash state
   * @param {number} initialFacing - Initial facing angle
   * @returns {{ squash, tilt, facing }} All movement states
   */
  getAllStates(entityIndex, baseScale = 1, initialFacing = 0) {
    return {
      squash: this.getSquashState(entityIndex, baseScale),
      tilt: this.getTiltState(entityIndex),
      facing: this.getFacingState(entityIndex, initialFacing),
    };
  }

  /**
   * Fast sin lookup using pre-computed table
   * @param {number} normalizedAngle - 0-1 representing 0-2PI
   * @returns {number} sin value
   */
  _fastSin(normalizedAngle) {
    const idx = Math.floor((normalizedAngle % 1) * 256) & 255;
    return this._sinTable[idx];
  }

  /**
   * Fast cos lookup using pre-computed sin table (cos = sin + 0.25)
   * @param {number} normalizedAngle - 0-1 representing 0-2PI
   * @returns {number} cos value
   */
  _fastCos(normalizedAngle) {
    const idx = Math.floor(((normalizedAngle + 0.25) % 1) * 256) & 255;
    return this._sinTable[idx];
  }

  /**
   * Update continuous hover/float animation
   * Creates subtle circular drift + bob + thruster tilt
   * Always active - robots are always hovering, even during movement/jumps
   * @param {number} entityIndex
   * @param {number} time - Current time in seconds
   * @param {number} deltaTime
   * @param {number} speed - Current movement speed (used to slightly dampen hover during fast movement)
   * @param {boolean} isJumping - Whether robot is mid-jump
   * @returns {{ offsetX: number, offsetY: number, offsetZ: number, tiltX: number, tiltZ: number }}
   */
  updateHover(entityIndex, time, deltaTime, speed = 0, isJumping = false) {
    const state = this.getHoverState(entityIndex);
    const cfg = this.hoverConfig;

    // Scale factor: full effect when idle, reduced (but never zero) during movement/jumps
    // This blends hover with other animations without overwhelming them
    const speedDampen = Math.max(0.4, 1 - Math.min(speed / 2, 0.6));
    const jumpDampen = isJumping ? 0.5 : 1.0;
    const blendScale = speedDampen * jumpDampen;

    // Circular drift in XZ plane (using fast sin table)
    const driftNorm =
      (time * state.driftFreq + state.driftPhase) * state.driftDirection;
    const driftX = this._fastCos(driftNorm) * cfg.driftRadius * blendScale;
    const driftZ = this._fastSin(driftNorm) * cfg.driftRadius * blendScale;

    // Vertical bob - always present, gives life to the hover
    const bobNorm = time * state.bobFreq + state.bobPhase;
    const bob = this._fastSin(bobNorm) * cfg.bobAmplitude * blendScale;

    // Combined position offsets (wobble disabled for performance)
    const offsetX = driftX;
    const offsetY = bob;
    const offsetZ = driftZ;

    // Thruster tilt - tilts opposite to drift direction (lean into motion)
    // Tilt X (pitch) based on Z drift, Tilt Z (roll) based on X drift
    const targetTiltX =
      -driftZ * (cfg.tiltAmount / cfg.driftRadius) * (blendScale > 0 ? 1 : 0);
    const targetTiltZ =
      driftX * (cfg.tiltAmount / cfg.driftRadius) * (blendScale > 0 ? 1 : 0);

    // Smooth tilt with lag for organic feel
    const tiltLerp = 1 - Math.exp(-cfg.tiltLag * 60 * deltaTime);
    state.currentTiltX += (targetTiltX - state.currentTiltX) * tiltLerp;
    state.currentTiltZ += (targetTiltZ - state.currentTiltZ) * tiltLerp;

    return {
      offsetX,
      offsetY,
      offsetZ,
      tiltX: state.currentTiltX,
      tiltZ: state.currentTiltZ,
    };
  }

  updateSquash(entityIndex, agentY, baseScale, deltaTime, currentFacing = 0) {
    const squashState = this.getSquashState(entityIndex, baseScale);
    const rs = this.robotSystem;

    // Get agent data for jump detection
    const agentId = rs.robotAgentIds.get(entityIndex);
    const agent = rs.agents?.agents?.[agentId];
    if (!agent)
      return {
        squash: 0,
        scaleY: baseScale,
        scaleXZ: baseScale,
        isJumping: false,
        jumpFacing: null,
        jumpLean: 0,
      };

    const isInAir = agent.isInAir ?? false;
    const jumpInfo = agent.jumpInfo;

    let targetSquash = 0;
    let targetJumpLean = 0;

    if (isInAir && jumpInfo) {
      // Starting a new jump - capture start/end positions for facing
      if (!squashState.isJumping) {
        squashState.landingTimer = 0;
        squashState.jumpStartAngle = currentFacing;

        // Calculate target facing toward jump end position
        const startPos = jumpInfo.startPos || agent.position;
        const endPos = jumpInfo.endPos;
        if (endPos && startPos) {
          const dx = endPos[0] - startPos[0];
          const dz = endPos[2] - startPos[2];
          if (Math.sqrt(dx * dx + dz * dz) > 0.1) {
            squashState.jumpTargetAngle = Math.atan2(dx, dz);
          } else {
            squashState.jumpTargetAngle = currentFacing;
          }
        } else {
          squashState.jumpTargetAngle = currentFacing;
        }
        squashState.currentJumpFacing = currentFacing;
      }
      squashState.isJumping = true;

      const anticipationEnd = jumpInfo.anticipationEnd || 0.2;
      const jumpProgress = jumpInfo.progress ?? 0;
      const landingStart = 0.8;
      const peakProgress = 0.5; // Mid-point of air phase

      // Squash/stretch based on jump phase
      if (jumpProgress < anticipationEnd) {
        // Anticipation: squat down
        const anticipationProgress = jumpProgress / anticipationEnd;
        const eased = Math.sin(anticipationProgress * Math.PI);
        targetSquash = -eased * 0.8;
        // Lean back slightly during anticipation
        targetJumpLean = -0.15 * eased;
      } else if (jumpProgress < landingStart) {
        // In air: stretch
        const airProgress =
          (jumpProgress - anticipationEnd) / (landingStart - anticipationEnd);
        targetSquash = Math.sin(airProgress * Math.PI) * 0.6;

        // Lean forward during ascent, level at peak, back during descent
        const normalizedAir = airProgress * 2 - 1; // -1 to 1 over air phase
        // Parabolic lean: forward at start of air, level at peak, backward approaching landing
        targetJumpLean =
          0.3 * (1 - normalizedAir * normalizedAir) - 0.1 * normalizedAir;
      } else {
        // Landing: squash
        const landingProgress =
          (jumpProgress - landingStart) / (1 - landingStart);
        targetSquash = -landingProgress * 0.6;
        // Lean back during landing
        targetJumpLean = -0.2 * landingProgress;
      }

      // Smoothly rotate toward jump target angle during anticipation and early flight
      if (squashState.jumpTargetAngle !== null) {
        let angleDiff =
          squashState.jumpTargetAngle - squashState.currentJumpFacing;
        // Normalize to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        // Faster turn during anticipation phase, then maintain direction
        const turnSpeed = jumpProgress < anticipationEnd ? 15.0 : 8.0;
        const turnLerp = 1 - Math.exp(-turnSpeed * deltaTime);
        squashState.currentJumpFacing += angleDiff * turnLerp;
      }
    } else {
      if (squashState.isJumping) {
        // Just landed
        squashState.isJumping = false;
        squashState.landingTimer = 0;
        squashState.currentSquash = -0.6;
        squashState.jumpTargetAngle = null;
        squashState.currentJumpFacing = null;
        targetJumpLean = -0.15; // Impact lean
      } else if (squashState.landingTimer < this.squashConfig.landingRecovery) {
        squashState.landingTimer += deltaTime;
        const recoveryProgress =
          squashState.landingTimer / this.squashConfig.landingRecovery;
        targetSquash = -0.6 * (1 - recoveryProgress);
        targetJumpLean = -0.15 * (1 - recoveryProgress);
      }
    }

    // Smooth squash
    const squashLerpFactor =
      1 - Math.exp(-this.squashConfig.lerpSpeed * deltaTime);
    squashState.currentSquash +=
      (targetSquash - squashState.currentSquash) * squashLerpFactor;

    // Smooth jump lean
    const leanLerpFactor = 1 - Math.exp(-12 * deltaTime);
    squashState.jumpLean +=
      (targetJumpLean - squashState.jumpLean) * leanLerpFactor;

    const squashAmount = squashState.currentSquash;
    let scaleY = baseScale;
    let scaleXZ = baseScale;

    if (Math.abs(squashAmount) > 0.01) {
      if (squashAmount < 0) {
        scaleY = baseScale * (1 + squashAmount * this.squashConfig.maxSquash);
        scaleXZ = baseScale / Math.sqrt(scaleY / baseScale);
      } else {
        scaleY = baseScale * (1 + squashAmount * this.squashConfig.maxStretch);
        scaleXZ = baseScale / Math.sqrt(scaleY / baseScale);
      }
    }

    return {
      squash: squashAmount,
      scaleY,
      scaleXZ,
      isJumping: squashState.isJumping,
      jumpFacing: squashState.isJumping ? squashState.currentJumpFacing : null,
      jumpLean: squashState.jumpLean,
    };
  }

  /**
   * Update anticipation (wind-up before actions)
   * Detects start/stop/sharp turn and applies brief opposite motion
   */
  updateAnticipation(entityIndex, speed, turnRate, deltaTime) {
    const state = this.getAnticipationState(entityIndex);
    const cfg = this.anticipationConfig;

    const isMoving = speed > 0.1;
    const isSharpTurn = Math.abs(turnRate) > 2.0;

    // Detect start of movement
    if (isMoving && !state.wasMoving && state.phase === "none") {
      state.phase = "start";
      state.timer = 0;
    }
    // Detect stop
    else if (!isMoving && state.wasMoving && state.phase === "none") {
      state.phase = "stop";
      state.timer = 0;
    }
    // Detect sharp turn start
    else if (
      isSharpTurn &&
      Math.abs(state.prevTurnRate) < 1.5 &&
      state.phase === "none"
    ) {
      state.phase = "turn";
      state.timer = 0;
      state.turnDirection = Math.sign(turnRate);
    }

    state.wasMoving = isMoving;
    state.prevTurnRate = turnRate;

    // Process current anticipation phase
    let targetSquash = 0;
    let targetTilt = 0;

    if (state.phase === "start") {
      state.timer += deltaTime;
      const progress = state.timer / cfg.startMoveDuration;
      if (progress < 1) {
        // Squat down before accelerating (sine curve for smooth in/out)
        const eased = Math.sin(progress * Math.PI);
        targetSquash = cfg.startMoveSquash * eased;
      } else {
        state.phase = "none";
      }
    } else if (state.phase === "stop") {
      state.timer += deltaTime;
      const progress = state.timer / cfg.stopDuration;
      if (progress < 1) {
        // Lean forward before settling
        const eased = Math.sin(progress * Math.PI);
        targetTilt = cfg.stopLean * eased;
      } else {
        state.phase = "none";
        // Trigger follow-through
        const ftState = this.getFollowThroughState(entityIndex);
        ftState.phase = "settling";
        ftState.timer = 0;
        ftState.overshootVelocity = -cfg.stopLean * 2; // Initial backward velocity
      }
    } else if (state.phase === "turn") {
      state.timer += deltaTime;
      const progress = state.timer / cfg.turnWindupDuration;
      if (progress < 1) {
        // Lean opposite to turn direction briefly
        const eased = Math.sin(progress * Math.PI);
        targetTilt = -state.turnDirection * cfg.turnWindupAmount * eased;
      } else {
        state.phase = "none";
      }
    }

    // Smooth the anticipation values
    const lerpFactor = 1 - Math.exp(-20 * deltaTime);
    state.anticipationSquash = MathUtils.lerp(
      state.anticipationSquash,
      targetSquash,
      lerpFactor
    );
    state.anticipationTilt = MathUtils.lerp(
      state.anticipationTilt,
      targetTilt,
      lerpFactor
    );

    return {
      squash: state.anticipationSquash,
      tilt: state.anticipationTilt,
    };
  }

  /**
   * Update follow-through (overshoot and settle after actions)
   * Uses damped spring physics for natural settling
   */
  updateFollowThrough(entityIndex, deltaTime) {
    const state = this.getFollowThroughState(entityIndex);
    const cfg = this.followThroughConfig;

    if (state.phase === "settling") {
      state.timer += deltaTime;

      // Damped spring physics
      const springStiffness = 120;
      const damping = 0.82;

      // Spring force toward zero
      const springForce = -state.overshootTilt * springStiffness;
      state.overshootVelocity += springForce * deltaTime;
      state.overshootVelocity *= damping;
      state.overshootTilt += state.overshootVelocity * deltaTime;

      // Clamp overshoot
      state.overshootTilt = MathUtils.clamp(state.overshootTilt, -0.15, 0.15);

      // End settling when nearly still
      if (
        state.timer > cfg.stopSettleDuration ||
        (Math.abs(state.overshootTilt) < 0.001 &&
          Math.abs(state.overshootVelocity) < 0.01)
      ) {
        state.phase = "none";
        state.overshootTilt = 0;
        state.overshootVelocity = 0;
      }
    }

    return {
      tilt: state.overshootTilt,
    };
  }

  /**
   * Update idle fidgets (small random movements when stationary)
   * Creates life-like micro-movements
   */
  updateIdle(entityIndex, isStationary, deltaTime) {
    const state = this.getIdleState(entityIndex);
    const cfg = this.idleConfig;
    const now = performance.now() / 1000;

    // Only fidget when stationary
    if (!isStationary) {
      // Reset fidget when moving
      state.isFidgeting = false;
      state.currentFidgetTilt = 0;
      state.currentFidgetBank = 0;
      return { tilt: 0, bank: 0 };
    }

    // Check if it's time for a new fidget
    if (!state.isFidgeting && now >= state.nextFidgetTime) {
      state.isFidgeting = true;
      state.fidgetTimer = 0;
      // Random fidget direction
      state.fidgetTilt = (Math.random() - 0.5) * 2 * cfg.maxTiltFidget;
      state.fidgetBank = (Math.random() - 0.5) * 2 * cfg.maxBankFidget;
    }

    // Process active fidget
    if (state.isFidgeting) {
      state.fidgetTimer += deltaTime;
      const progress = state.fidgetTimer / cfg.fidgetDuration;

      if (progress >= 1) {
        // Fidget complete, schedule next
        state.isFidgeting = false;
        state.nextFidgetTime =
          now +
          cfg.fidgetIntervalMin +
          Math.random() * (cfg.fidgetIntervalMax - cfg.fidgetIntervalMin);
        state.fidgetTilt = 0;
        state.fidgetBank = 0;
      } else {
        // Sine curve for smooth fidget (up and back)
        const ease = Math.sin(progress * Math.PI);
        state.currentFidgetTilt = state.fidgetTilt * ease;
        state.currentFidgetBank = state.fidgetBank * ease;
      }
    }

    // Smooth decay when not fidgeting
    const lerpFactor = 1 - Math.exp(-10 * deltaTime);
    state.currentFidgetTilt = MathUtils.lerp(
      state.currentFidgetTilt,
      0,
      state.isFidgeting ? 0 : lerpFactor
    );
    state.currentFidgetBank = MathUtils.lerp(
      state.currentFidgetBank,
      0,
      state.isFidgeting ? 0 : lerpFactor
    );

    return {
      tilt: state.currentFidgetTilt,
      bank: state.currentFidgetBank,
    };
  }

  /**
   * Update tilt from speed and acceleration
   * @param {number} entityIndex
   * @param {number} speed - Current speed
   * @param {number} deltaTime
   * @returns {{ smoothedSpeed: number, acceleration: number }}
   */
  updateTilt(entityIndex, speed, deltaTime) {
    const tiltState = this.getTiltState(entityIndex);

    // Smooth the speed tracking to reduce jitter
    const speedSmoothing = 0.15;
    const smoothedSpeed =
      tiltState.prevSpeed + (speed - tiltState.prevSpeed) * speedSmoothing;

    // Calculate acceleration (change in smoothed speed)
    const acceleration =
      (smoothedSpeed - tiltState.prevSpeed) / Math.max(deltaTime, 0.016);
    tiltState.prevSpeed = smoothedSpeed;

    // Target tilt: accelerating = lean forward, decelerating = lean backward
    const tc = this.tiltConfig;
    const accelTilt = acceleration * tc.accelerationScale;
    const normalizedSpeed = Math.min(smoothedSpeed / 1.4, 1.0);
    const cruiseTilt = normalizedSpeed * tc.cruiseTilt;
    let targetTilt = accelTilt + cruiseTilt;

    // Clamp target tilt
    targetTilt = Math.max(-tc.maxTilt, Math.min(tc.maxTilt, targetTilt));

    // Smooth lerp toward target
    const tiltLerpFactor = 1 - Math.exp(-tc.lerpSpeed * deltaTime);
    tiltState.currentTilt +=
      (targetTilt - tiltState.currentTilt) * tiltLerpFactor;

    // Clamp final tilt
    tiltState.currentTilt = Math.max(
      -tc.maxTilt * 1.5,
      Math.min(tc.maxTilt * 1.5, tiltState.currentTilt)
    );

    return { smoothedSpeed, acceleration };
  }

  /**
   * Update facing angle toward target with turn rate limiting
   * @param {number} entityIndex
   * @param {number|null} targetAngle - Target Y rotation (null to keep current)
   * @param {number} deltaTime
   * @param {number} turnSpeedMultiplier - Character-specific turn speed multiplier (default 1.0)
   * @returns {{ turnRate: number, facingAngle: number }}
   */
  updateFacing(entityIndex, targetAngle, deltaTime, turnSpeedMultiplier = 1.0) {
    const facingState = this.getFacingState(entityIndex, targetAngle ?? 0);

    let turnRate = 0;
    if (targetAngle !== null) {
      let angleDiff = targetAngle - facingState.currentFacing;
      // Normalize to [-PI, PI]
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      const maxTurn =
        this.turnConfig.maxTurnSpeed * turnSpeedMultiplier * deltaTime;
      if (Math.abs(angleDiff) > maxTurn) {
        angleDiff = Math.sign(angleDiff) * maxTurn;
      }
      facingState.currentFacing += angleDiff;
      turnRate = angleDiff / Math.max(deltaTime, 0.016);
    }

    return { turnRate, facingAngle: facingState.currentFacing };
  }

  /**
   * Update bank from turn rate and speed
   * @param {number} entityIndex
   * @param {number} turnRate
   * @param {number} smoothedSpeed
   * @param {number} deltaTime
   * @returns {number} Current bank angle
   */
  updateBank(entityIndex, turnRate, smoothedSpeed, deltaTime) {
    const tiltState = this.getTiltState(entityIndex);

    const bankScale = 0.15;
    const maxBank = 0.25;
    const speedFactor = Math.min(smoothedSpeed / 1.4, 1.0);
    let targetBank = -turnRate * bankScale * speedFactor;
    targetBank = Math.max(-maxBank, Math.min(maxBank, targetBank));

    const bankLerpFactor = 1 - Math.exp(-8 * deltaTime);
    tiltState.currentBank +=
      (targetBank - tiltState.currentBank) * bankLerpFactor;

    return tiltState.currentBank;
  }

  /**
   * Combine tilt and bank with jump/landing transitions
   * @param {Object} squashState - From getSquashState
   * @param {Object} tiltState - From getTiltState
   * @param {number} normalTilt - Combined normal tilt value
   * @param {number} normalBank - Combined normal bank value
   * @param {number} deltaTime
   * @returns {{ combinedTilt: number, combinedBank: number }}
   */
  combineTiltBank(squashState, tiltState, normalTilt, normalBank, deltaTime) {
    const jumpLean = squashState.jumpLean || 0;

    let combinedTilt;
    let combinedBank;

    if (squashState.isJumping) {
      // During jump: use jump lean directly
      combinedTilt = jumpLean;
      combinedBank = 0;
    } else if (
      squashState.landingTilt !== undefined &&
      squashState.landingTransitionTimer < squashState.landingTransitionDuration
    ) {
      // Landing transition: blend from landing tilt to normal tilt
      const transitionProgress = Math.min(
        1,
        squashState.landingTransitionTimer /
          squashState.landingTransitionDuration
      );
      const eased = 1 - Math.pow(1 - transitionProgress, 2);
      combinedTilt =
        squashState.landingTilt +
        (normalTilt - squashState.landingTilt) * eased;
      combinedBank = normalBank * eased;

      if (transitionProgress >= 1) {
        squashState.landingTilt = undefined;
      }
    } else {
      combinedTilt = normalTilt;
      combinedBank = normalBank;
    }

    return { combinedTilt, combinedBank };
  }

  /**
   * Blend facing angle during landing transition
   * @param {Object} squashState
   * @param {Object} facingState
   * @param {number} deltaTime
   * @returns {number} Blended facing angle
   */
  blendFacing(squashState, facingState, deltaTime) {
    if (squashState.isJumping && squashState.currentJumpFacing !== null) {
      facingState.currentFacing = squashState.currentJumpFacing;
      return squashState.currentJumpFacing;
    }

    if (
      squashState.landingFacing !== undefined &&
      squashState.landingTransitionTimer < squashState.landingTransitionDuration
    ) {
      squashState.landingTransitionTimer += deltaTime;
      const transitionProgress = Math.min(
        1,
        squashState.landingTransitionTimer /
          squashState.landingTransitionDuration
      );
      const eased = 1 - Math.pow(1 - transitionProgress, 2);

      let angleDiff = facingState.currentFacing - squashState.landingFacing;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      if (transitionProgress >= 1) {
        squashState.landingFacing = undefined;
      }

      return squashState.landingFacing + angleDiff * eased;
    }

    return facingState.currentFacing;
  }

  /**
   * Compute scale from squash amount
   * @param {number} squashAmount
   * @param {number} baseScale
   * @returns {{ scaleX: number, scaleY: number, scaleZ: number }}
   */
  computeScale(squashAmount, baseScale) {
    if (Math.abs(squashAmount) < 0.005) {
      return { scaleX: baseScale, scaleY: baseScale, scaleZ: baseScale };
    }

    let scaleY, scaleXZ;
    if (squashAmount < 0) {
      scaleY = 1 + squashAmount * this.squashConfig.maxSquash;
      scaleXZ = 1 / Math.sqrt(scaleY);
    } else {
      scaleY = 1 + squashAmount * this.squashConfig.maxStretch;
      scaleXZ = 1 / Math.sqrt(scaleY);
    }

    return {
      scaleX: baseScale * scaleXZ,
      scaleY: baseScale * scaleY,
      scaleZ: baseScale * scaleXZ,
    };
  }

  /**
   * Apply additional anticipation squash to existing scale
   * @param {number} anticipationSquash
   * @param {{ scaleX: number, scaleY: number, scaleZ: number }} scale
   * @returns {{ scaleX: number, scaleY: number, scaleZ: number }}
   */
  applyAnticipationSquash(anticipationSquash, scale) {
    if (Math.abs(anticipationSquash) <= 0.01) {
      return scale;
    }

    let antScaleY, antScaleXZ;
    if (anticipationSquash < 0) {
      antScaleY = 1 + anticipationSquash * this.squashConfig.maxSquash;
      antScaleXZ = 1 / Math.sqrt(antScaleY);
    } else {
      antScaleY = 1 + anticipationSquash * this.squashConfig.maxStretch;
      antScaleXZ = 1 / Math.sqrt(antScaleY);
    }

    return {
      scaleX: scale.scaleX * antScaleXZ,
      scaleY: scale.scaleY * antScaleY,
      scaleZ: scale.scaleZ * antScaleXZ,
    };
  }

  clear() {
    this.robotTiltState.clear();
    this.robotFacingState.clear();
    this.robotSquashState.clear();
    this.robotAnticipationState.clear();
    this.robotFollowThroughState.clear();
    this.robotIdleState.clear();
    this.robotHoverState.clear();
  }
}
