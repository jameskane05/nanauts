/**
 * RobotArmManager.js - Procedural arm animations
 * =============================================================================
 *
 * ROLE: Controls Shoulder_L and Shoulder_R mesh rotations based on robot state.
 * Creates expressive arm movements that react to movement, emotions, and actions.
 *
 * ARM STATES (ArmState enum):
 *   IDLE: Subtle ready-stance sway
 *   NAVIGATING: Arms swept back like flying, velocity-based angle
 *   JUMPING: Arms extended to sides with steadying circles
 *   EXCITED: Arms raised high with happy wobble
 *   ANGRY: Arms tensed at sides with shaking
 *   CURIOUS: One arm up (scratching head gesture)
 *   SAD: Arms drooping with slow motion
 *   CONTENT: Relaxed neutral pose
 *   CHATTING: Alternating pointing gestures at partner/environment
 *
 * KEY METHODS:
 *   - setState(ArmState): Set current arm animation state
 *   - setJumpPhase(0-4): External jump phase for navmesh/interaction jumps
 *   - setPointingAngle(radians): Direction to point during CHATTING
 *   - update(deltaTime, speed, turnRate, velX, velZ): Main update
 *
 * COORDINATE SYSTEM: Arm forward is -Y. X=pitch, Y=roll, Z=yaw.
 * =============================================================================
 */
import { Quaternion, Euler, MathUtils, Vector3 } from "three";
import { Logger } from "../utils/Logger.js";

// Arm animation states
export const ArmState = {
  IDLE: "idle",
  NAVIGATING: "navigating",
  JUMPING: "jumping",
  EXCITED: "excited",
  ANGRY: "angry",
  CURIOUS: "curious",
  SAD: "sad",
  CONTENT: "content",
  CHATTING: "chatting",
  PANICKING: "panicking",
};

