/**
 * RobotPlayerInteractionManager.js - Player-to-robot interactions
 * =============================================================================
 *
 * ROLE: Manages all player-to-robot interactions including:
 *   - Name-based summoning (player says robot name)
 *   - Head pat detection and response
 *   - Breadcrumb trail following
 *   - Flight mode for off-navmesh following
 *   - Panic/overheat minigame
 *
 * STATES HANDLED:
 *   - ATTENDING_PLAYER: Robot summoned, approaching player
 *   - FOLLOWING_PLAYER: Following breadcrumb trail on navmesh
 *   - FLYING_FOLLOW: Following player off-navmesh via flight
 *   - PANICKING: Minigame panic state until patted
 *
 * PAT DETECTION:
 *   Uses distance check from XrInputSystem fingertip colliders to robot head.
 *   Triggers when hand within ~8cm and moving downward.
 *
 * BREADCRUMB TRAIL:
 *   Samples player head position every ~0.5s (max 20 points).
 *   Robot navigates to oldest breadcrumb, removes when reached.
 *
 * =============================================================================
 */
import { Vector3, Color, Quaternion, Euler } from "three";
import { crowd } from "navcat/blocks";
import {
  findNearestPoly,
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
} from "navcat";
import { Logger } from "../utils/Logger.js";
import { ROBOT_STATE } from "./RobotBehaviorState.js";
import { RobotEmotion } from "./RobotFaceManager.js";
import { uiAudio } from "../audio/UIAudio.js";
import { DataLinkVFX } from "../vfx/DataLinkVFX.js";
import { gameState } from "../gameState.js";