export class RobotArmManager {
  constructor(robotGroup) {
    this.robotGroup = robotGroup;
    this.logger = new Logger("RobotArmManager", false);
    this.shoulderL = null;
    this.shoulderR = null;

    // Base rotations (rest pose from model)
    this.baseQuatL = new Quaternion();
    this.baseQuatR = new Quaternion();

    // Current and target rotations
    this.currentQuatL = new Quaternion();
    this.currentQuatR = new Quaternion();
    this.targetQuatL = new Quaternion();
    this.targetQuatR = new Quaternion();

    // Previous frame rotations (for velocity calculation)
    this.prevQuatL = new Quaternion();
    this.prevQuatR = new Quaternion();

    // Angular velocity for squash/stretch
    this.angularSpeedL = 0;
    this.angularSpeedR = 0;

    // Squash and stretch parameters
    this.squashStretchAmount = 0.15;
    this.squashStretchDecay = 8.0;
    this.currentStretchL = 0;
    this.currentStretchR = 0;
    this.stretchVelocityL = 0;
    this.stretchVelocityR = 0;

    // Animation state
    this.currentState = ArmState.IDLE;
    this.stateTimer = 0;
    this.transitionSpeed = 5.0; // Base slerp speed (now used with spring)

    // Movement data
    this.velocityX = 0;
    this.velocityZ = 0;
    this.lastSpeed = 0;

    // Jump animation phase
    this.jumpPhase = 0; // 0=anticipation, 1=up, 2=peak, 3=down

    // Pointing state for chatting
    this.pointingState = {
      targetType: "partner", // "partner" | "environment"
      holdTimer: 0,
      holdDuration: 0,
      currentTargetAngle: 0, // Angle in XZ plane relative to robot forward
      nextTargetAngle: 0,
      transitioning: false,
    };

    // Temp objects
    this._tempEuler = new Euler();
    this._tempQuat = new Quaternion();
    this._tempVec = new Vector3();

    // Animation configs per state
    this.stateConfigs = {
      [ArmState.IDLE]: {
        // Ready stance with eager subtle motion
        swayAmplitude: 0.06, // radians
        swayFrequency: 0.7, // Hz - slightly faster, more alert
        baseAngleL: { x: 0.15, y: 0, z: 0.2 }, // Slightly back and out - ready to go!
        baseAngleR: { x: 0.15, y: 0, z: -0.2 },
      },
      [ArmState.NAVIGATING]: {
        // Arms angle based on velocity - subtle swept back
        maxSweep: 0.25, // Max swept-back angle (reduced)
        spreadAngle: 0.15, // Arms spread outward (reduced)
        wobbleAmplitude: 0.03, // Subtle flutter
        wobbleFrequency: 4, // Gentle wobble
      },
      [ArmState.JUMPING]: {
        // Arms extend out to sides for balance, doing tiny steadying circles
        anticipationAngle: { x: 0.3, y: 0, z: 0.2 }, // Arms slightly back, ready
        // Peak: arms extended horizontally (Y ~= ±90° in Blender = ±1.57 rad)
        peakSpreadY: 1.4, // How far out to sides (radians, ~80°)
        peakPitchX: 0.1, // Slight forward tilt when extended
        // Steadying circles at arm tips
        circleRadius: 0.15, // Size of steadying circles (radians)
        circleSpeed: 8, // Rotations per second
        // Landing settle
        landingAngle: { x: 0.2, y: 0, z: 0.15 },
      },
      [ArmState.EXCITED]: {
        // Both arms raised high
        angleL: { x: -1.4, y: 0, z: 0.6 },
        angleR: { x: -1.4, y: 0, z: -0.6 },
        wobbleAmplitude: 0.15,
        wobbleFrequency: 8,
      },
      [ArmState.ANGRY]: {
        // Arms tensed at sides, shaking
        angleL: { x: 0.3, y: -0.2, z: 0.4 },
        angleR: { x: 0.3, y: 0.2, z: -0.4 },
        shakeAmplitude: 0.1,
        shakeFrequency: 15,
      },
      [ArmState.CURIOUS]: {
        // One arm up (scratching head gesture)
        angleL: { x: -0.8, y: 0.3, z: 0.3 },
        angleR: { x: 0.2, y: 0, z: -0.1 },
        tiltAmplitude: 0.05,
        tiltFrequency: 1,
      },
      [ArmState.SAD]: {
        // Arms hanging low
        angleL: { x: 0.4, y: 0, z: 0.05 },
        angleR: { x: 0.4, y: 0, z: -0.05 },
        droopAmplitude: 0.03,
        droopFrequency: 0.3,
      },
      [ArmState.CONTENT]: {
        // Relaxed neutral
        angleL: { x: 0.1, y: 0, z: 0.15 },
        angleR: { x: 0.1, y: 0, z: -0.15 },
      },
      [ArmState.CHATTING]: {
        // Pointing gestures - point at partner and around environment
        pointArmPitch: -0.7, // Arm raised to point (negative = up/forward)
        pointArmSpread: 0.4, // How far out the pointing arm goes
        restArmAngle: { x: 0.2, z: 0.2 }, // Non-pointing arm relaxed
        holdDurationMin: 0.8, // Min time to hold a point
        holdDurationMax: 1.5, // Max time to hold a point
        transitionSpeed: 4.0, // How fast to move between points
        partnerPointChance: 0.6, // Chance to point at partner vs environment
      },
      [ArmState.PANICKING]: {
        // Frantic waving - arms raised and waving rapidly
        baseAngle: { x: -1.2, y: 0, z: 0.3 }, // Arms raised up
        waveAmplitude: 0.8, // How much to wave
        waveFrequency: 6.0, // Rapid waving speed
        phaseOffset: Math.PI, // Arms wave opposite to each other
      },
    };

    this._findShoulders();
  }

  _findShoulders() {
    if (!this.robotGroup) return;

    this.robotGroup.traverse((child) => {
      const name = child.name?.toLowerCase() || "";
      if (
        !this.shoulderL &&
        name.includes("shoulder") &&
        (name.includes("_l") || name.includes("left") || name.includes(".l"))
      ) {
        this.shoulderL = child;
        this.baseQuatL.copy(child.quaternion);
        this.currentQuatL.copy(child.quaternion);
        this.targetQuatL.copy(child.quaternion);
      } else if (
        !this.shoulderR &&
        name.includes("shoulder") &&
        (name.includes("_r") || name.includes("right") || name.includes(".r"))
      ) {
        this.shoulderR = child;
        this.baseQuatR.copy(child.quaternion);
        this.currentQuatR.copy(child.quaternion);
        this.targetQuatR.copy(child.quaternion);
      }
    });

    if (this.shoulderL && this.shoulderR) {
      this.logger.log(
        `Found shoulders - L: ${this.shoulderL.name}, R: ${this.shoulderR.name}`
      );
    } else {
      this.logger.warn(
        `Could not find both shoulders - L: ${
          this.shoulderL?.name || "NOT FOUND"
        }, R: ${this.shoulderR?.name || "NOT FOUND"}`
      );
    }
  }

  setState(newState) {
    if (newState === this.currentState) return;
    this.currentState = newState;
    this.stateTimer = 0;

    // Reset jump phase when entering jump state
    if (newState === ArmState.JUMPING) {
      this.jumpPhase = 0;
    }
  }

  /**
   * Set jump animation phase (called by external animation system)
   * @param {number} phase - 0=anticipation, 1=rising, 2=peak, 3=falling, 4=landing
   */
  setJumpPhase(phase) {
    this.jumpPhase = phase;
  }

  /**
   * Set the angle to point at during chatting (relative to robot forward)
   * @param {number} angle - Angle in radians (0 = forward, positive = right)
   */
  setPointingAngle(angle) {
    this.pointingState.nextTargetAngle = angle;
    this.pointingState.transitioning = true;
  }

  /**
   * Update arm animations
   * @param {number} deltaTime - Time since last frame in seconds
   * @param {number} speed - Current movement speed
   * @param {number} turnRate - Current turn rate
   * @param {number} velX - X velocity component (optional)
   * @param {number} velZ - Z velocity component (optional)
   */
  update(deltaTime, speed = 0, turnRate = 0, velX = 0, velZ = 0) {
    if (!this.shoulderL || !this.shoulderR) return;

    this.stateTimer += deltaTime;
    this.lastSpeed = speed;
    this.velocityX = velX;
    this.velocityZ = velZ;

    // Store previous rotations for velocity calculation
    this.prevQuatL.copy(this.currentQuatL);
    this.prevQuatR.copy(this.currentQuatR);

    // Calculate target rotations based on state
    this._updateTargetRotations(deltaTime, speed, turnRate);

    // Slerp interpolation to target
    const lerpFactor = Math.min(1, this.transitionSpeed * deltaTime);
    this.currentQuatL.slerp(this.targetQuatL, lerpFactor);
    this.currentQuatR.slerp(this.targetQuatR, lerpFactor);

    // Calculate angular speeds (for squash/stretch)
    this.angularSpeedL =
      this.currentQuatL.angleTo(this.prevQuatL) / Math.max(deltaTime, 0.001);
    this.angularSpeedR =
      this.currentQuatR.angleTo(this.prevQuatR) / Math.max(deltaTime, 0.001);

    // Update squash/stretch based on angular velocity
    this._updateSquashStretch(deltaTime);

    // Apply rotations
    this.shoulderL.quaternion.copy(this.currentQuatL);
    this.shoulderR.quaternion.copy(this.currentQuatR);

    // Apply scale for squash/stretch effect
    this._applyArmScale();
  }

  _updateTargetRotations(deltaTime, speed, turnRate) {
    const config = this.stateConfigs[this.currentState];
    const time = this.stateTimer;

    switch (this.currentState) {
      case ArmState.IDLE:
        this._updateIdleArms(config, time);
        break;

      case ArmState.NAVIGATING:
        this._updateNavigatingArms(config, speed, turnRate);
        break;

      case ArmState.JUMPING:
        this._updateJumpingArms(config, time);
        break;

      case ArmState.EXCITED:
        this._updateExcitedArms(config, time);
        break;

      case ArmState.ANGRY:
        this._updateAngryArms(config, time);
        break;

      case ArmState.CURIOUS:
        this._updateCuriousArms(config, time);
        break;

      case ArmState.SAD:
        this._updateSadArms(config, time);
        break;

      case ArmState.CONTENT:
        this._updateContentArms(config);
        break;

      case ArmState.CHATTING:
        this._updateChattingArms(config, time);
        break;

      case ArmState.PANICKING:
        this._updatePanickingArms(config, time);
        break;
    }
  }