export class RobotPlayerInteractionManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotPlayerInteraction", true);

    // Debug logging interval tracking
    this._lastDistanceLogTime = 0;

    // Per-robot state
    this.robotState = new Map();

    // Breadcrumb trail for following (shared across all following robots)
    this.breadcrumbs = [];
    this.maxBreadcrumbs = 20;
    this.breadcrumbInterval = 0.5; // seconds
    this._lastBreadcrumbTime = 0;

    // Pat detection config
    this.patConfig = {
      detectionRadius: 0.08, // 8cm - hand must be within this distance
      minDownwardVelocity: -0.05, // m/s - hand moving down
      cooldown: 1.0, // seconds between pats
    };

    // Minigame state
    this.minigameActive = false;
    this.minigameCalmCount = 0;
    this.minigameCalmGoal = 5;
    this.minigamePanicCount = 0; // Track how many panics have started
    this.onMinigameComplete = null;
    this.onScoreUpdate = null;
    this.onPanicStart = null;

    // Global panic cooldown - prevents new panic for 4-10 seconds after one ends
    this.panicCooldownUntil = 0;

    // Temp vectors
    this._tempVec3 = new Vector3();
    this._tempVec3B = new Vector3();
    this._prevHandPositions = { left: new Vector3(), right: new Vector3() };

    // Antenna tip references for pat detection
    this._antennaTips = new Map(); // entityIndex -> Object3D

    // Data link VFX for each hand (shows connection lines when approaching robot)
    this._dataLinkVFX = {
      left: null,
      right: null,
    };
    this._dataLinkTargets = {
      left: null, // entityIndex of robot being targeted
      right: null,
    };
  }

  /**
   * Get or find the antenna tip bone for a robot
   */
  _getAntennaTip(entityIndex, robotEntity) {
    if (this._antennaTips.has(entityIndex)) {
      return this._antennaTips.get(entityIndex);
    }

    const robotObject = robotEntity?.object3D;
    if (!robotObject) return null;

    let antennaTip = null;
    robotObject.traverse((child) => {
      if (child.name && child.name.includes("AntennaTip")) {
        antennaTip = child;
      }
    });

    if (antennaTip) {
      this._antennaTips.set(entityIndex, antennaTip);
      this.logger.log(
        `Found antenna tip for robot ${entityIndex}: ${antennaTip.name}`
      );
    }

    return antennaTip;
  }

  getState(entityIndex) {
    let state = this.robotState.get(entityIndex);
    if (!state) {
      state = {
        isSummoned: false,
        isFollowing: false,
        isFlying: false,
        isPanicking: false,
        needsReassurance: false, // True when robot is waiting for reassurance from player
        lastWorriedFaceTime: 0, // For cycling worried faces during reassurance
        lastPatTime: 0,
        currentBreadcrumbIndex: 0,
        summonedBy: null, // 'name' or 'pat'
        patSquashAmount: 0, // Current squash from pat pressure
        patSquashVelocity: 0, // Velocity for spring animation
        questionPlayed: false, // Has robot asked their question
        flightTargetY: 0, // Target Y for flight mode
        panicRotation: 0, // Current rotation during panic (radians)
        panicRotationSpeed: 0, // Rotation speed during panic (rad/sec)
        panicCooldownUntil: 0, // Timestamp when robot can panic again (ms)
        panicRotationTransition: null, // { startAngle, targetAngle, startTime, duration }
      };
      this.robotState.set(entityIndex, state);
    }
    return state;
  }

  /**
   * Summon a robot by name - called when player says robot's name
   */
  summonRobot(entityIndex) {
    const state = this.getState(entityIndex);
    const robotEntity = this.robotSystem.robotEntities.get(entityIndex);

    if (!robotEntity) {
      this.logger.warn(`Cannot summon robot ${entityIndex} - not found`);
      return false;
    }

    // Block summoning during panic minigame
    if (this.minigameActive || state.isPanicking) {
      this.logger.log(
        `Cannot summon robot ${entityIndex} - panic minigame active`
      );
      return false;
    }

    // Stop any current behavior
    this._cancelCurrentBehavior(entityIndex);

    state.isSummoned = true;
    state.summonedBy = "name";
    state.questionPlayed = false;

    // Transition to ATTENDING_PLAYER state
    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.ATTENDING_PLAYER);
    }

    // Trigger character-specific reaction animation
    const character =
      this.robotSystem.characterManager?.getCharacter(entityIndex);
    if (character?.nameReactionAnimation) {
      this.robotSystem.interactionManager?.triggerSoloAnimation(
        entityIndex,
        character.nameReactionAnimation
      );
    }

    // Navigate toward player (after animation starts)
    this._navigateToPlayer(entityIndex);

    this.logger.log(`Robot ${entityIndex} summoned by name`);
    return true;
  }

  /**
   * Set a robot into reassurance mode (worried, waiting for comforting words)
   * @param {number} entityIndex - Robot entity index
   */
  setNeedsReassurance(entityIndex) {
    const state = this.getState(entityIndex);
    state.needsReassurance = true;
    state.lastWorriedFaceTime = 0;

    // Set initial worried face
    this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.SAD);

    this.logger.log(`Robot ${entityIndex} now needs reassurance`);
  }

  /**
   * Clear reassurance mode for a robot (they've been comforted)
   * @param {number} entityIndex - Robot entity index
   */
  clearReassurance(entityIndex) {
    const state = this.getState(entityIndex);
    state.needsReassurance = false;
    state.isSummoned = false;

    // Return to wandering
    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);
    }

    this.logger.log(
      `Robot ${entityIndex} reassurance cleared, resuming normal behavior`
    );
  }

  /**
   * Start panic minigame - robots randomly enter panic state over time
   */
  startPanicMinigame() {
    if (this.minigameActive) return;

    this.minigameActive = true;
    this.minigameCalmCount = 0;
    this.minigamePanicCount = 0; // Reset panic count when minigame starts
    this.panicCooldownUntil = 0; // Reset cooldown when minigame starts

    // Update global game state
    gameState.setState({ minigameActive: true });

    // Cancel any active robot-to-robot interactions
    this.robotSystem.interactionManager?.cancelAllInteractions();

    // Panic outbreak config
    this.panicOutbreakInterval = [3000, 8000]; // Random interval between panic triggers (ms)
    this.nextPanicTime = performance.now() + this._randomPanicDelay();

    // Initialize data link VFX for each hand
    this._initDataLinkVFX();

    this.logger.log(
      "Panic minigame started - robots will randomly start panicking"
    );

    // Notify UI
    if (this.onScoreUpdate) {
      this.onScoreUpdate(this.minigameCalmCount, this.minigameCalmGoal);
    }
  }

  /**
   * Initialize DataLinkVFX for both hands
   */
  _initDataLinkVFX() {
    const scene = this.robotSystem.world?.scene;
    if (!scene) {
      this.logger.log("[DataLink] No scene available, cannot init VFX");
      return;
    }

    this.logger.log("[DataLink] Initializing DataLinkVFX for both hands...");

    for (const side of ["left", "right"]) {
      if (this._dataLinkVFX[side]) {
        this._dataLinkVFX[side].dispose();
        scene.remove(this._dataLinkVFX[side].group);
      }

      this._dataLinkVFX[side] = new DataLinkVFX({
        maxDistance: 0.78, // Start showing
        midDistance: 0.325, // Both ends extending
        contactDistance: 0.27, // 30% closer for completion
        onContact: () => this._handleDataLinkContact(side),
      });
      this._dataLinkVFX[side].start();
      scene.add(this._dataLinkVFX[side].group);
      this.logger.log(
        `[DataLink] Created VFX for ${side} hand, added to scene`
      );
    }
  }

  /**
   * Handle data link contact (lines fully connected)
   */
  _handleDataLinkContact(side) {
    const targetEntity = this._dataLinkTargets[side];
    this.logger.log(
      `[DataLink] CONTACT on ${side} hand! targetEntity=${targetEntity}`
    );
    if (targetEntity !== null) {
      this._handlePat(targetEntity, true); // true = from data link contact
      // Reset the VFX contact state
      this._dataLinkVFX[side]?.resetContact();
    }
  }

  /**
   * Get random delay until next panic outbreak
   */
  _randomPanicDelay() {
    const [min, max] = this.panicOutbreakInterval;
    return min + Math.random() * (max - min);
  }

  /**
   * Trigger panic on a single robot
   */
  triggerPanicOnRobot(entityIndex) {
    const state = this.getState(entityIndex);
    if (state.isPanicking) {
      this.logger.log(
        `[Panic] Robot ${entityIndex} already panicking, skipping`
      );
      return;
    }

    // Check cooldown (recently calmed robots can't panic again yet)
    const now = performance.now();
    if (now < state.panicCooldownUntil) {
      const remaining = ((state.panicCooldownUntil - now) / 1000).toFixed(1);
      this.logger.log(
        `[Panic] Robot ${entityIndex} on cooldown, ${remaining}s remaining`
      );
      return;
    }

    // Increment panic count BEFORE setting state
    this.minigamePanicCount++;
    const panicNumber = this.minigamePanicCount;

    state.isPanicking = true;
    state.panicNumber = panicNumber; // Track which panic this is (for movement logic)
    state.lastPatTime = 0;
    state.lastPanicSoundTime = 0;
    state.panicRotation = 0;
    state.panicRotationSpeed = 1.5 + Math.random() * 1.0; // 1.5-2.5 rad/sec (slow rotation)

    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.PANICKING);
    }

    // 4th and 5th panics: robot moves while panicking (harder to catch)
    const shouldMoveWhilePanicking = panicNumber >= 4;

    if (!shouldMoveWhilePanicking) {
      this.robotSystem.navigationManager?.stopRobotMovement(entityIndex);
    } else {
      // Moving panic: set an initial navigation target
      // (RobotSystem.js now correctly handles navigation for panicNumber >= 4)
      const robotEntity = this.robotSystem.robotEntities?.get(entityIndex);
      const agentId = this.robotSystem.robotAgentIds?.get(entityIndex);
      this.logger.log(
        `[Panic] Panic #${panicNumber}: Robot ${entityIndex} (agentId=${agentId}) will MOVE while panicking`
      );
      if (robotEntity && agentId !== null && agentId !== undefined) {
        this.robotSystem.navigationManager?.selectRandomWanderTarget(
          robotEntity,
          agentId
        );
      }
    }

    // Set distressed face with red color (will also trigger PANICKING arm state via emotion mapping)
    this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.FEAR);
    this.robotSystem.setRobotFaceColor(entityIndex, "#ff3333");
    this.robotSystem.setRobotTieColor(entityIndex, "#ff3333");

    // Start panic VFX (red lasers)
    this.robotSystem.scanManager?.startPanicVFX(entityIndex);

    // Play initial distressed sound
    const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
    if (voice) {
      const sounds = ["angry", "sad"];
      const sound = sounds[Math.floor(Math.random() * sounds.length)];
      voice[sound]?.();
    }

    this.logger.log(`[Panic] Robot ${entityIndex} ENTERED panic state!`);

    // Notify UI that panic started
    if (this.onPanicStart) {
      this.onPanicStart();
    }
  }

  /**
   * Check if any robot is currently panicking
   * @returns {boolean}
   */
  isAnyRobotPanicking() {
    for (const [entityIndex] of this.robotSystem.robotEntities) {
      const state = this.getState(entityIndex);
      if (state.isPanicking) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update panic minigame - check if it's time to trigger another panic
   * @param {number} deltaTime - Time since last frame
   */
  updatePanicMinigame(deltaTime = 0.016) {
    if (!this.minigameActive) return;

    // Update data link VFX (find nearest panicking robot for each hand)
    this._updateDataLinkVFX(deltaTime);

    const now = performance.now();

    // Log robot panic states every 3 seconds
    if (!this._lastPanicStateLogTime) this._lastPanicStateLogTime = 0;
    if (now - this._lastPanicStateLogTime > 3000) {
      this._lastPanicStateLogTime = now;
      const states = [];
      for (const [entityIndex] of this.robotSystem.robotEntities) {
        const state = this.getState(entityIndex);
        const cooldownRemaining = Math.max(
          0,
          (state.panicCooldownUntil - now) / 1000
        ).toFixed(1);
        const statusChar = state.isPanicking
          ? "P"
          : state.panicCooldownUntil > now
          ? `C${cooldownRemaining}`
          : "N";
        states.push(`${entityIndex}:${statusChar}`);
      }
      this.logger.log(
        `[PanicStatus] ${states.join(", ")} (P=panicking, C=cooldown, N=normal)`
      );
    }

    if (now < this.nextPanicTime) return;

    // Check global cooldown - prevent new panic for 4-10 seconds after one ends
    if (now < this.panicCooldownUntil) {
      const remaining = ((this.panicCooldownUntil - now) / 1000).toFixed(1);
      this.logger.log(
        `[Panic] Global cooldown active, ${remaining}s remaining before next panic`
      );
      return;
    }

    // Only one robot can panic at a time - check if any robot is currently panicking
    let anyPanicking = false;
    const calmRobots = [];
    for (const [entityIndex] of this.robotSystem.robotEntities) {
      const state = this.getState(entityIndex);
      if (state.isPanicking) {
        anyPanicking = true;
        break;
      }
      // Also skip robots in happy reaction period
      if (state.happyReactionUntil && now < state.happyReactionUntil) {
        continue;
      }
      calmRobots.push(entityIndex);
    }

    // Don't trigger new panic if one is already panicking
    if (anyPanicking) return;

    // Trigger panic on a random calm robot
    if (calmRobots.length > 0) {
      const randomIndex = Math.floor(Math.random() * calmRobots.length);
      const targetRobot = calmRobots[randomIndex];
      this.triggerPanicOnRobot(targetRobot);
    }

    // Schedule next panic
    this.nextPanicTime = now + this._randomPanicDelay();
  }

  /**
   * Update DataLinkVFX - find nearest panicking robot to each hand and show connection lines
   */
  _updateDataLinkVFX(deltaTime) {
    const xrInputSystem = this.robotSystem.world?.xrInputSystem;
    if (!xrInputSystem) return;

    // Periodic distance logging (once per second)
    const now = performance.now();
    const shouldLogDistance = now - this._lastDistanceLogTime > 1000;

    // Get input positions for each hand - follow same pattern as SpatialMountManager
    const handPositions = {};
    const handQuaternions = {};
    let inputType = "none";
    const xrInput = xrInputSystem.xrInput;

    // Try fingertip colliders first (hand tracking)
    const fingertipColliders = xrInputSystem.fingertipColliders;
    if (fingertipColliders && fingertipColliders.size > 0) {
      for (const side of ["left", "right"]) {
        const colliderData = fingertipColliders.get(`${side}_index`);
        if (colliderData?.joint) {
          const pos = new Vector3();
          colliderData.joint.getWorldPosition(pos);
          if (Number.isNaN(pos.x)) continue; // Hand tracking lost
          handPositions[side] = pos;
          // Get wrist quaternion for hand orientation
          const wristData = fingertipColliders.get(`${side}_wrist`);
          if (wristData?.joint) {
            const quat = new Quaternion();
            wristData.joint.getWorldQuaternion(quat);
            handQuaternions[side] = quat;
          }
          inputType = "fingertip";
        }
      }
    }

    // Fallback to controller transforms (same pattern as SpatialMountManager._findController)
    if (xrInput?.gamepads) {
      for (const side of ["left", "right"]) {
        if (!handPositions[side]) {
          const pad = xrInput.gamepads[side];
          // Try grip first, then object3D
          const controller = pad?.grip || pad?.object3D;
          if (controller) {
            const pos = new Vector3();
            controller.getWorldPosition(pos);
            if (Number.isNaN(pos.x)) continue; // Controller tracking lost
            handPositions[side] = pos;
            const quat = new Quaternion();
            controller.getWorldQuaternion(quat);
            handQuaternions[side] = quat;
            inputType = "controller-grip";
          }
        }
      }
    }

    // Final fallback to raySpaces (for controllers without grip space)
    if (xrInput?.xrOrigin?.raySpaces) {
      const raySpaces = xrInput.xrOrigin.raySpaces;
      for (const side of ["left", "right"]) {
        if (!handPositions[side] && raySpaces[side]) {
          const pos = new Vector3();
          raySpaces[side].getWorldPosition(pos);
          if (Number.isNaN(pos.x)) continue; // Ray space tracking lost
          handPositions[side] = pos;
          const quat = new Quaternion();
          raySpaces[side].getWorldQuaternion(quat);
          handQuaternions[side] = quat;
          inputType = "controller-ray";
        }
      }
    }

    // Update debug occlusion visualization position and rotation (above left hand)
    const navSurfaces = this.robotSystem.world?.navSurfacesSystem;
    if (navSurfaces && handPositions.left) {
      navSurfaces.updateDebugOcclusionPosition(
        handPositions.left,
        handQuaternions.left
      );
    }

    // Collect panicking robots with their antenna positions
    const panickingRobots = [];
    for (const [entityIndex, robotEntity] of this.robotSystem.robotEntities) {
      const state = this.getState(entityIndex);
      if (state.isPanicking) {
        const antennaTip = this._getAntennaTip(entityIndex, robotEntity);
        if (antennaTip) {
          const antennaPos = new Vector3();
          antennaTip.getWorldPosition(antennaPos);
          panickingRobots.push({ entityIndex, antennaPos });
        }
      }
    }

    // Log distance info once per second
    if (shouldLogDistance) {
      this._lastDistanceLogTime = now;
      const hasLeft = !!handPositions.left;
      const hasRight = !!handPositions.right;
      const vfxLeft = !!this._dataLinkVFX.left;
      const vfxRight = !!this._dataLinkVFX.right;

      // Log XR input availability
      const gamepadsAvail = xrInput?.gamepads
        ? `L=${!!xrInput.gamepads.left?.grip} R=${!!xrInput.gamepads.right
            ?.grip}`
        : "none";
      const raySpacesAvail = xrInput?.xrOrigin?.raySpaces
        ? `L=${!!xrInput.xrOrigin.raySpaces.left} R=${!!xrInput.xrOrigin
            .raySpaces.right}`
        : "none";
      const fingertipsAvail = fingertipColliders?.size || 0;

      this.logger.log(
        `[DataLink] inputType=${inputType}, hands: L=${hasLeft} R=${hasRight}, VFX: L=${vfxLeft} R=${vfxRight}, panickingRobots=${panickingRobots.length}`
      );
      this.logger.log(
        `[DataLink] xrInput: gamepads(grip)=${gamepadsAvail}, raySpaces=${raySpacesAvail}, fingertips=${fingertipsAvail}`
      );

      // Log hand position if we have one
      if (handPositions.right) {
        this.logger.log(
          `[DataLink] Right hand pos: (${handPositions.right.x.toFixed(
            2
          )}, ${handPositions.right.y.toFixed(
            2
          )}, ${handPositions.right.z.toFixed(2)})`
        );
      }

      // Log nearest distance for right hand (primary)
      if (handPositions.right && panickingRobots.length > 0) {
        let minDist = Infinity;
        let nearestIdx = -1;
        let nearestPos = null;
        for (const { entityIndex, antennaPos } of panickingRobots) {
          const d = handPositions.right.distanceTo(antennaPos);
          if (d < minDist) {
            minDist = d;
            nearestIdx = entityIndex;
            nearestPos = antennaPos;
          }
        }
        if (nearestPos) {
          this.logger.log(
            `[DataLink] Nearest antenna (robot ${nearestIdx}) pos: (${nearestPos.x.toFixed(
              2
            )}, ${nearestPos.y.toFixed(2)}, ${nearestPos.z.toFixed(2)})`
          );
          this.logger.log(
            `[DataLink] Distance to nearest: ${minDist.toFixed(
              3
            )}m (VFX maxDist=${
              this._dataLinkVFX.right?.config?.maxDistance || 0.6
            }m)`
          );
        }
      }
    }

    // Update VFX only for the preferred hand based on handedness setting
    const preferredHand = gameState.getState().handedness || "right";
    const nonPreferredHand = preferredHand === "right" ? "left" : "right";

    // Stop VFX on non-preferred hand if it was active
    const nonPreferredVfx = this._dataLinkVFX[nonPreferredHand];
    if (nonPreferredVfx?.isActive) {
      nonPreferredVfx.stop();
      this._dataLinkTargets[nonPreferredHand] = null;
    }

    for (const side of [preferredHand]) {
      const vfx = this._dataLinkVFX[side];
      if (!vfx) continue;

      const handPos = handPositions[side];
      if (!handPos) {
        vfx.stop();
        this._dataLinkTargets[side] = null;
        continue;
      }

      // Find nearest panicking robot to this hand
      let nearestRobot = null;
      let nearestDist = Infinity;

      for (const { entityIndex, antennaPos } of panickingRobots) {
        const dist = handPos.distanceTo(antennaPos);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestRobot = { entityIndex, antennaPos };
        }
      }

      if (nearestRobot && nearestDist < vfx.config.maxDistance) {
        // Update VFX with positions
        if (!vfx.isActive) {
          vfx.start();
          this.logger.log(
            `[DataLink] VFX ${side} started - robot ${
              nearestRobot.entityIndex
            } at ${nearestDist.toFixed(3)}m`
          );
        }
        this._dataLinkTargets[side] = nearestRobot.entityIndex;
        vfx.updatePositions(nearestRobot.antennaPos, handPos, deltaTime);

        // Lerp face and tie color from red toward white based on progress
        const progress = vfx.getProgress();
        if (progress > 0) {
          const r = Math.round(255);
          const g = Math.round(51 + (255 - 51) * progress); // 51 is 0x33
          const b = Math.round(51 + (255 - 51) * progress);
          const color = `rgb(${r},${g},${b})`;
          this.robotSystem.setRobotFaceColor(nearestRobot.entityIndex, color);
          this.robotSystem.setRobotTieColor(nearestRobot.entityIndex, color);
        }
      } else {
        // No nearby panicking robot
        if (vfx.isActive) {
          this.logger.log(
            `[DataLink] VFX ${side} stopped - nearest was ${nearestDist.toFixed(
              3
            )}m`
          );
          // Reset face and tie color back to red for the robot we were targeting
          const prevTarget = this._dataLinkTargets[side];
          if (prevTarget !== null) {
            const prevState = this.getState(prevTarget);
            if (prevState?.isPanicking) {
              this.robotSystem.setRobotFaceColor(prevTarget, "#ff3333");
              this.robotSystem.setRobotTieColor(prevTarget, "#ff3333");
            }
          }
        }
        vfx.stop();
        this._dataLinkTargets[side] = null;
      }
    }
  }

  /**
   * Get panic rotation offset for a robot (for slow spinning in place)
   * @returns {number} Rotation offset in radians, or 0 if not panicking
   */
  getPanicRotation(entityIndex) {
    const state = this.robotState.get(entityIndex);
    if (!state?.isPanicking) return 0;
    return state.panicRotation;
  }

  /**
   * Get rotation transition offset when panic ends (smoothly transitions from panic rotation to normal)
   * @param {number} entityIndex - Robot entity index
   * @param {number} targetAngle - Target facing angle (without panic rotation)
   * @returns {number} Rotation offset to apply for smooth transition
   */
  getPanicRotationTransition(entityIndex, targetAngle) {
    const state = this.robotState.get(entityIndex);
    if (!state?.panicRotationTransition) return 0;

    const transition = state.panicRotationTransition;
    const now = performance.now();
    const elapsed = (now - transition.startTime) / 1000; // Convert to seconds

    if (elapsed >= transition.duration) {
      // Transition complete - clear it
      state.panicRotationTransition = null;
      return 0;
    }

    // Normalize angles to [-PI, PI] range for proper lerping
    const normalizeAngle = (angle) => {
      while (angle > Math.PI) angle -= 2 * Math.PI;
      while (angle < -Math.PI) angle += 2 * Math.PI;
      return angle;
    };

    const startAngle = normalizeAngle(transition.startAngle);
    const normalizedTarget = normalizeAngle(targetAngle);

    // Find shortest path between angles
    let angleDiff = normalizedTarget - startAngle;
    if (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    if (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

    // Lerp from start angle to target angle
    const t = elapsed / transition.duration;
    const easedT = 1 - Math.pow(1 - t, 3); // Ease out cubic
    const currentAngle = startAngle + angleDiff * easedT;

    // Return the offset needed to get from targetAngle to currentAngle
    return normalizeAngle(currentAngle - normalizedTarget);
  }

  /**
   * Update panic rotation for a robot (called each frame)
   */
  updatePanicRotation(entityIndex, deltaTime) {
    const state = this.robotState.get(entityIndex);
    if (!state?.isPanicking) return;
    state.panicRotation += state.panicRotationSpeed * deltaTime;
  }

  /**
   * End panic minigame
   */
  endPanicMinigame() {
    if (!this.minigameActive) return;

    this.minigameActive = false;

    // Update global game state
    gameState.setState({ minigameActive: false });

    // Return all robots to normal
    for (const [entityIndex] of this.robotSystem.robotEntities) {
      const state = this.getState(entityIndex);
      state.isPanicking = false;

      const stateMachine = this.robotSystem.stateMachine;
      if (stateMachine) {
        stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);
      }

      // Stop panic VFX
      this.robotSystem.scanManager?.stopPanicVFX(entityIndex);

      this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.NEUTRAL);
    }

    // Clean up data link VFX
    this._disposeDataLinkVFX();

    this.logger.log("Panic minigame ended!");

    if (this.onMinigameComplete) {
      this.onMinigameComplete();
    }
  }

  /**
   * Dispose DataLinkVFX instances
   */
  _disposeDataLinkVFX() {
    const scene = this.robotSystem.world?.scene;
    for (const side of ["left", "right"]) {
      const vfx = this._dataLinkVFX[side];
      if (vfx) {
        vfx.dispose();
        if (scene) scene.remove(vfx.group);
        this._dataLinkVFX[side] = null;
      }
      this._dataLinkTargets[side] = null;
    }
  }

  /**
   * Handle pat on a robot
   * @param {number} entityIndex - Robot entity index
   * @param {boolean} fromDataLink - Whether this was triggered by data link contact
   */
  _handlePat(entityIndex, fromDataLink = false) {
    const state = this.getState(entityIndex);
    const now = performance.now() / 1000;

    // Cooldown check
    if (now - state.lastPatTime < this.patConfig.cooldown) {
      return;
    }
    state.lastPatTime = now;

    this.logger.log(
      `[Pat] Robot ${entityIndex} patted! isPanicking=${state.isPanicking}, fromDataLink=${fromDataLink}`
    );

    // Handle based on current state
    if (state.isPanicking) {
      // Minigame: calm this robot - update state FIRST before any visuals
      const currentPanicRotation = state.panicRotation;
      state.isPanicking = false;
      state.panicRotation = 0;
      state.panicCooldownUntil = performance.now() + 10000; // 10 second debounce for this robot

      // Start smooth rotation transition from current panic rotation to 0
      // Get current robot rotation to calculate target
      const robotEntity = this.robotSystem.robotEntities.get(entityIndex);
      if (robotEntity) {
        const orientation = robotEntity.getVectorView(
          this.robotSystem.Transform,
          "orientation"
        );
        if (orientation) {
          const currentQuat = new Quaternion(
            orientation[0],
            orientation[1],
            orientation[2],
            orientation[3]
          );
          // Extract Y rotation from current quaternion
          const euler = new Euler();
          euler.setFromQuaternion(currentQuat, "YXZ");
          const startAngle = euler.y;

          // Start transition: lerp from current angle to target (which will be calculated each frame)
          state.panicRotationTransition = {
            startAngle: startAngle,
            startTime: performance.now(),
            duration: 0.5, // 0.5 seconds to smoothly transition
          };
        }
      }

      // Set global cooldown: 4-10 seconds before next panic can start
      const cooldownDuration = 4000 + Math.random() * 6000; // 4-10 seconds
      this.panicCooldownUntil = performance.now() + cooldownDuration;

      this.minigameCalmCount++;

      // Trigger calm dialogs via gameState
      if (this.minigameCalmCount === 1) {
        gameState.setState({ firstCalmCompleted: true });
      } else if (this.minigameCalmCount === 2) {
        gameState.setState({ secondCalmCompleted: true });
      } else if (this.minigameCalmCount === 3) {
        gameState.setState({ thirdCalmCompleted: true });
      }

      // Stop panic VFX for this robot
      this.robotSystem.scanManager?.stopPanicVFX(entityIndex);

      // Reset face and tie color back to white, then set happy face
      this.robotSystem.setRobotFaceColor(entityIndex, "#ffffff");
      this.robotSystem.setRobotTieColor(entityIndex, "#ffffff");
      this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.EXCITED);

      // Play happy sound
      const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) voice.happy?.();

      // If from data link contact, make robot look at player and do happy jump
      if (fromDataLink) {
        this._triggerHappyReaction(entityIndex);
      }

      // Play success sound and spawn particle burst
      uiAudio.scoreUp();
      const agentId = this.robotSystem.robotAgentIds.get(entityIndex);
      if (robotEntity) {
        const pos = robotEntity.getVectorView(
          this.robotSystem.Transform,
          "position"
        );
        const burstPos = new Vector3(pos[0], pos[1] + 0.15, pos[2]);
        this.robotSystem.world?.vfxManager?.createCalmBurst(burstPos);
      }

      // State transition handled differently based on how robot was calmed
      const stateMachine = this.robotSystem.stateMachine;
      if (fromDataLink) {
        // Data link: _triggerHappyReaction handles state (STATIONARY -> WANDERING after 3s)
      } else {
        // Pet: immediately resume wandering
        if (stateMachine) {
          stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);
        }
        if (robotEntity && agentId !== undefined) {
          this.robotSystem.navigationManager?.selectRandomWanderTarget(
            robotEntity,
            agentId
          );
        }
      }

      this.logger.log(
        `Robot calmed! (${this.minigameCalmCount}/${this.minigameCalmGoal}) - cooldown 10s`
      );

      if (this.onScoreUpdate) {
        this.onScoreUpdate(this.minigameCalmCount, this.minigameCalmGoal);
      }

      // Check if minigame complete
      if (this.minigameCalmCount >= this.minigameCalmGoal) {
        this.endPanicMinigame();
      }
    } else if (state.isSummoned && !state.questionPlayed) {
      // Robot was summoned by name - trigger question dialog
      state.questionPlayed = true;
      this._triggerQuestionDialog(entityIndex);
    } else {
      // Normal pat (not panicking, not summoned) - just happy reaction
      this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.EXCITED);
      const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) voice.happy?.();
    }
  }

  /**
   * Trigger happy reaction when data link connection is made
   * Robot looks at user for 3 seconds, does happy jump, plays voice, then resumes nav
   */
  _triggerHappyReaction(entityIndex) {
    const robotEntity = this.robotSystem.robotEntities.get(entityIndex);
    if (!robotEntity) return;

    const state = this.getState(entityIndex);

    // Set happy reaction lock - prevents navigation during reaction
    // Also enables continuous look-at-player behavior
    state.happyReactionUntil = performance.now() + 3000;
    state.lookAtPlayerUntil = performance.now() + 3000;

    // Stop robot movement
    this.robotSystem.navigationManager?.stopRobotMovement(entityIndex);

    // Set to STATIONARY state to prevent any automatic navigation
    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.STATIONARY);
    }

    // Make robot body face the player initially
    const world = this.robotSystem.world;
    const player = world?.player;
    if (player?.head) {
      player.head.getWorldPosition(this._tempVec3);

      const robotPos = robotEntity.object3D?.position;
      if (robotPos) {
        // Calculate angle to player
        const dx = this._tempVec3.x - robotPos.x;
        const dz = this._tempVec3.z - robotPos.z;
        const targetAngle = Math.atan2(dx, dz);

        // Set robot rotation to face player
        if (robotEntity.object3D) {
          robotEntity.object3D.rotation.y = targetAngle;
        }
      }

      // Initial head look-at (will be continuously updated in updateHappyReaction)
      const faceManager = this.robotSystem.getFaceManager(entityIndex);
      if (faceManager) {
        faceManager.lookAtPosition(this._tempVec3);
      }
    }

    // Trigger happy jump animation
    this.robotSystem.interactionManager?.triggerSoloAnimation(
      entityIndex,
      "happy"
    );

    // Play additional happy voice after short delay
    setTimeout(() => {
      const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) voice.happy?.();
    }, 300);

    // Resume navigation after 3 seconds of looking at player
    setTimeout(() => {
      const agentId = this.robotSystem.robotAgentIds.get(entityIndex);
      const currentState = this.getState(entityIndex);

      // Clear the happy reaction lock
      currentState.happyReactionUntil = 0;

      if (robotEntity && agentId !== undefined) {
        // Transition to WANDERING state
        if (stateMachine) {
          stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);
        }
        this.robotSystem.navigationManager?.selectRandomWanderTarget(
          robotEntity,
          agentId
        );
        this.logger.log(
          `[DataLink] Robot ${entityIndex} resuming navigation after happy reaction`
        );
      }
    }, 3000);

    this.logger.log(`[DataLink] Robot ${entityIndex} happy reaction triggered`);
  }

  /**
   * Trigger the question dialog for this robot
   */
  _triggerQuestionDialog(entityIndex) {
    const character =
      this.robotSystem.characterManager?.getCharacter(entityIndex);
    if (!character) {
      this.logger.warn(`No character for robot ${entityIndex}`);
      return;
    }

    // Play inquisitive sound after short delay
    setTimeout(() => {
      const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) voice.inquisitive?.();
    }, 1000);

    // Get reference to dialog manager and wrist UI
    const world = this.robotSystem.world;
    const aiManager = world?.aiManager;
    const dialogManager = aiManager?.dialogManager;
    const wristUI = aiManager?.wristUI;

    if (!dialogManager) {
      this.logger.warn("DialogManager not available");
      return;
    }

    // Show VidConf panel
    if (wristUI) {
      // Use WRIST_UI_STATE.ACTIVE_CALL to show the call panel
      wristUI.setState?.("active_call");
    }

    // Play robot-specific question dialog
    const dialogId = `robotQuestion_${character.id}`;

    setTimeout(() => {
      dialogManager.playDialog(dialogId);

      // After dialog completes, transition to following
      if (dialogManager.onDialogComplete) {
        const originalCallback = dialogManager.onDialogComplete;
        dialogManager.onDialogComplete = (dialog) => {
          originalCallback?.(dialog);
          if (dialog?.id === dialogId) {
            this._startFollowing(entityIndex);
            dialogManager.onDialogComplete = originalCallback;
          }
        };
      } else {
        dialogManager.onDialogComplete = (dialog) => {
          if (dialog?.id === dialogId) {
            this._startFollowing(entityIndex);
            dialogManager.onDialogComplete = null;
          }
        };
      }
    }, 2000);
  }

  /**
   * Start following the player
   */
  _startFollowing(entityIndex) {
    const state = this.getState(entityIndex);
    state.isFollowing = true;
    state.currentBreadcrumbIndex = 0;

    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.FOLLOWING_PLAYER);
    }

    this.logger.log(`Robot ${entityIndex} now following player`);
  }

  /**
   * Navigate robot toward player position
   */
  _navigateToPlayer(entityIndex) {
    const world = this.robotSystem.world;
    const player = world?.player;
    if (!player?.head) return;

    // Get player position
    player.head.getWorldPosition(this._tempVec3);

    // Find nearest point on navmesh (below player)
    const navMesh = this.robotSystem.navMesh;
    if (!navMesh) return;

    const targetPos = [
      this._tempVec3.x,
      this._tempVec3.y - 1.5,
      this._tempVec3.z,
    ];

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      navMesh,
      targetPos,
      [2, 2, 2],
      DEFAULT_QUERY_FILTER
    );

    if (!nearestResult.success) {
      this.logger.warn("Could not find navmesh point near player");
      return;
    }

    const agentId = this.robotSystem.robotAgentIds.get(entityIndex);
    if (agentId === null || agentId === undefined) return;

    crowd.requestMoveTarget(
      this.robotSystem.agents,
      agentId,
      nearestResult.nodeRef,
      nearestResult.position
    );
  }

  /**
   * Cancel any current behavior for robot
   */
  _cancelCurrentBehavior(entityIndex) {
    const state = this.getState(entityIndex);
    state.isSummoned = false;
    state.isFollowing = false;
    state.isFlying = false;

    // Stop navigation
    this.robotSystem.navigationManager?.stopRobotMovement(entityIndex);
  }

  /**
   * Update breadcrumb trail
   */
  _updateBreadcrumbs(deltaTime) {
    const now = performance.now() / 1000;
    if (now - this._lastBreadcrumbTime < this.breadcrumbInterval) return;
    this._lastBreadcrumbTime = now;

    const world = this.robotSystem.world;
    const player = world?.player;
    if (!player?.head) return;

    // Get player head position
    player.head.getWorldPosition(this._tempVec3);

    // Add new breadcrumb
    this.breadcrumbs.push({
      position: this._tempVec3.clone(),
      time: now,
      onNavmesh: this._isPositionOnNavmesh(this._tempVec3),
    });

    // Trim old breadcrumbs
    while (this.breadcrumbs.length > this.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Check if position is on navmesh
   */
  _isPositionOnNavmesh(position) {
    const navMesh = this.robotSystem.navMesh;
    if (!navMesh) return false;

    const pos = [position.x, position.y, position.z];
    const result = findNearestPoly(
      createFindNearestPolyResult(),
      navMesh,
      pos,
      [0.5, 2, 0.5],
      DEFAULT_QUERY_FILTER
    );

    if (!result.success) return false;

    // Check if nearest point is close enough
    const dx = result.position[0] - position.x;
    const dy = result.position[1] - position.y;
    const dz = result.position[2] - position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    return dist < 0.5;
  }

  /**
   * Update following behavior for a robot
   */
  _updateFollowing(entityIndex, robotEntity, deltaTime) {
    const state = this.getState(entityIndex);
    if (!state.isFollowing || this.breadcrumbs.length === 0) return;

    const robotPos = robotEntity.object3D?.position;
    if (!robotPos) return;

    // Get target breadcrumb (oldest one the robot hasn't reached)
    const targetCrumb = this.breadcrumbs[0];
    if (!targetCrumb) return;

    // Check if robot reached current breadcrumb
    const dx = robotPos.x - targetCrumb.position.x;
    const dz = robotPos.z - targetCrumb.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.5) {
      // Reached breadcrumb, remove it
      this.breadcrumbs.shift();

      // Navigate to next breadcrumb
      if (this.breadcrumbs.length > 0) {
        this._navigateToBreadcrumb(entityIndex, this.breadcrumbs[0]);
      }
      return;
    }

    // Check if target is on navmesh
    if (!targetCrumb.onNavmesh && !state.isFlying) {
      // Switch to flight mode
      this._startFlightMode(entityIndex, targetCrumb.position);
    } else if (targetCrumb.onNavmesh && state.isFlying) {
      // Return to navmesh following
      this._endFlightMode(entityIndex);
    }
  }

  /**
   * Navigate to a breadcrumb position
   */
  _navigateToBreadcrumb(entityIndex, crumb) {
    const navMesh = this.robotSystem.navMesh;
    if (!navMesh) return;

    const targetPos = [
      crumb.position.x,
      crumb.position.y - 1.5,
      crumb.position.z,
    ];

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      navMesh,
      targetPos,
      [2, 3, 2],
      DEFAULT_QUERY_FILTER
    );

    if (!nearestResult.success) return;

    const agentId = this.robotSystem.robotAgentIds.get(entityIndex);
    if (agentId === null || agentId === undefined) return;

    crowd.requestMoveTarget(
      this.robotSystem.agents,
      agentId,
      nearestResult.nodeRef,
      nearestResult.position
    );
  }

  /**
   * Start flight mode for off-navmesh following
   */
  _startFlightMode(entityIndex, targetPosition) {
    const state = this.getState(entityIndex);
    state.isFlying = true;
    state.flightTargetY = targetPosition.y - 1.0; // Target below head

    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.FLYING_FOLLOW);
    }

    // Stop navcat agent movement
    this.robotSystem.navigationManager?.stopRobotMovement(entityIndex);

    this.logger.log(`Robot ${entityIndex} entering flight mode`);
  }

  /**
   * End flight mode, return to navmesh following
   */
  _endFlightMode(entityIndex) {
    const state = this.getState(entityIndex);
    state.isFlying = false;

    const stateMachine = this.robotSystem.stateMachine;
    if (stateMachine) {
      stateMachine.forceState(entityIndex, ROBOT_STATE.FOLLOWING_PLAYER);
    }

    this.logger.log(`Robot ${entityIndex} returning to navmesh following`);
  }

  /**
   * Update flight movement for a robot
   */
  _updateFlight(entityIndex, robotEntity, deltaTime) {
    const state = this.getState(entityIndex);
    if (!state.isFlying || this.breadcrumbs.length === 0) return;

    const robotPos = robotEntity.object3D?.position;
    if (!robotPos) return;

    const targetCrumb = this.breadcrumbs[0];
    if (!targetCrumb) return;

    // Direct lerp toward target
    const lerpSpeed = 2.0 * deltaTime;

    robotPos.x += (targetCrumb.position.x - robotPos.x) * lerpSpeed;
    robotPos.y += (state.flightTargetY - robotPos.y) * lerpSpeed;
    robotPos.z += (targetCrumb.position.z - robotPos.z) * lerpSpeed;

    // Add hover bob
    const bobAmount = Math.sin(performance.now() / 300) * 0.02;
    robotPos.y += bobAmount;

    // Check if reached target
    const dx = robotPos.x - targetCrumb.position.x;
    const dz = robotPos.z - targetCrumb.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.5) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Check for pat detection on robot (uses antenna tip position)
   * Supports both hand tracking (fingertip colliders) and controllers (grip position)
   */
  _checkPatDetection(entityIndex, robotEntity, deltaTime) {
    const state = this.getState(entityIndex);
    const now = performance.now() / 1000;

    // Skip if on cooldown
    if (now - state.lastPatTime < this.patConfig.cooldown) return;

    // Get antenna tip for this robot
    const antennaTip = this._getAntennaTip(entityIndex, robotEntity);
    if (!antennaTip) return;

    // Get antenna tip world position
    antennaTip.getWorldPosition(this._tempVec3B);

    // Get XR input system
    const xrInputSystem = this.robotSystem.world?.xrInputSystem;
    if (!xrInputSystem) return;

    // Build list of input sources to check (fingertips or controller grips)
    const inputSources = [];

    // Try fingertip colliders first (hand tracking)
    const fingertipColliders = xrInputSystem.fingertipColliders;
    if (fingertipColliders && fingertipColliders.size > 0) {
      for (const side of ["left", "right"]) {
        const colliderData = fingertipColliders.get(`${side}_index`);
        if (colliderData?.joint) {
          inputSources.push({
            side,
            source: colliderData.joint,
            type: "fingertip",
          });
        }
      }
    }

    // Fallback to controller transforms (same pattern as SpatialMountManager._findController)
    if (inputSources.length === 0) {
      const xrInput = xrInputSystem.xrInput;
      if (xrInput?.gamepads) {
        for (const side of ["left", "right"]) {
          const pad = xrInput.gamepads[side];
          const controller = pad?.grip || pad?.object3D;
          if (controller) {
            inputSources.push({
              side,
              source: controller,
              type: "controller-grip",
            });
          }
        }
      }
      // Final fallback to raySpaces
      if (inputSources.length === 0 && xrInput?.xrOrigin?.raySpaces) {
        const raySpaces = xrInput.xrOrigin.raySpaces;
        for (const side of ["left", "right"]) {
          if (raySpaces[side]) {
            inputSources.push({
              side,
              source: raySpaces[side],
              type: "controller-ray",
            });
          }
        }
      }
    }

    if (inputSources.length === 0) return;

    // Check each input source
    for (const { side, source, type } of inputSources) {
      // Get input world position
      source.getWorldPosition(this._tempVec3);

      // Calculate distance to antenna tip
      const dx = this._tempVec3.x - this._tempVec3B.x;
      const dy = this._tempVec3.y - this._tempVec3B.y;
      const dz = this._tempVec3.z - this._tempVec3B.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Use larger detection radius for controllers (they're bigger than fingertips)
      const isController = type.startsWith("controller");
      const detectionRadius = isController
        ? this.patConfig.detectionRadius * 1.5
        : this.patConfig.detectionRadius;

      // Check if within pat detection radius
      if (dist < detectionRadius) {
        // Calculate hand/controller velocity (downward)
        const prevPos = this._prevHandPositions[side];
        const velocityY = (this._tempVec3.y - prevPos.y) / deltaTime;

        // Update pat squash based on proximity
        const penetration = Math.max(0, detectionRadius - dist);
        state.patSquashAmount = -penetration * 3; // Negative = squash down

        // Check for downward motion (pat gesture) - controllers need less strict check
        const minVelocity = isController
          ? this.patConfig.minDownwardVelocity * 0.5 // More lenient for controllers
          : this.patConfig.minDownwardVelocity;

        if (velocityY < minVelocity) {
          this._handlePat(entityIndex);
        }
      }

      // Store current position for next frame velocity calculation
      this._prevHandPositions[side].copy(this._tempVec3);
    }

    // Spring back pat squash when hand not touching
    if (Math.abs(state.patSquashAmount) > 0.001) {
      const springForce = -state.patSquashAmount * 20;
      state.patSquashVelocity += springForce * deltaTime;
      state.patSquashVelocity *= 0.85; // Damping
      state.patSquashAmount += state.patSquashVelocity * deltaTime;
    }
  }

  /**
   * Update attending player behavior
   */
  _updateAttending(entityIndex, robotEntity, deltaTime) {
    const state = this.getState(entityIndex);
    if (!state.isSummoned) return;

    const world = this.robotSystem.world;
    const player = world?.player;
    if (!player?.head) return;

    // Get positions
    const robotPos = robotEntity.object3D?.position;
    if (!robotPos) return;

    player.head.getWorldPosition(this._tempVec3);

    // Calculate distance to player
    const dx = this._tempVec3.x - robotPos.x;
    const dz = this._tempVec3.z - robotPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // If close enough, stop and look at player
    if (dist < 1.0) {
      this.robotSystem.navigationManager?.stopRobotMovement(entityIndex);

      // If in reassurance mode, cycle through worried faces
      if (state.needsReassurance) {
        const now = performance.now() / 1000;
        const worriedFaceInterval = 2.5 + Math.random() * 1.5; // 2.5-4 seconds

        if (now - state.lastWorriedFaceTime > worriedFaceInterval) {
          state.lastWorriedFaceTime = now;

          // Cycle through worried/sad/fear faces
          const worriedEmotions = [
            RobotEmotion.SAD,
            RobotEmotion.FEAR,
            RobotEmotion.ANGRY,
          ];
          const emotion =
            worriedEmotions[Math.floor(Math.random() * worriedEmotions.length)];
          this.robotSystem.setRobotFaceEmotion(entityIndex, emotion);

          // Occasionally play a worried sound
          if (Math.random() < 0.3) {
            const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
            if (voice) {
              const sounds = ["sad", "angry"];
              const sound = sounds[Math.floor(Math.random() * sounds.length)];
              voice[sound]?.();
            }
          }
        }
      }
    } else {
      // Continue navigating toward player
      this._navigateToPlayer(entityIndex);
    }
  }

  /**
   * Get pat squash contribution for a robot
   */
  getPatSquash(entityIndex) {
    const state = this.robotState.get(entityIndex);
    return state?.patSquashAmount || 0;
  }

  /**
   * Main update - called from RobotSystem each frame
   */
  update(entityIndex, robotEntity, agent, deltaTime) {
    const state = this.getState(entityIndex);
    const currentState = this.robotSystem.stateMachine?.getState(entityIndex);

    // Update breadcrumbs if any robot is following
    if (state.isFollowing) {
      this._updateBreadcrumbs(deltaTime);
    }

    // Update continuous look-at-player during happy reaction
    if (
      state.lookAtPlayerUntil &&
      performance.now() < state.lookAtPlayerUntil
    ) {
      this._updateLookAtPlayer(entityIndex, robotEntity);
    }

    // State-specific updates
    switch (currentState) {
      case ROBOT_STATE.ATTENDING_PLAYER:
        this._updateAttending(entityIndex, robotEntity, deltaTime);
        this._checkPatDetection(entityIndex, robotEntity, deltaTime);
        break;

      case ROBOT_STATE.FOLLOWING_PLAYER:
        this._updateFollowing(entityIndex, robotEntity, deltaTime);
        break;

      case ROBOT_STATE.FLYING_FOLLOW:
        this._updateFlight(entityIndex, robotEntity, deltaTime);
        break;

      case ROBOT_STATE.PANICKING:
        this._updatePanic(entityIndex, robotEntity, deltaTime);
        this._checkPatDetection(entityIndex, robotEntity, deltaTime);
        break;
    }
  }

  /**
   * Update robot to continuously look at player (used during happy reaction)
   */
  _updateLookAtPlayer(entityIndex, robotEntity) {
    const world = this.robotSystem.world;
    const player = world?.player;
    if (!player?.head) return;

    player.head.getWorldPosition(this._tempVec3);

    const faceManager = this.robotSystem.getFaceManager(entityIndex);
    if (faceManager) {
      // Get robot's world position for proper look-at calculation
      const robotPos = robotEntity.object3D?.position;
      if (robotPos) {
        this._tempVec3B.set(robotPos.x, robotPos.y, robotPos.z);

        // Get current body facing
        const bodyFacing = robotEntity.object3D?.rotation?.y || 0;

        // Use lookAtWithBodyOverflow for smooth tracking like post-portal state
        faceManager.lookAtWithBodyOverflow(
          this._tempVec3,
          this._tempVec3B,
          bodyFacing
        );
      }
    }
  }

  /**
   * Update panic state - play periodic distressed sounds and navigate (robots 4+5)
   */
  _updatePanic(entityIndex, robotEntity, deltaTime) {
    const state = this.getState(entityIndex);
    if (!state.isPanicking) return;

    const now = performance.now() / 1000;
    const panicSoundInterval = 3.0 + Math.random() * 2.0; // 3-5 seconds

    if (!state.lastPanicSoundTime) state.lastPanicSoundTime = now;

    if (now - state.lastPanicSoundTime > panicSoundInterval) {
      state.lastPanicSoundTime = now;

      // Play distressed sound
      const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) {
        const sounds = ["angry", "sad"];
        const sound = sounds[Math.floor(Math.random() * sounds.length)];
        voice[sound]?.();
      }

      // Randomly switch between fear and angry face
      const emotions = [RobotEmotion.FEAR, RobotEmotion.ANGRY];
      const emotion = emotions[Math.floor(Math.random() * emotions.length)];
      this.robotSystem.setRobotFaceEmotion(entityIndex, emotion);
    }

    // 4th and 5th panics continue navigating while panicking (moving panic)
    if (state.panicNumber >= 4) {
      const agentId = this.robotSystem.robotAgentIds?.get(entityIndex);
      if (agentId !== null && agentId !== undefined) {
        const agent = this.robotSystem.agents?.agents?.[agentId];
        if (agent) {
          // Compute desired speed from desiredVelocity vector (same as RobotSystem)
          const desVel = agent.desiredVelocity || [0, 0, 0];
          const desiredSpeed = Math.sqrt(
            desVel[0] * desVel[0] +
              desVel[1] * desVel[1] +
              desVel[2] * desVel[2]
          );
          // Check if robot is nearly stopped (reached target or stuck)
          if (desiredSpeed < 0.1) {
            this.logger.log(
              `[Panic] Robot ${entityIndex} stopped (speed=${desiredSpeed.toFixed(
                3
              )}), setting new target`
            );
            this.robotSystem.navigationManager?.selectRandomWanderTarget(
              robotEntity,
              agentId
            );
          }
        }
      }
    }

    // Update scan VFX (lasers)
    const vfx = this.robotSystem.scanManager?.robotScanVFX?.get(entityIndex);
    if (vfx) {
      vfx.update(deltaTime);
    }
  }

  /**
   * Cleanup state for removed robot
   */
  removeRobot(entityIndex) {
    this.robotState.delete(entityIndex);
    this._antennaTips.delete(entityIndex);
  }

  /**
   * Reset all state
   */
  reset() {
    this.robotState.clear();
    this.breadcrumbs = [];
    this.minigameActive = false;
    this.minigameCalmCount = 0;
    this.minigamePanicCount = 0;
    this._antennaTips.clear();

    // Cleanup DataLinkVFX
    this._disposeDataLinkVFX();
  }
}