  _updateIdleArms(config, time) {
    const sway =
      Math.sin(time * config.swayFrequency * Math.PI * 2) *
      config.swayAmplitude;

    // Left arm
    this._tempEuler.set(
      config.baseAngleL.x + sway * 0.5,
      config.baseAngleL.y,
      config.baseAngleL.z + sway
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm (opposite phase)
    this._tempEuler.set(
      config.baseAngleR.x - sway * 0.5,
      config.baseAngleR.y,
      config.baseAngleR.z - sway
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateNavigatingArms(config, speed, turnRate) {
    // Arms angle based on velocity - subtle swept back, slow ramp
    // Slower ramp: speed * 1.5 means need ~0.67 speed to reach max
    const speedFactor = MathUtils.clamp(speed * 1.5, 0, 1);
    const time = this.stateTimer;

    // Subtle sweep proportional to speed
    const sweepBack = config.maxSweep * speedFactor;
    const spreadOut = config.spreadAngle * speedFactor;

    // Gentle wobble - only noticeable when moving faster
    const wobble =
      Math.sin(time * config.wobbleFrequency * Math.PI * 2) *
      config.wobbleAmplitude *
      speedFactor;

    // Subtle banking into turns
    const turnBias = MathUtils.clamp(turnRate * 0.1, -0.1, 0.1) * speedFactor;

    // Left arm
    this._tempEuler.set(
      sweepBack + wobble,
      turnBias * 0.1,
      spreadOut + turnBias
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm - mirrored
    this._tempEuler.set(
      sweepBack - wobble * 0.7,
      -turnBias * 0.1,
      -spreadOut + turnBias
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateJumpingArms(config, time) {
    // Arms extend out to sides, doing tiny steadying circles while airborne
    let spreadAmount = 0; // 0 = at rest, 1 = fully extended
    let circleAmount = 0; // 0 = no circles, 1 = full circles
    let settleAmount = 0; // For landing damping

    switch (this.jumpPhase) {
      case 0: // Anticipation - arms slightly back, ready to spring
        spreadAmount = 0.1;
        circleAmount = 0;
        break;
      case 1: // Rising - arms spreading out quickly
        spreadAmount = MathUtils.lerp(0.1, 0.7, Math.min(time * 4, 1));
        circleAmount = Math.min(time * 3, 0.6);
        break;
      case 2: // Peak - arms fully extended, active balancing circles
        spreadAmount = 1.0;
        circleAmount = 1.0;
        break;
      case 3: // Falling - still extended, circles continue
        spreadAmount = 0.9;
        circleAmount = 0.8;
        break;
      case 4: // Landing - arms coming back in, circles settling
        spreadAmount = MathUtils.lerp(0.5, 0.1, Math.min(time * 3, 1));
        circleAmount = MathUtils.lerp(0.5, 0, Math.min(time * 3, 1));
        settleAmount = Math.min(time * 2, 1);
        break;
      default:
        spreadAmount = 0;
        circleAmount = 0;
    }

    // Calculate steadying circle motion (arm tips trace small circles)
    const circlePhase = time * config.circleSpeed * Math.PI * 2;
    const circleX = Math.sin(circlePhase) * config.circleRadius * circleAmount;
    const circleZ = Math.cos(circlePhase) * config.circleRadius * circleAmount;

    // Base angles when extended
    const pitchX =
      config.anticipationAngle.x * (1 - spreadAmount) +
      config.peakPitchX * spreadAmount;
    const spreadY = config.peakSpreadY * spreadAmount;
    const spreadZ = config.anticipationAngle.z * (1 - spreadAmount);

    // Left arm - extends to left side (positive Y rotation)
    this._tempEuler.set(
      pitchX + circleX,
      spreadY, // Y rotation extends arm out to side
      spreadZ + circleZ
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm - extends to right side (negative Y rotation), opposite circle phase
    const circleXR =
      Math.sin(circlePhase + Math.PI * 0.3) *
      config.circleRadius *
      circleAmount;
    const circleZR =
      Math.cos(circlePhase + Math.PI * 0.3) *
      config.circleRadius *
      circleAmount;
    this._tempEuler.set(
      pitchX + circleXR,
      -spreadY, // Negative Y extends to right
      -spreadZ + circleZR
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateExcitedArms(config, time) {
    const wobble =
      Math.sin(time * config.wobbleFrequency * Math.PI * 2) *
      config.wobbleAmplitude;

    // Left arm - raised with wobble
    this._tempEuler.set(
      config.angleL.x + wobble,
      config.angleL.y,
      config.angleL.z + wobble * 0.5
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm - raised with opposite wobble
    this._tempEuler.set(
      config.angleR.x - wobble,
      config.angleR.y,
      config.angleR.z - wobble * 0.5
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateAngryArms(config, time) {
    const shake =
      Math.sin(time * config.shakeFrequency * Math.PI * 2) *
      config.shakeAmplitude;
    // Decay shake over time
    const decay = Math.exp(-time * 0.5);
    const actualShake = shake * decay;

    // Left arm - tensed with shake
    this._tempEuler.set(
      config.angleL.x + actualShake,
      config.angleL.y + actualShake * 0.5,
      config.angleL.z
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm
    this._tempEuler.set(
      config.angleR.x - actualShake,
      config.angleR.y - actualShake * 0.5,
      config.angleR.z
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateCuriousArms(config, time) {
    const tilt =
      Math.sin(time * config.tiltFrequency * Math.PI * 2) *
      config.tiltAmplitude;

    // Left arm - up in thinking pose
    this._tempEuler.set(
      config.angleL.x + tilt,
      config.angleL.y,
      config.angleL.z
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm - relaxed
    this._tempEuler.set(config.angleR.x, config.angleR.y, config.angleR.z);
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateSadArms(config, time) {
    const droop =
      Math.sin(time * config.droopFrequency * Math.PI * 2) *
      config.droopAmplitude;

    // Both arms drooping
    this._tempEuler.set(
      config.angleL.x + droop,
      config.angleL.y,
      config.angleL.z
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    this._tempEuler.set(
      config.angleR.x + droop,
      config.angleR.y,
      config.angleR.z
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateContentArms(config) {
    // Simple relaxed pose
    this._tempEuler.set(config.angleL.x, config.angleL.y, config.angleL.z);
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    this._tempEuler.set(config.angleR.x, config.angleR.y, config.angleR.z);
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateChattingArms(config, time) {
    const ps = this.pointingState;

    // Update pointing state machine
    ps.holdTimer += 1 / 60; // Approximate deltaTime

    // Time to pick a new target?
    if (ps.holdTimer >= ps.holdDuration) {
      ps.holdTimer = 0;
      ps.holdDuration =
        config.holdDurationMin +
        Math.random() * (config.holdDurationMax - config.holdDurationMin);

      // Pick next target type
      if (Math.random() < config.partnerPointChance) {
        ps.targetType = "partner";
        ps.nextTargetAngle = 0; // Partner is forward (will be set externally)
      } else {
        ps.targetType = "environment";
        // Random angle around robot, biased to sides and front
        ps.nextTargetAngle = (Math.random() - 0.5) * Math.PI * 1.2; // ±108°
      }
      ps.transitioning = true;
    }

    // Smoothly transition current angle to next
    if (ps.transitioning) {
      const angleDiff = ps.nextTargetAngle - ps.currentTargetAngle;
      const step = config.transitionSpeed / 60; // Approximate deltaTime
      if (Math.abs(angleDiff) < step) {
        ps.currentTargetAngle = ps.nextTargetAngle;
        ps.transitioning = false;
      } else {
        ps.currentTargetAngle += Math.sign(angleDiff) * step;
      }
    }

    // Decide which arm points based on target angle
    // Right arm points to right side (positive angle), left arm to left side
    const pointAngle = ps.currentTargetAngle;
    const useRightArm = pointAngle > -0.3; // Slight bias to right arm for forward targets

    // Pointing arm: raised and rotated toward target
    // Non-pointing arm: relaxed gesture

    if (useRightArm) {
      // Right arm points
      // Y rotation controls left/right aim, X controls up/down (pitch)
      const aimYaw = MathUtils.clamp(pointAngle, -0.8, 1.2); // Limit range
      this._tempEuler.set(
        config.pointArmPitch, // Raised forward
        aimYaw * 0.6, // Rotate toward target (Y is roll for arm, affects aim)
        -config.pointArmSpread - Math.abs(aimYaw) * 0.2 // Spread out more when aiming to side
      );
      this._tempQuat.setFromEuler(this._tempEuler);
      this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);

      // Left arm relaxed with subtle motion
      const subtle = Math.sin(time * 1.5) * 0.05;
      this._tempEuler.set(
        config.restArmAngle.x + subtle,
        0,
        config.restArmAngle.z + subtle * 0.5
      );
      this._tempQuat.setFromEuler(this._tempEuler);
      this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);
    } else {
      // Left arm points
      const aimYaw = MathUtils.clamp(pointAngle, -1.2, 0.8);
      this._tempEuler.set(
        config.pointArmPitch,
        aimYaw * 0.6,
        config.pointArmSpread + Math.abs(aimYaw) * 0.2
      );
      this._tempQuat.setFromEuler(this._tempEuler);
      this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

      // Right arm relaxed
      const subtle = Math.sin(time * 1.5) * 0.05;
      this._tempEuler.set(
        config.restArmAngle.x + subtle,
        0,
        -config.restArmAngle.z - subtle * 0.5
      );
      this._tempQuat.setFromEuler(this._tempEuler);
      this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
    }
  }

  _updatePanickingArms(config, time) {
    // Frantic waving - both arms raised and waving rapidly
    const wave =
      Math.sin(time * config.waveFrequency * Math.PI * 2) *
      config.waveAmplitude;

    // Left arm - raised and waving
    this._tempEuler.set(
      config.baseAngle.x + wave,
      config.baseAngle.y + wave * 0.3,
      config.baseAngle.z + wave * 0.5
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatL.multiplyQuaternions(this.baseQuatL, this._tempQuat);

    // Right arm - raised and waving (opposite phase)
    const waveR =
      Math.sin(time * config.waveFrequency * Math.PI * 2 + config.phaseOffset) *
      config.waveAmplitude;
    this._tempEuler.set(
      config.baseAngle.x + waveR,
      -config.baseAngle.y - waveR * 0.3,
      -config.baseAngle.z - waveR * 0.5
    );
    this._tempQuat.setFromEuler(this._tempEuler);
    this.targetQuatR.multiplyQuaternions(this.baseQuatR, this._tempQuat);
  }

  _updateSquashStretch(deltaTime) {
    const targetStretchL = MathUtils.clamp(this.angularSpeedL * 0.15, -1, 1);
    const targetStretchR = MathUtils.clamp(this.angularSpeedR * 0.15, -1, 1);

    const stretchSpring = 15.0;
    const stretchDamp = 0.6;

    // Left arm stretch
    const stretchDiffL = targetStretchL - this.currentStretchL;
    this.stretchVelocityL += stretchDiffL * stretchSpring * deltaTime;
    this.stretchVelocityL *= Math.pow(stretchDamp, deltaTime * 60);
    this.currentStretchL += this.stretchVelocityL * deltaTime;
    this.currentStretchL = MathUtils.clamp(this.currentStretchL, -1, 1);

    // Right arm stretch
    const stretchDiffR = targetStretchR - this.currentStretchR;
    this.stretchVelocityR += stretchDiffR * stretchSpring * deltaTime;
    this.stretchVelocityR *= Math.pow(stretchDamp, deltaTime * 60);
    this.currentStretchR += this.stretchVelocityR * deltaTime;
    this.currentStretchR = MathUtils.clamp(this.currentStretchR, -1, 1);

    // Decay stretch when not moving
    const decayRate = Math.exp(-this.squashStretchDecay * deltaTime);
    if (this.angularSpeedL < 0.5) {
      this.currentStretchL *= decayRate;
      this.stretchVelocityL *= decayRate;
    }
    if (this.angularSpeedR < 0.5) {
      this.currentStretchR *= decayRate;
      this.stretchVelocityR *= decayRate;
    }
  }

  _applyArmScale() {
    if (!this.shoulderL || !this.shoulderR) return;

    const stretchL = this.currentStretchL * this.squashStretchAmount;
    const stretchR = this.currentStretchR * this.squashStretchAmount;

    // Arm extends along -Y axis, so Y gets stretch, X and Z get inverse
    const scaleYL = 1 + stretchL;
    const scaleXZL = 1 / Math.sqrt(Math.max(0.5, scaleYL));

    const scaleYR = 1 + stretchR;
    const scaleXZR = 1 / Math.sqrt(Math.max(0.5, scaleYR));

    this.shoulderL.scale.set(scaleXZL, scaleYL, scaleXZL);
    this.shoulderR.scale.set(scaleXZR, scaleYR, scaleXZR);
  }

  /**
   * Map a robot emotion to an arm state
   */
  static emotionToArmState(emotion) {
    const mapping = {
      content: ArmState.CONTENT,
      excited: ArmState.EXCITED,
      sad: ArmState.SAD,
      angry: ArmState.ANGRY,
      curious: ArmState.CURIOUS,
      acknowledge: ArmState.CONTENT,
      awe: ArmState.EXCITED,
      fear: ArmState.PANICKING,
      thinking: ArmState.CURIOUS,
      joy: ArmState.EXCITED,
    };
    return mapping[emotion?.toLowerCase()] || ArmState.CONTENT;
  }

  /**
   * Determine arm state and jump phase from context
   * @param {Object} interactionState - From interactionManager.getState()
   * @param {Object} squashState - From movementManager.getSquashState()
   * @param {number} smoothedSpeed - Current movement speed
   * @returns {ArmState} The determined arm state
   */
  determineStateFromContext(interactionState, squashState, smoothedSpeed) {
    const anim = interactionState?.currentAnimation;

    if (anim === "chatting") {
      return ArmState.CHATTING;
    }

    if (anim === "angry") {
      return ArmState.ANGRY;
    }

    if (anim === "happy") {
      const jumpProgress = interactionState.animationTimer / 0.7;
      if (jumpProgress < 0.15) {
        this.setJumpPhase(0);
      } else if (jumpProgress < 0.4) {
        this.setJumpPhase(1);
      } else if (jumpProgress < 0.6) {
        this.setJumpPhase(2);
      } else if (jumpProgress < 0.85) {
        this.setJumpPhase(3);
      } else {
        this.setJumpPhase(4);
      }
      return ArmState.JUMPING;
    }

    if (anim === "happyLoop") {
      const phase = interactionState.animationPhase;
      if (phase === 0) {
        this.setJumpPhase(0);
      } else if (phase === 1) {
        this.setJumpPhase(1);
      } else if (phase === 2 || phase === 3) {
        this.setJumpPhase(2);
      } else {
        this.setJumpPhase(4);
      }
      return ArmState.JUMPING;
    }

    if (anim === "happyBarrel") {
      const phase = interactionState.animationPhase;
      if (phase === 0) {
        this.setJumpPhase(0);
      } else if (phase === 1) {
        this.setJumpPhase(1);
      } else if (phase === 2) {
        this.setJumpPhase(2);
      } else if (phase === 3) {
        this.setJumpPhase(2);
      } else if (phase === 4) {
        this.setJumpPhase(3);
      } else {
        this.setJumpPhase(4);
      }
      return ArmState.JUMPING;
    }

    if (anim === "happyBounce") {
      const phase = interactionState.animationPhase;
      if (phase === 0) {
        this.setJumpPhase(0); // Anticipation
      } else if (phase === 1) {
        this.setJumpPhase(1); // Hop
      } else {
        this.setJumpPhase(4); // Landing/bouncing
      }
      return ArmState.JUMPING;
    }

    if (squashState.isJumping) {
      const progress = squashState.jumpProgress || 0;
      const anticipationEnd = squashState.jumpAnticipationEnd || 0.2;

      if (progress < anticipationEnd) {
        this.setJumpPhase(0);
      } else {
        const airProgress =
          (progress - anticipationEnd) / (1 - anticipationEnd);
        if (airProgress < 0.25) {
          this.setJumpPhase(1);
        } else if (airProgress < 0.55) {
          this.setJumpPhase(2);
        } else if (airProgress < 0.85) {
          this.setJumpPhase(3);
        } else {
          this.setJumpPhase(4);
        }
      }
      return ArmState.JUMPING;
    }

    if (squashState.landingTimer > 0 && squashState.landingTimer < 0.3) {
      this.setJumpPhase(4);
      return ArmState.JUMPING;
    }

    if (smoothedSpeed > 0.05) {
      return ArmState.NAVIGATING;
    }

    return ArmState.IDLE;
  }

  /**
   * Calculate pointing angle to partner for chatting state
   * @param {Object3D} robotObject
   * @param {Object3D} partnerObject
   * @returns {number|null} Relative angle or null if invalid
   */
  calculatePointingAngle(robotObject, partnerObject) {
    if (!robotObject || !partnerObject) return null;

    const partnerPos = partnerObject.position;
    const robotPos = robotObject.position;
    const dx = partnerPos.x - robotPos.x;
    const dz = partnerPos.z - robotPos.z;
    const worldAngleToPartner = Math.atan2(dx, dz);
    const robotFacing = robotObject.rotation.y;
    let relativeAngle = worldAngleToPartner - robotFacing;

    // Normalize to [-PI, PI]
    while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
    while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

    return relativeAngle;
  }
}
