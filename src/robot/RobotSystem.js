/**
 * RobotSystem.js - CENTRAL ORCHESTRATOR for all robot behavior
 * =============================================================================
 *
 * ROLE: The main ECS system that coordinates all robot subsystems. This is the
 * entry point and update loop for robot behavior. It manages the navcat crowd
 * simulation, delegates to specialized managers, and handles XR room setup.
 *
 * KEY RESPONSIBILITIES:
 * - ECS system lifecycle (init, update, dispose)
 * - NavMesh crowd simulation via navcat library
 * - Room capture flow for Meta Quest spatial setup
 * - Coordinates all per-robot managers (face, arms, tie, antenna, etc.)
 * - Applies procedural animations (tilt, squash/stretch, banking)
 * - Debug visualization toggles
 *
 * MANAGER DELEGATION PATTERN:
 * RobotSystem owns instances of specialized managers and calls their update()
 * methods each frame, passing relevant state. Managers are:
 *   - movementManager: Tilt, facing, squash/stretch, anticipation/follow-through
 *   - interactionManager: Robot-to-robot proximity interactions
 *   - scanManager: Periodic scanning behavior with VFX/audio
 *   - audioManager: Engine sounds and voice chatter
 *   - navMeshManager: NavMesh generation and off-mesh connections
 *
 * PER-ROBOT STATE: Consolidated in this.robotState Map for single-lookup access.
 * Legacy Maps (robotEntities, robotAgentIds, etc.) kept for backward compat.
 *
 * COORDINATE SYSTEM: Robot's local forward is -Y (Blender export convention).
 *
 * DEBUG: ?navmeshDebug=true or world.robotSystem.setDebugVisuals(true)
 *
 * KNOWN ISSUES:
 * - Room capture only works once per web session (WebXR limitation)
 * - Large file (~3000 lines) - consider further decomposition
 * =============================================================================
 */

import {
  AudioUtils,
  createSystem,
  Pressed,
  Vector3,
  Quaternion,
  Euler,
  SphereGeometry,
  MeshBasicMaterial,
  Mesh,
  Transform,
} from "@iwsdk/core";
import { Logger } from "../utils/Logger.js";
import { RobotEnvMapLoader } from "./RobotEnvMapLoader.js";
import { Robot } from "../components/Robot.js";
import {
  RobotFaceManager,
  RobotEmotion,
  EMOTION_GROUPS,
} from "./RobotFaceManager.js";
import { RobotArmManager, ArmState } from "./RobotArmManager.js";
import { RobotTieManager } from "./RobotTieManager.js";
import { gameState } from "../gameState.js";
import { setMasterVolume } from "../audio/audioContext.js";
import { RobotEngineThrustVFX } from "../vfx/RobotEngineThrustVFX.js";
import { RobotScanManager } from "./RobotScanManager.js";
import { RobotAudioManager } from "./RobotAudioManager.js";
import { RobotMovementManager } from "./RobotMovementManager.js";
import { RobotInteractionManager } from "./RobotInteractionManager.js";
import { RobotNavMeshManager } from "./RobotNavMeshManager.js";
import { RobotJumpManager } from "./RobotJumpManager.js";
import { RobotCharacterManager } from "./RobotCharacterManager.js";
import { RobotRoomSetupManager } from "./RobotRoomSetupManager.js";
import { RobotStateMachine } from "./RobotStateMachine.js";
import { ROBOT_STATE } from "./RobotBehaviorState.js";
import { RobotNavigationManager } from "./RobotNavigationManager.js";
import { RobotPlayerInteractionManager } from "./RobotPlayerInteractionManager.js";
import { getCharacterById } from "../data/robotCharacters.js";

import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  findPath,
  findRandomPoint,
} from "navcat";

import { crowd } from "navcat/blocks";

// NOTE: Empty queries {} so update() runs even before robots exist
// (needed for room setup and navmesh initialization)
// Robot entities are tracked manually via robotState Map
export class RobotSystem extends createSystem({}) {
  constructor(world) {
    super(world);
    this.world.robotSystem = this;
    this.logger = new Logger("RobotSystem", true);
    this.logger.log("RobotSystem constructor called");
  }

  init() {
    this.logger.log("RobotSystem init() called");
    this.vec3 = new Vector3();
    this.spawnVec3 = new Vector3();
    this.navMeshInitialized = false;
    this.navMesh = null;
    this.agents = null;
    // Consolidated robot state - single Map lookup per robot instead of 14+
    // Each entry: { entity, agentId, agentHelper, lastTargetTime, faceFlashState,
    //               faceLookState, character, nameTag, spawnPosition, faceManager,
    //               tieManager, thrustVFX, blobShadow }
    this.robotState = new Map();

    // Core Maps for entity/agent tracking (accessed by external managers)
    this.robotEntities = new Map();
    this.robotAgentIds = new Map();

    // Navigation timing
    this.targetInterval = 500; // Reduced from 5000 - how long robot pauses at target
    this.wanderInterval = 3000;
    this.useWandering = true;
    this.prevTime = performance.now();
    this.navMeshHelper = null;
    this.offMeshConnectionsHelper = null;

    this.spawnPosition = null;
    this.spawnTimer = 0;
    this.spawnInterval = 3000;
    this.pendingRobotEntities = [];
    this.maxRobots = 3;
    this.originalRobotEntity = null;

    this.goalPosition = null;
    this.goalNodeRef = null;
    this.goalAccessible = false;
    this.lastNavMeshRebuildTime = 0;

    // Behavior modes
    this.isStationary = false; // When true, robots don't move
    this.lookAtPlayer = false; // When true, robots face the player
    this.gatheredMode = true; // When true, new robots spawn stationary looking at player
    this.goalReachThreshold = 0.8; // Distance to consider "at goal" (meters)

    // === DEBUG: Toggle subsystems for performance testing ===
    // Set to true to skip ALL procedural animation (tilt/bank/squash/hover/jumps/idle)
    // Robot will just follow navcat position with no animation
    this._debugDisableMovement = false;

    // Movement manager (handles tilt, facing, squash/stretch)
    this.movementManager = new RobotMovementManager(this);

    // Interaction manager (handles robot-to-robot proximity interactions)
    this.interactionManager = new RobotInteractionManager(this);

    // NavMesh manager (handles navmesh generation, off-mesh connections, visualizations)
    this.navMeshManager = new RobotNavMeshManager(this);

    // Jump manager (handles off-mesh traversal jump physics and animation)
    this.jumpManager = new RobotJumpManager(this);

    // Face animation configs (state stored per-robot in robotState)
    this.faceFlashConfig = {
      flashDurationMin: 250, // Min flash duration in ms
      flashDurationMax: 500, // Max flash duration in ms
      intervalMin: 2000, // Min time between flashes in ms
      intervalMax: 5000, // Max time between flashes in ms
      emotions: EMOTION_GROUPS.POSITIVE, // Only flash positive emotions
    };
    this.faceLookConfig = {
      lookDurationMin: 800, // Min time looking at a target in ms
      lookDurationMax: 2000, // Max time looking at a target in ms
      lookIntervalMin: 500, // Min time between look changes in ms
      lookIntervalMax: 1500, // Max time between look changes in ms
    };

    // Reusable quaternions for rotation calculations
    this._quatY = new Quaternion();
    this._quatX = new Quaternion();
    this._quatZ = new Quaternion();
    this._quatCombined = new Quaternion();

    // Fast sin/cos lookup table (reference from movementManager)
    this._sinTable = this.movementManager._sinTable;
    this._twoPi = Math.PI * 2;

    // Reusable vector for audio listener direction
    this._audioForward = new Vector3();

    // Reusable vectors for antenna tracking
    this._tempVec3 = new Vector3();
    this._tempQuat = new Quaternion();
    this._tempEuler = new Euler();

    // Audio manager (handles engines, voices, chatter)
    this.audioManager = new RobotAudioManager(this);

    // Character manager (handles character assignment and name tags)
    this.characterManager = new RobotCharacterManager(this);

    // Legacy references for backward compatibility
    this.robotCharacters = this.characterManager.characters;
    this.robotNameTags = this.characterManager.nameTags;

    // Environment map loader for robot reflections
    this.envMapLoader = new RobotEnvMapLoader(this.world);
    this._envMapLoaded = false;

    // Scanning manager (handles scan state, VFX, laser hit tests)
    this.scanManager = new RobotScanManager(this);

    // Expose Transform component for managers
    this.Transform = Transform;

    // Listen for game state changes to update robot behavior
    this._setupGameStateListener();

    // Room setup manager (handles XR room capture and NavMesh init)
    this.roomSetupManager = new RobotRoomSetupManager(this);

    // State machine for per-robot behavior states
    this.stateMachine = new RobotStateMachine(this);

    // Navigation manager (handles goals, target selection, movement)
    this.navigationManager = new RobotNavigationManager(this);

    // Player interaction manager (handles name summoning, pat detection, follow, minigame)
    this.playerInteractionManager = new RobotPlayerInteractionManager(this);

    // Performance throttling - frame counter for non-critical updates
    this._frameCounter = 0;
    this._lastFaceTieUpdate = 0; // Time-based throttle for face/tie (~3x per second)

    // Debug visualization - off by default, enable with ?navmeshDebug=true or setDebugVisuals(true)
    const urlParams = new URLSearchParams(window.location.search);
    this.showDebugVisuals = urlParams.get("navmeshDebug") === "true";
    if (this.showDebugVisuals) {
      this.logger.log("NavMesh debug visuals enabled via URL parameter");
    }

    // Manual entity tracking since we don't use ECS queries
    // (System needs to run before any robots exist)
    // Robots are added via registerRobot() called from RobotSpawnerSystem
    this.logger.log(
      "RobotSystem ready - robots will be registered via registerRobot()"
    );
  }

  /**
   * Register a robot entity with this system
   * Called by RobotSpawnerSystem when spawning robots
   * @param {Entity} entity - The robot entity
   * @param {Object} options - Optional config (e.g., pre-created thrustVFX)
   */
  registerRobot(entity, options = {}) {
    if (!this.originalRobotEntity) {
      this.originalRobotEntity = entity;
    }
    // Store options on entity for use during spawn
    entity._spawnOptions = options;
    this.pendingRobotEntities.push(entity);
    this.logger.log(`Robot registered: entity ${entity.index}`);
  }

  /**
   * Get consolidated state for a robot (single lookup for all per-robot data)
   * @param {number} entityIndex
   * @returns {Object|null} Robot state object or null if not found
   */
  getRobotState(entityIndex) {
    return this.robotState.get(entityIndex) || null;
  }

  /**
   * Get face manager for a robot (convenience accessor for external managers)
   * @param {number} entityIndex
   * @returns {RobotFaceManager|null}
   */
  getFaceManager(entityIndex) {
    return this.robotState.get(entityIndex)?.faceManager || null;
  }

  /**
   * Get spawn position for a robot
   * @param {number} entityIndex
   * @returns {Array|null} [x, y, z] spawn position
   */
  getSpawnPosition(entityIndex) {
    return this.robotState.get(entityIndex)?.spawnPosition || null;
  }

  /**
   * Get current behavior state for a robot
   * @param {number} entityIndex
   * @returns {string} State from ROBOT_STATE enum
   */
  getRobotBehaviorState(entityIndex) {
    return this.stateMachine.getState(entityIndex);
  }

  /**
   * Set behavior state for a robot
   * @param {number} entityIndex
   * @param {string} state - State from ROBOT_STATE enum
   * @param {Object} metadata - Optional state-specific data
   * @returns {boolean} Whether transition succeeded
   */
  setRobotBehaviorState(entityIndex, state, metadata = null) {
    return this.stateMachine.setState(entityIndex, state, metadata);
  }

  /**
   * Enable or disable navmesh debug visualizations
   * @param {boolean} enabled - Whether to show debug visuals
   */
  setDebugVisuals(enabled) {
    this.showDebugVisuals = enabled;
    this.logger.log(
      `NavMesh debug visuals ${enabled ? "enabled" : "disabled"}`
    );

    if (enabled && this.navMeshManager.getNavMesh()) {
      this.navMeshManager.createVisualizations();
      this.navMeshManager.createOffMeshVisualization();
    } else if (!enabled) {
      this.navMeshManager.removeVisualizations();
      // Remove agent helpers
      for (const [, state] of this.robotState) {
        if (state.agentHelper) {
          this.world.scene.remove(state.agentHelper);
          state.agentHelper.geometry.dispose();
          state.agentHelper.material.dispose();
          state.agentHelper = null;
        }
      }
    }
  }

  /**
   * Enable or disable procedural robot audio
   * @param {boolean} enabled - Whether to play robot engine sounds
   */
  setAudioEnabled(enabled) {
    this.audioManager.setAudioEnabled(enabled);
  }

  /**
   * Stop all robot audio engines and VFX
   */
  stopAllAudio() {
    this.audioManager.stopAll();
    this.scanManager.stopAll();

    // Dispose all per-robot resources via consolidated state
    for (const [entityIndex, state] of this.robotState) {
      if (state.faceManager) state.faceManager.dispose();
      if (state.tieManager) state.tieManager.dispose();
      if (state.armManager) state.armManager.dispose?.();
      if (state.thrustVFX) state.thrustVFX.dispose();
      if (state.blobShadow) state.blobShadow.dispose();
    }
    this.robotState.clear();
    this.robotEntities.clear();
    this.robotAgentIds.clear();

    // Dispose environment map
    if (this.envMapLoader) {
      this.envMapLoader.dispose();
      this._envMapLoaded = false;
    }

    // Dispose character manager (handles name tags cleanup)
    if (this.characterManager) {
      this.characterManager.disposeAll();
    }
  }

  /**
   * Make a specific robot express an emotion (voice + face)
   * @param {number} entityIndex
   * @param {'content'|'excited'|'sad'|'angry'|'curious'|'acknowledge'|'awe'|'fear'|'thinking'} emotion
   */
  robotSpeak(entityIndex, emotion) {
    this.audioManager.robotSpeak(entityIndex, emotion);
    this.setRobotFaceEmotion(entityIndex, emotion);
  }

  /**
   * Make all robots express an emotion (voice + face)
   * @param {'content'|'excited'|'sad'|'angry'|'curious'|'acknowledge'|'awe'|'fear'|'thinking'} emotion
   */
  allRobotsSpeak(emotion) {
    for (const [entityIndex] of this.audioManager.robotVoices) {
      setTimeout(() => {
        this.audioManager.robotSpeak(entityIndex, emotion);
        this.setRobotFaceEmotion(entityIndex, emotion);
      }, Math.random() * 500);
    }
  }

  /**
   * Set a robot's face emotion (UV scroll on face texture)
   * @param {number} entityIndex
   * @param {'content'|'excited'|'sad'|'angry'|'curious'|'acknowledge'|'awe'|'fear'|'thinking'} emotion
   */
  setRobotFaceEmotion(entityIndex, emotion) {
    // Prevent emotion changes during panic (only allow FEAR or ANGRY)
    const playerState = this.playerInteractionManager?.getState(entityIndex);
    if (playerState?.isPanicking) {
      // Only allow panic-related emotions (FEAR, ANGRY) during panic
      if (emotion !== RobotEmotion.FEAR && emotion !== RobotEmotion.ANGRY) {
        return; // Block non-panic emotions
      }
    }

    const state = this.getRobotState(entityIndex);
    const faceManager = state?.faceManager;
    if (faceManager) {
      faceManager.setEmotion(emotion);
    }
  }

  /**
   * Set a robot's face pixel color
   * @param {number} entityIndex
   * @param {string} color - CSS color string (e.g. "#ff0000")
   */
  setRobotFaceColor(entityIndex, color) {
    const state = this.getRobotState(entityIndex);
    const faceManager = state?.faceManager;
    if (faceManager) {
      faceManager.setFaceColor(color);
    }
  }

  /**
   * Set a robot's tie pixel color
   * @param {number} entityIndex
   * @param {string} color - CSS color string (e.g. "#ff0000")
   */
  setRobotTieColor(entityIndex, color) {
    const state = this.getRobotState(entityIndex);
    const tieManager = state?.tieManager;
    if (tieManager) {
      tieManager.setTieColor(color);
    }
  }

  /**
   * Set all robots' face emotions
   */
  setAllRobotFaceEmotions(emotion) {
    for (const [, state] of this.robotState) {
      if (state.faceManager) {
        state.faceManager.setEmotion(emotion);
      }
    }
  }

  /**
   * Trigger a reaction for a robot by character name
   * Used for timed dialog events (e.g., when robot's name is called)
   * @param {string} robotName - Character name (Modem, Blit, Baud)
   * @param {string} reactionType - "excited" or animation type: "happy", "happyLoop", "happyBarrel", "happyBounce"
   */
  showNameTagByName(robotName) {
    this.characterManager.showNameTagByName(robotName);
  }

  triggerNamedRobotReaction(robotName, reactionType) {
    const result = this.characterManager.getByName(robotName);
    if (!result) {
      this.logger.warn(`Robot not found: ${robotName}`);
      return;
    }

    const { entityIndex, character } = result;
    const state = this.getRobotState(entityIndex);
    if (!state) return;

    // Use character's nameReactionAnimation if no specific reaction provided
    const anim = reactionType || character.nameReactionAnimation || "excited";

    this.logger.log(`${character.name} reacting: ${anim}`);

    // Play excited voice sound
    const voice = this.audioManager.getVoice(entityIndex);
    if (voice) {
      voice.excited();
    }

    // Flash through positive emotions
    const positiveEmotions = EMOTION_GROUPS.POSITIVE;
    let emotionIndex = 0;
    const flashInterval = setInterval(() => {
      if (emotionIndex < positiveEmotions.length) {
        this.setRobotFaceEmotion(entityIndex, positiveEmotions[emotionIndex]);
        emotionIndex++;
      } else {
        clearInterval(flashInterval);
        this.setRobotFaceEmotion(entityIndex, RobotEmotion.CONTENT);
      }
    }, 200);

    // Trigger animation via interaction manager if it's a specific animation type
    if (
      anim === "happy" ||
      anim === "happyLoop" ||
      anim === "happyBarrel" ||
      anim === "happyBounce"
    ) {
      this.interactionManager.triggerSoloAnimation(entityIndex, anim);
    } else {
      // Default: simple hop via state
      if (state) {
        state.hopStartTime = performance.now();
        state.hopDuration = 350;
        state.hopHeight = 0.15;
        // Fade out shadow during hop
        if (state.blobShadow) state.blobShadow.setJumping(true);
      }
    }
  }

  /**
   * Summon a robot by name - navigates to player and looks at them
   * @param {string} robotName - Character name (Modem, Blit, Baud)
   * @returns {boolean} True if robot was summoned
   */
  summonRobotByName(robotName) {
    const result = this.characterManager?.getByName(robotName);
    if (!result) {
      this.logger.warn(`Cannot summon robot - not found: ${robotName}`);
      return false;
    }

    const { entityIndex } = result;
    return this.playerInteractionManager?.summonRobot(entityIndex) ?? false;
  }

  rebuildNavMesh() {
    const success = this.navMeshManager.rebuild();
    if (success) {
      this.navMesh = this.navMeshManager.getNavMesh();
      this.navMeshInitialized = this.navMeshManager.isInitialized();
      this.lastNavMeshRebuildTime = this.navMeshManager.lastNavMeshRebuildTime;

      // Mark room setup as complete when navmesh is ready
      // BUT: Don't override if roomSetupRequired was forced true by debug state
      const currentState = gameState.getState();
      if (
        this.navMeshInitialized &&
        currentState.roomSetupRequired !== false &&
        currentState.roomSetupRequired !== true // Don't override forced true
      ) {
        this.logger.log("NavMesh rebuilt - room setup complete");
        gameState.setState({ roomSetupRequired: false });
      }
    }
  }

  createAgentVisualization(robotEntity, agentId) {
    const state = this.robotState.get(robotEntity.index);
    if (state?.agentHelper) {
      this.world.scene.remove(state.agentHelper);
      state.agentHelper.geometry.dispose();
      state.agentHelper.material.dispose();
    }

    const geometry = new SphereGeometry(0.1, 16, 16);
    const material = new MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.7,
      depthTest: true,
      depthWrite: false,
    });
    const agentHelper = new Mesh(geometry, material);
    agentHelper.renderOrder = 1000;
    this.world.scene.add(agentHelper);

    if (state) {
      state.agentHelper = agentHelper;
    }
    this.logger.log(
      "Agent visualization added to scene for robot",
      robotEntity.index
    );
  }

  /**
   * Handle A button press for room capture UI (delegated to RoomSetupManager)
   */
  handleRoomCaptureButton(button) {
    return this.roomSetupManager.handleButtonPress(button);
  }

  initializeNavMesh() {
    if (this.navMeshInitialized) {
      return;
    }

    const navSurfacesSystem = this.world.navSurfacesSystem;
    if (!navSurfacesSystem) {
      this.logger.warn("NavSurfacesSystem not available");
      return;
    }

    const firstSurface = navSurfacesSystem.getFirstSurface();
    if (!firstSurface) {
      this.logger.log("No surfaces available yet, waiting...");
      return;
    }

    this.spawnPosition = firstSurface.center;

    this.logger.log(
      "Rebuilding navmesh with",
      navSurfacesSystem.getAllSurfaces().length,
      "surfaces"
    );
    this.rebuildNavMesh();
    if (!this.navMesh) {
      this.logger.warn("Navmesh generation failed");
      return;
    }

    if (!this.agents) {
      this.agents = crowd.create(this.maxRobots);
      this.logger.log("Crowd created with maxAgents:", this.maxRobots);
    }

    this.navMeshInitialized = true;
    this.logger.log("NavMesh initialization complete!");

    // Set roomSetupRequired=false when navmesh initializes
    // BUT: Don't override if it was forced true by debug state
    const currentState = gameState.getState();
    if (currentState.roomSetupRequired !== true) {
      gameState.setState({ roomSetupRequired: false });
      this.logger.log(
        "Room setup confirmed complete (roomSetupRequired: false)"
      );
    } else {
      this.logger.log("Room setup kept as required (debug forced state)");
    }
  }

  spawnRobot(robotEntity) {
    if (!this.navMesh || !this.agents) {
      this.logger.warn("Cannot spawn robot: navmesh not ready");
      return false;
    }

    if (this.robotEntities.has(robotEntity.index)) {
      return false;
    }

    const robotObject = robotEntity.object3D;
    if (!robotObject) {
      this.logger.warn("Robot entity has no object3D");
      return false;
    }

    // Use robot's existing position if it has one (from portal spawn), otherwise use spawnPosition
    let spawnX, spawnY, spawnZ;
    const hasExistingPosition = robotObject.position.lengthSq() > 0.01;

    if (hasExistingPosition) {
      // Robot already has a position (from RobotSpawnerSystem portal animation)
      spawnX = robotObject.position.x;
      spawnY = robotObject.position.y;
      spawnZ = robotObject.position.z;
      this.logger.log(
        `Using robot's existing position: ${spawnX.toFixed(
          2
        )}, ${spawnY.toFixed(2)}, ${spawnZ.toFixed(2)}`
      );
    } else if (this.spawnPosition) {
      // Fallback to navmesh spawn position
      const offsetX = (Math.random() - 0.5) * 0.3;
      const offsetZ = (Math.random() - 0.5) * 0.3;
      spawnX = this.spawnPosition[0] + offsetX;
      spawnY = this.spawnPosition[1] + 0.1;
      spawnZ = this.spawnPosition[2] + offsetZ;
      robotObject.position.set(spawnX, spawnY, spawnZ);
    } else {
      this.logger.warn("Cannot spawn robot: no spawn position available");
      return false;
    }

    robotObject.scale.set(0.4, 0.4, 0.4);
    robotObject.visible = true;

    // Try to find nearest valid navmesh position for the spawn point
    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.navMesh,
      [spawnX, spawnY, spawnZ],
      [2, 2, 2], // Large search extents to find any nearby poly
      DEFAULT_QUERY_FILTER
    );

    // Use navmesh position if found, otherwise use original position
    let agentSpawnPos = [spawnX, spawnY, spawnZ];
    let needsSpawnTransition = false;
    const visualStartPos = [spawnX, spawnY, spawnZ]; // Where the robot visual currently is

    if (nearestResult.success) {
      agentSpawnPos = nearestResult.position;

      // Check if there's a significant difference requiring a smooth transition
      // Lower thresholds to catch more cases and prevent snapping
      const heightDiff = Math.abs(agentSpawnPos[1] - spawnY);
      const horizDiff = Math.sqrt(
        Math.pow(agentSpawnPos[0] - spawnX, 2) +
          Math.pow(agentSpawnPos[2] - spawnZ, 2)
      );

      if (heightDiff > 0.02 || horizDiff > 0.05) {
        // Don't snap immediately - we'll animate to it
        needsSpawnTransition = true;
        this.logger.log(
          `Spawn transition needed: visual at (${spawnX.toFixed(
            2
          )}, ${spawnY.toFixed(2)}, ${spawnZ.toFixed(2)}) ` +
            `-> navmesh at (${agentSpawnPos[0].toFixed(
              2
            )}, ${agentSpawnPos[1].toFixed(2)}, ${agentSpawnPos[2].toFixed(2)})`
        );
      } else {
        // Small difference, snap immediately
        robotObject.position.set(
          agentSpawnPos[0],
          agentSpawnPos[1],
          agentSpawnPos[2]
        );
        this.logger.log(
          `Snapped spawn to navmesh (small diff): ${agentSpawnPos[0].toFixed(
            2
          )}, ${agentSpawnPos[1].toFixed(2)}, ${agentSpawnPos[2].toFixed(2)}`
        );
      }
    } else {
      this.logger.warn(
        `Could not find navmesh poly near spawn position, agent may not move correctly`
      );
    }

    // Get character physics for this robot
    const characterId = robotObject.userData?.characterId || "";
    const character = getCharacterById(characterId);
    const physics = character?.physics || {};

    const agentParams = {
      radius: physics.agentRadius ?? 0.1,
      height: 0.4,
      maxAcceleration: physics.maxAcceleration ?? 10.0,
      maxSpeed: physics.maxSpeed ?? 1.4,
      collisionQueryRange: 1.5,
      separationWeight: 0.0,
      updateFlags:
        crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
        crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
        crowd.CrowdUpdateFlags.OPTIMIZE_VIS |
        crowd.CrowdUpdateFlags.OPTIMIZE_TOPO,
      queryFilter: DEFAULT_QUERY_FILTER,
      obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
      autoTraverseOffMeshConnections: false,
    };

    const agentId = crowd.addAgent(
      this.agents,
      this.navMesh,
      agentSpawnPos,
      agentParams
    );

    // Note: navcat crowd returns agent IDs as strings
    const agentCount = this.agents?.agents
      ? Object.keys(this.agents.agents).length
      : 0;
    this.logger.log(
      `Agent added with ID: "${agentId}" (type: ${typeof agentId}), agents count: ${agentCount}`
    );

    if (agentId === null || agentId === undefined) {
      this.logger.error(`Failed to add agent to crowd! agentId=${agentId}`);
      return false;
    }

    // Use pre-created face manager if available (from spawner), otherwise create new
    let faceManager = this.getEarlyFaceManager(robotObject);
    if (!faceManager) {
      faceManager = new RobotFaceManager(robotObject);
      const randomEmotion =
        EMOTION_GROUPS.POSITIVE[
          Math.floor(Math.random() * EMOTION_GROUPS.POSITIVE.length)
        ];
      faceManager.setEmotion(randomEmotion);
    }
    // Remove from early managers map (now owned by robotState)
    this._earlyFaceManagers?.delete(robotObject.uuid);

    // Create tie animation manager for this robot
    const tieManager = new RobotTieManager(robotObject);

    // Create arm animation manager for procedural arm movements
    const armManager = new RobotArmManager(robotObject);

    // Use pre-created thrust VFX if available (from spawner), otherwise create new
    const spawnOptions = robotEntity._spawnOptions || {};
    let thrustVFX = spawnOptions.thrustVFX;
    if (!thrustVFX) {
      thrustVFX = this.createThrustVFXForRobot(robotObject);
    }

    // Create blob shadow for this robot
    let blobShadow = null;
    if (this.world.vfxManager) {
      blobShadow = this.world.vfxManager.createBlobShadow({
        target: robotObject,
        size: character?.appearance?.shadowSize,
      });
    }

    // Consolidated robot state - single object with all per-robot data
    const state = {
      entity: robotEntity,
      agentId,
      agentHelper: null,
      lastTargetTime: performance.now(),
      spawnPosition: [...agentSpawnPos],
      faceManager,
      tieManager,
      armManager,
      thrustVFX,
      blobShadow,
      character: null,
      nameTag: null,
      faceFlashState: null,
      faceLookState: null,
      // Spawn transition state for smooth arc from portal to navmesh
      spawnTransition: needsSpawnTransition
        ? {
            active: true,
            startTime: performance.now(),
            duration: 1.2, // seconds for the arc
            startPosition: [...visualStartPos],
            targetPosition: [...agentSpawnPos],
            progress: 0,
          }
        : null,
    };
    this.robotState.set(robotEntity.index, state);

    // Initialize state machine - use gathered mode (stationary) or wandering
    if (this.gatheredMode) {
      this.stateMachine.forceState(robotEntity.index, ROBOT_STATE.STATIONARY);
      this.isStationary = true;
      this.lookAtPlayer = true;
    } else {
      this.stateMachine.forceState(robotEntity.index, ROBOT_STATE.WANDERING);
      this.isStationary = false;
      this.lookAtPlayer = false;
    }

    // Core Maps for external manager access
    this.robotEntities.set(robotEntity.index, robotEntity);
    this.robotAgentIds.set(robotEntity.index, agentId);

    // Configure robot mesh for proper occlusion by XRMesh geometry
    // XRMesh has renderOrder -1000 and writes to depth, robots render after
    robotObject.traverse((child) => {
      if (child.isMesh && child.material) {
        child.renderOrder = 10; // Higher than XRMesh occluder (-1000)
        child.material.depthTest = true; // Test against depth buffer (will be occluded)
        child.material.depthWrite = true;
        child.material.needsUpdate = true;
      }
    });

    // Apply environment map for reflections (loads once, applies to all robots)
    this.applyEnvMapToRobot(robotObject);

    if (this.showDebugVisuals) {
      this.createAgentVisualization(robotEntity, agentId);
    }
    this.setInitialWanderTarget(robotEntity, agentId);

    // Verify agent state after setup
    const agent = this.agents.agents[agentId];
    if (agent) {
      this.logger.log(
        `Agent ${agentId} state after setup: pos=(${agent.position[0].toFixed(
          2
        )}, ${agent.position[1].toFixed(2)}, ${agent.position[2].toFixed(
          2
        )}), target=${
          agent.targetPosition
            ? `(${agent.targetPosition[0]?.toFixed(
                2
              )}, ${agent.targetPosition[1]?.toFixed(
                2
              )}, ${agent.targetPosition[2]?.toFixed(2)})`
            : "none"
        }, state=${agent.state}`
      );
    }

    return true;
  }

  cloneRobotEntity(originalEntity) {
    const originalObject = originalEntity.object3D;
    if (!originalObject) {
      this.logger.warn("Cannot clone: original entity has no object3D");
      return null;
    }

    const clonedObject = originalObject.clone(true);
    clonedObject.traverse((child) => {
      if (child.isMesh) {
        child.geometry = child.geometry.clone();
        if (child.material) {
          child.material = child.material.clone();
        }
      }
      if (child.userData && child.userData.audio) {
        delete child.userData.audio;
      }
      if (child.type === "Audio" || child.isAudio) {
        child.disconnect();
        child.stop();
      }
    });
    clonedObject.visible = false;

    const clonedEntity = this.world.createTransformEntity(clonedObject);
    clonedEntity.addComponent(Robot);

    return clonedEntity;
  }

  /**
   * Apply environment map to a robot for reflections
   * Can be called externally (e.g., from spawner during rise animation)
   */
  async applyEnvMapToRobot(robotObject) {
    // Load env map once (uses fallback in emulator, camera capture on device)
    if (!this._envMapLoaded) {
      await this.envMapLoader.loadEnvMap();
      this._envMapLoaded = true;
    }

    // Apply to robot with reflective settings (values from shadow project)
    this.envMapLoader.applyToMesh(robotObject, {
      intensity: 1.0,
    });
  }

  /**
   * Apply face texture to a robot immediately (before navmesh is ready)
   * Can be called externally (e.g., from spawner during rise animation)
   * @returns {RobotFaceManager} The created face manager
   */
  applyFaceToRobot(robotObject) {
    // Check if we already have a face manager for this object
    if (!this._earlyFaceManagers) {
      this._earlyFaceManagers = new Map();
    }

    // Use object uuid as key since we don't have entity index yet
    const key = robotObject.uuid;
    if (this._earlyFaceManagers.has(key)) {
      return this._earlyFaceManagers.get(key);
    }

    // Create face manager immediately - this renders the initial face
    const faceManager = new RobotFaceManager(robotObject);
    const randomEmotion =
      EMOTION_GROUPS.POSITIVE[
        Math.floor(Math.random() * EMOTION_GROUPS.POSITIVE.length)
      ];
    faceManager.setEmotion(randomEmotion);

    // Store for later retrieval in spawnRobot
    this._earlyFaceManagers.set(key, faceManager);

    return faceManager;
  }

  /**
   * Get pre-created face manager for a robot object (if any)
   * @returns {RobotFaceManager|null}
   */
  getEarlyFaceManager(robotObject) {
    return this._earlyFaceManagers?.get(robotObject.uuid) || null;
  }

  /**
   * Create and attach thrust VFX to a robot
   * Can be called externally (e.g., from spawner during rise animation)
   * @returns {RobotEngineThrustVFX} The created thrust VFX instance
   */
  createThrustVFXForRobot(robotObject) {
    // Get character config to access appearance settings
    const characterId = robotObject.userData?.characterId || "";
    const character = getCharacterById(characterId);
    const thrusterSize = character?.appearance?.thrusterSize ?? 1.0;
    const thrusterYOffset = character?.appearance?.thrusterYOffset ?? 0;
    const thrusterMaxScale = character?.appearance?.thrusterMaxScale ?? 1.0;
    const characterColor = character?.appearance?.primaryColor;

    // Apply size multiplier to all radius parameters, ring thickness, AND emit distances
    const baseSize = 0.03; // Base size reference
    const baseThickness = 0.006; // Base ring thickness
    const baseMinDistance = 0.05; // Base minimum emit distance
    const baseMaxDistance = 0.07; // Base maximum emit distance
    const thrustVFX = new RobotEngineThrustVFX({
      primaryColor: 0x00ffff,
      secondaryColor: 0x0088ff,
      characterColor, // Robot's theme color for every 3rd ring
      ringCount: 4,
      minBaseRadius: baseSize * thrusterSize,
      maxBaseRadius: baseSize * 2 * thrusterSize,
      minMaxRadius: baseSize * 1.33 * thrusterSize,
      maxMaxRadius: baseSize * 2.33 * thrusterSize,
      ringThickness: baseThickness * thrusterSize,
      minEmitDistance: baseMinDistance * thrusterSize,
      maxEmitDistance: baseMaxDistance * thrusterSize,
    });

    // Attach with robot's body scale, Y offset, and max scale
    thrustVFX.attachTo(robotObject, 0.3, thrusterYOffset, thrusterMaxScale);

    // Scale animation speed proportionally so smaller thrusters don't appear faster
    thrustVFX.animationSpeedScale = thrusterSize;

    // Set initial intensity so thrusters are visible from spawn
    thrustVFX.setIntensity(0, 1.4, false, 0, false);
    thrustVFX.intensity = 0.35; // Set immediately to idle intensity (no smoothing delay)

    return thrustVFX;
  }

  setInitialWanderTarget(robotEntity, agentId) {
    this.navigationManager.setInitialWanderTarget(robotEntity, agentId);
  }

  selectRandomTableTarget(robotEntity, agentId) {
    this.navigationManager.selectRandomTableTarget(robotEntity, agentId);
  }

  setRobotNavigationTarget(entityIndex, x, y, z) {
    this.navigationManager.setRobotNavigationTarget(entityIndex, x, y, z);
  }

  stopRobotMovement(entityIndex) {
    this.navigationManager.stopRobotMovement(entityIndex);
  }

  _fastSin(angle) {
    const normalized = ((angle % this._twoPi) + this._twoPi) % this._twoPi;
    const idx = Math.floor((normalized / this._twoPi) * 256) & 255;
    return this._sinTable[idx];
  }

  _fastCos(angle) {
    const normalized =
      (((angle + Math.PI / 2) % this._twoPi) + this._twoPi) % this._twoPi;
    const idx = Math.floor((normalized / this._twoPi) * 256) & 255;
    return this._sinTable[idx];
  }

  _setupGameStateListener() {
    // Check initial state to handle debug spawns that start with wandering
    const initialState = gameState.getState();
    if (initialState?.robotBehavior === "wandering") {
      this.logger.log("Initial state: wandering mode - starting with movement");
      this.gatheredMode = false;
      this.useWandering = true;
      this.isStationary = false;
      this.lookAtPlayer = false;
    }

    gameState.on("state:changed", (newState, oldState) => {
      // When robots should gather (e.g., after spawning or on command)
      if (
        newState.robotBehavior === "gathered" &&
        oldState.robotBehavior !== "gathered"
      ) {
        this.logger.log(
          "Game state: gathered mode - robots stationary looking at player"
        );
        this.gatheredMode = true;
        this.setStationary(true, true);
      }

      // When robots should start wandering
      if (
        newState.robotBehavior === "wandering" &&
        oldState.robotBehavior !== "wandering"
      ) {
        this.logger.log("=== WANDERING MODE TRIGGERED ===");
        this.logger.log(
          `Before clear: gatheredMode=${this.gatheredMode}, useWandering=${this.useWandering}, isStationary=${this.isStationary}, lookAtPlayer=${this.lookAtPlayer}`
        );
        this.logger.log(
          `Before clear: _awaitingInterpretation=${this._awaitingInterpretation}, _greetingReturnPending=${this._greetingReturnPending}, _robotsLookAtEachOther=${this._robotsLookAtEachOther}`
        );
        // Clear ALL blocking flags and states
        this.gatheredMode = false;
        this.useWandering = true;
        this.isStationary = false;
        this.lookAtPlayer = false;
        this._awaitingInterpretation = false;
        this._greetingReturnPending = false;
        this._robotsLookAtEachOther = false;
        this._postGreetingAction = null;

        // CRITICAL: Clear the global goal so robots don't all go to the same place!
        this.navigationManager.clearGoal();
        this.logger.log(
          "Goal cleared - robots will wander to individual targets"
        );

        // Debug: log robot states for next few seconds
        this._wanderingDebugUntil = performance.now() + 5000;

        // Log robot states before setStationary
        for (const [entityIndex] of this.robotAgentIds.entries()) {
          const currentState = this.stateMachine.getState(entityIndex);
          this.logger.log(
            `Robot ${entityIndex} state before setStationary: ${currentState}`
          );
        }

        this.setStationary(false);
      }

      // When friendly greeting received, set goal to portal position
      if (
        newState.robotBehavior === "moving_to_goal" &&
        oldState.robotBehavior !== "moving_to_goal"
      ) {
        const portalPos = newState.portalSpawnPosition;
        if (portalPos) {
          this.logger.log("Game state: friendly greeting - moving to portal");
          this.setGoalFromPosition(portalPos);

          // Set callback for when all robots reach goal
          this.onGoalReached(() => {
            this.logger.log("All robots at goal - switching to stationary");
            this.setStationary(true, true); // Stationary, looking at player
            gameState.setState({
              robotsMovingToGoal: false,
              robotsAtGoal: true,
              robotBehavior: "stationary",
            });
          });
        }
      }

      // When panic minigame should start
      if (
        newState.robotBehavior === "panicking" &&
        oldState.robotBehavior !== "panicking"
      ) {
        this.logger.log("Game state: panicking mode - starting panic minigame");
        const wristUI = this.world.aiManager?.wristUI;
        this.startPanicMinigame(wristUI);
      }
    });
  }

  setGoal(goalPosition) {
    this.navigationManager.setGoal(goalPosition);
    // Sync to local for backward compat
    this.goalPosition = this.navigationManager.goalPosition;
    this.goalAccessible = this.navigationManager.goalAccessible;
    this.robotsAtGoal = this.navigationManager.robotsAtGoal;
  }

  clearGoal() {
    this.navigationManager.clearGoal();
    this.goalPosition = null;
    this.goalAccessible = false;
    this.robotsAtGoal = null;
  }

  onGoalReached(callback) {
    this.navigationManager.onGoalReached(callback);
  }

  /**
   * Set gathered mode - robots stay at spawn position looking at player.
   * Can be triggered multiple times to re-gather robots.
   */
  setGatheredMode(enabled) {
    this.gatheredMode = enabled;

    if (enabled) {
      // Return all robots to spawn and look at player
      this.navigationManager.returnAllToSpawn();
      this._greetingReturnPending = true;
      this._greetingReturnStartTime = performance.now();
      this.logger.log("Gathered mode enabled - robots returning to spawn");
    } else {
      // Resume wandering
      this.setStationary(false);
      this.logger.log("Gathered mode disabled - robots resuming movement");
    }
  }

  setStationary(stationary, lookAtPlayer = false) {
    this.isStationary = stationary;
    this.lookAtPlayer = lookAtPlayer;

    if (stationary) {
      // Stop all agents and set state machine to STATIONARY
      for (const [entityIndex, agentId] of this.robotAgentIds.entries()) {
        // Skip panicking robots - they have their own behavior
        // (4th and 5th panic robots can navigate, so don't skip those)
        const currentState = this.stateMachine.getState(entityIndex);
        const pimState = this.pim?.getState(entityIndex);
        if (
          currentState === ROBOT_STATE.PANICKING &&
          (!pimState || pimState.panicNumber < 4)
        ) {
          continue;
        }

        // Update state machine
        this.stateMachine.setState(entityIndex, ROBOT_STATE.STATIONARY);

        const agent = this.agents.agents[agentId];
        if (agent) {
          // Set target to current position to stop movement
          const currentPos = agent.position;
          const nearestResult = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            currentPos,
            [1, 1, 1],
            DEFAULT_QUERY_FILTER
          );
          if (nearestResult.success) {
            crowd.requestMoveTarget(
              this.agents,
              agentId,
              nearestResult.nodeRef,
              currentPos
            );
          }
        }
      }
      this.logger.log(
        `Robots now stationary${lookAtPlayer ? " (looking at player)" : ""}`
      );
    } else {
      // Resume wandering - force state and stagger wander targets to avoid clustering
      this.logger.log("=== setStationary(false) - RESUMING WANDERING ===");
      let targetDelay = 0;
      for (const [entityIndex, agentId] of this.robotAgentIds.entries()) {
        // Skip panicking robots - they have their own behavior
        // (4th and 5th panic robots can navigate, so don't skip those)
        const currentState = this.stateMachine.getState(entityIndex);
        const pimState = this.pim?.getState(entityIndex);
        if (
          currentState === ROBOT_STATE.PANICKING &&
          (!pimState || pimState.panicNumber < 4)
        ) {
          this.logger.log(`Robot ${entityIndex}: skipping (PANICKING)`);
          continue;
        }
        // Use forceState to ensure transition regardless of current state
        this.logger.log(
          `Robot ${entityIndex}: ${currentState} -> WANDERING (forceState)`
        );
        this.stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);

        // Stagger wander target selection to spread robots apart
        const robotEntity = this.robotEntities.get(entityIndex);
        if (robotEntity && agentId !== undefined) {
          const delay = targetDelay;
          this.logger.log(
            `Robot ${entityIndex}: scheduling wander target in ${delay}ms`
          );
          setTimeout(() => {
            this.logger.log(
              `Robot ${entityIndex}: selectRandomWanderTarget NOW`
            );
            this.navigationManager?.selectRandomWanderTarget(
              robotEntity,
              agentId
            );
          }, delay);
          targetDelay += 200 + Math.random() * 300; // 200-500ms stagger per robot
        } else {
          this.logger.log(
            `Robot ${entityIndex}: no entity or agentId, skipping wander target`
          );
        }
      }
      this.logger.log("Robots resuming movement (forced WANDERING state)");
    }
  }

  /**
   * Called when transcription is received (before interpretation).
   * Robots gather at spawn, enter inquisitive state looking at each other.
   */
  onTranscription() {
    // Don't interrupt panic minigame
    if (this.playerInteractionManager?.minigameActive) {
      this.logger.log("Transcription ignored - panic minigame active");
      return;
    }

    this.logger.log(
      "Transcription received - robots gathering in inquisitive state"
    );

    // Clear any active scanning
    this.scanManager.stopAll();

    // Cancel any active robot-to-robot interactions
    this.interactionManager.cancelAllInteractions();

    // Clear any existing global goal to prevent robots from being redirected
    this.navigationManager.goalPosition = null;
    this.navigationManager.goalAccessible = false;
    this.navigationManager.goalNodeRef = null;

    // Enter gathered mode to prevent new interactions AND disable wandering
    this.gatheredMode = true;
    this.useWandering = false;

    // Set inquisitive state - curious emotions, looking between each other
    this._awaitingInterpretation = true;
    this._gatheringStartTime = performance.now();

    // Send all robots to spawn positions and set state to MOVING_TO_GOAL
    this.navigationManager.returnAllToSpawn();
    for (const [entityIndex] of this.robotAgentIds.entries()) {
      this.stateMachine.forceState(entityIndex, ROBOT_STATE.MOVING_TO_GOAL);
    }

    // Stagger inquisitive sounds - each robot plays one every 1-2 seconds
    let soundDelay = 0;
    for (const [entityIndex] of this.robotAgentIds.entries()) {
      const voice = this.audioManager.getVoice(entityIndex);
      if (voice) {
        const delay = soundDelay;
        setTimeout(() => {
          voice.inquisitive();
          const emotions = [RobotEmotion.CURIOUS, RobotEmotion.THINKING];
          const emotion = emotions[Math.floor(Math.random() * emotions.length)];
          this.setRobotFaceEmotion(entityIndex, emotion);
        }, delay);
        soundDelay += 1000 + Math.random() * 1000; // 1-2 seconds between each
      }
    }

    // Enable inter-robot look behavior (they look at each other while waiting)
    this._robotsLookAtEachOther = true;
  }

  /**
   * Called when interpretation response is received.
   * Handles robot reactions based on intent (friendly, unfriendly, etc.)
   */
  onInterpretResponse(result) {
    // Don't process responses during panic minigame
    if (this.playerInteractionManager?.minigameActive) {
      this.logger.log("Interpret response ignored - panic minigame active");
      return;
    }

    const isGreeting =
      result.is_greeting || result.robot_directive?.stop_navigation;
    const sentiment = result.sentiment || {};
    const isRude = sentiment.is_rude || false;
    const isFriendly = isGreeting && !isRude;

    this._awaitingInterpretation = false;
    this._robotsLookAtEachOther = false;

    if (isFriendly) {
      this._handleFriendlyGreeting();
    } else if (
      isRude ||
      sentiment.sentiment === "hostile" ||
      sentiment.sentiment === "unfriendly"
    ) {
      this._handleUnfriendlyResponse(sentiment);
    } else {
      this._handleNeutralResponse();
    }
  }

  /**
   * Handle friendly greeting - happy jumps, look at user, then resume
   */
  _handleFriendlyGreeting() {
    this.logger.log("Friendly greeting - happy response!");

    // Stop robots immediately where they are - don't wait for them to reach spawn
    this._greetingReturnPending = false;
    this._postGreetingAction = null;
    this.setStationary(true, true); // Stop + look at player

    // Immediately show happy emotions and sounds
    for (const [entityIndex] of this.robotAgentIds.entries()) {
      const voice = this.audioManager.getVoice(entityIndex);
      if (voice) {
        setTimeout(() => {
          voice.happy();
          this.setRobotFaceEmotion(entityIndex, RobotEmotion.EXCITED);
        }, Math.random() * 200);
      }

      // Trigger happy jump animation
      setTimeout(() => {
        this.interactionManager?.triggerSoloAnimation(
          entityIndex,
          "happyBounce"
        );
      }, 300 + Math.random() * 400);
    }

    // Resume normal behavior after reaction completes
    setTimeout(() => {
      this._resumeNormalBehavior();
    }, 4000);
  }

  /**
   * Handle unfriendly/rude response - sad or angry faces
   */
  _handleUnfriendlyResponse(sentiment) {
    this.logger.log("Unfriendly response - negative reaction");

    // Stop robots immediately - don't wait for them to reach spawn
    this._greetingReturnPending = false;
    this._postGreetingAction = null;
    this.setStationary(true, true);

    const isHostile = sentiment.sentiment === "hostile";

    for (const [entityIndex] of this.robotAgentIds.entries()) {
      const voice = this.audioManager.getVoice(entityIndex);
      if (voice) {
        setTimeout(() => {
          if (isHostile) {
            voice.angry();
            this.setRobotFaceEmotion(entityIndex, RobotEmotion.ANGRY);
          } else {
            voice.sad();
            this.setRobotFaceEmotion(entityIndex, RobotEmotion.SAD);
          }
        }, Math.random() * 300);
      }
    }

    // Resume after brief reaction
    setTimeout(() => {
      this._resumeNormalBehavior();
    }, 2000);
  }

  /**
   * Handle neutral/non-greeting response - inquisitive, then resume
   */
  _handleNeutralResponse() {
    this.logger.log("Non-greeting response - inquisitive, then resume");

    // Stop robots immediately - don't wait for them to reach spawn
    this._greetingReturnPending = false;
    this._postGreetingAction = null;
    this.setStationary(true, true);

    for (const [entityIndex] of this.robotAgentIds.entries()) {
      const voice = this.audioManager.getVoice(entityIndex);
      if (voice) {
        setTimeout(() => {
          voice.inquisitive();
          this.setRobotFaceEmotion(entityIndex, RobotEmotion.CURIOUS);
        }, Math.random() * 300);
      }
    }

    // Resume after brief reaction
    setTimeout(() => {
      this._resumeNormalBehavior();
    }, 2000);
  }

  /**
   * Legacy method - now calls onInterpretResponse with greeting result
   */
  onGreeting() {
    this.onInterpretResponse({
      is_greeting: true,
      sentiment: { sentiment: "friendly", is_rude: false },
    });
  }

  _checkGreetingReturn() {
    if (!this._greetingReturnPending) return;

    const elapsed = performance.now() - this._greetingReturnStartTime;
    const allAtSpawn = this.navigationManager.checkAllAtSpawn();

    if (allAtSpawn || elapsed > 8000) {
      this._greetingReturnPending = false;

      const action = this._postGreetingAction || "happy";

      if (action === "happy") {
        // Stay stationary, look at player for friendly greeting
        this.setStationary(true, true);
        this.logger.log("Robots at spawn - happy response, looking at player");

        // Play content sounds, then resume after delay
        const calmEmotions = EMOTION_GROUPS.CALM;
        for (const [entityIndex] of this.robotAgentIds.entries()) {
          const voice = this.audioManager.getVoice(entityIndex);
          if (voice) {
            setTimeout(() => {
              voice.content();
              const emotion =
                calmEmotions[Math.floor(Math.random() * calmEmotions.length)];
              this.setRobotFaceEmotion(entityIndex, emotion);
            }, 200 + Math.random() * 800);
          }
        }

        // Resume navigation after a few seconds
        setTimeout(() => {
          this._resumeNormalBehavior();
        }, 4000);
      } else {
        // Resume behavior immediately for non-friendly responses
        this._resumeNormalBehavior();
      }

      this._postGreetingAction = null;
    }
  }

  /**
   * Resume normal wandering behavior after greeting response
   */
  _resumeNormalBehavior() {
    // Don't resume normal behavior during panic minigame
    if (this.playerInteractionManager?.minigameActive) {
      return;
    }

    this.logger.log("Resuming normal navigation behavior");
    this.setStationary(false, false);

    // Exit gathered mode and re-enable wandering
    this.gatheredMode = false;
    this.useWandering = true;
    this._robotsLookAtEachOther = false;
    this._awaitingInterpretation = false;
    this._interRobotLookTargets?.clear();

    // Clear global goal so robots wander independently
    this.navigationManager.clearGoal();

    // Reset to content emotions and resume wandering
    for (const [entityIndex] of this.robotAgentIds.entries()) {
      // Skip panicking robots (4th and 5th panic can navigate, so don't skip those)
      const currentState = this.stateMachine.getState(entityIndex);
      const pimState = this.pim?.getState(entityIndex);
      if (
        currentState === ROBOT_STATE.PANICKING &&
        (!pimState || pimState.panicNumber < 4)
      ) {
        continue;
      }
      this.setRobotFaceEmotion(entityIndex, RobotEmotion.CONTENT);
      this.stateMachine.forceState(entityIndex, ROBOT_STATE.WANDERING);
    }
  }

  /**
   * Get a random other robot's position for inter-robot looking during inquisitive state.
   * Robots periodically switch who they're looking at for natural conversation feel.
   */
  _getInterRobotLookTarget(entityIndex, agent) {
    // Initialize look target tracking if needed
    if (!this._interRobotLookTargets) {
      this._interRobotLookTargets = new Map();
    }

    const now = performance.now();
    let targetData = this._interRobotLookTargets.get(entityIndex);

    // Switch targets every 1-3 seconds for natural glancing behavior
    const switchInterval = 1000 + Math.random() * 2000;
    if (!targetData || now - targetData.lastSwitch > switchInterval) {
      // Pick a random other robot
      const otherRobots = [];
      for (const [otherIndex] of this.robotEntities.entries()) {
        if (otherIndex !== entityIndex) {
          otherRobots.push(otherIndex);
        }
      }

      if (otherRobots.length === 0) return null;

      const targetIndex =
        otherRobots[Math.floor(Math.random() * otherRobots.length)];
      targetData = { targetIndex, lastSwitch: now };
      this._interRobotLookTargets.set(entityIndex, targetData);
    }

    // Get target robot's position
    const targetAgentId = this.robotAgentIds.get(targetData.targetIndex);
    if (targetAgentId === null || targetAgentId === undefined) return null;

    const targetAgent = this.agents.agents[targetAgentId];
    if (!targetAgent) return null;

    // Return position as Vector3-like object
    return {
      x: targetAgent.position[0],
      y: targetAgent.position[1] + 0.25, // Look at head height
      z: targetAgent.position[2],
    };
  }

  /**
   * Get the nearest panicking robot to look at (for non-panicking robots)
   * Returns position if within range, null otherwise
   */
  _getPanicLookTarget(entityIndex, agent, currentFacing) {
    // Don't look at panic if this robot is panicking
    const state = this.playerInteractionManager?.getState(entityIndex);
    if (state?.isPanicking) return null;

    // Initialize panic look state tracking
    if (!this._panicLookStates) {
      this._panicLookStates = new Map();
    }

    const now = performance.now();
    let lookState = this._panicLookStates.get(entityIndex);

    // Find nearest panicking robot
    let nearestPanic = null;
    let nearestDistSq = Infinity;
    const maxLookDist = 5.0; // Max distance to look at panicking robot (5m)
    const maxLookDistSq = maxLookDist * maxLookDist;

    for (const [otherIndex, otherEntity] of this.robotEntities.entries()) {
      if (otherIndex === entityIndex) continue;

      const otherState = this.playerInteractionManager?.getState(otherIndex);
      if (!otherState?.isPanicking) continue;

      const otherAgentId = this.robotAgentIds.get(otherIndex);
      if (otherAgentId === null || otherAgentId === undefined) continue;

      const otherAgent = this.agents.agents[otherAgentId];
      if (!otherAgent) continue;

      const dx = otherAgent.position[0] - agent.position[0];
      const dz = otherAgent.position[2] - agent.position[2];
      const distSq = dx * dx + dz * dz;

      if (distSq < nearestDistSq && distSq < maxLookDistSq) {
        nearestDistSq = distSq;
        nearestPanic = {
          entityIndex: otherIndex,
          position: {
            x: otherAgent.position[0],
            y: otherAgent.position[1] + 0.25, // Head height
            z: otherAgent.position[2],
          },
          distSq,
        };
      }
    }

    if (!nearestPanic) {
      // No panicking robot nearby - clear look state
      if (lookState) {
        lookState.lastLookTime = 0;
        lookState.lookDuration = 0;
      }
      return null;
    }

    // Initialize or update look state
    if (!lookState) {
      lookState = {
        lastLookTime: 0,
        lookDuration: 0,
        lookInterval: 3000 + Math.random() * 3000, // Look every 3-6 seconds
        minLookDuration: 200 + Math.random() * 200, // Brief glance: 0.2-0.4 seconds
        maxLookDuration: 400 + Math.random() * 200, // Max 0.4-0.6 seconds
      };
      this._panicLookStates.set(entityIndex, lookState);
    }

    // Check if we should start/continue looking
    const timeSinceLastLook = now - lookState.lastLookTime;
    const shouldLook =
      lookState.lookDuration > 0 || timeSinceLastLook > lookState.lookInterval;

    if (shouldLook) {
      if (lookState.lookDuration === 0) {
        // Start new look
        lookState.lastLookTime = now;
        lookState.lookDuration =
          lookState.minLookDuration +
          Math.random() *
            (lookState.maxLookDuration - lookState.minLookDuration);
        lookState.lookInterval = 3000 + Math.random() * 3000; // Next look in 3-6s
      }

      // Continue looking if within duration
      if (now - lookState.lastLookTime < lookState.lookDuration) {
        return nearestPanic.position;
      } else {
        // Look duration expired - reset
        lookState.lookDuration = 0;
        return null;
      }
    }

    return null;
  }

  /**
   * Check if robot should avoid a panicking robot and adjust navigation
   */
  _checkPanicAvoidance(entityIndex, agent, agentId) {
    // Don't avoid if this robot is panicking
    const state = this.playerInteractionManager?.getState(entityIndex);
    if (state?.isPanicking) return false;

    // Find nearest panicking robot
    let nearestPanic = null;
    let nearestDistSq = Infinity;
    const avoidDist = 0.75; // Start avoiding within 0.75m
    const avoidDistSq = avoidDist * avoidDist;

    for (const [otherIndex] of this.robotEntities.entries()) {
      if (otherIndex === entityIndex) continue;

      const otherState = this.playerInteractionManager?.getState(otherIndex);
      if (!otherState?.isPanicking) continue;

      const otherAgentId = this.robotAgentIds.get(otherIndex);
      if (otherAgentId === null || otherAgentId === undefined) continue;

      const otherAgent = this.agents.agents[otherAgentId];
      if (!otherAgent) continue;

      const dx = otherAgent.position[0] - agent.position[0];
      const dz = otherAgent.position[2] - agent.position[2];
      const distSq = dx * dx + dz * dz;

      if (distSq < nearestDistSq && distSq < avoidDistSq) {
        nearestDistSq = distSq;
        nearestPanic = { otherAgent, distSq };
      }
    }

    if (!nearestPanic) return false;

    // Calculate avoidance direction (away from panicking robot)
    const dx = agent.position[0] - nearestPanic.otherAgent.position[0];
    const dz = agent.position[2] - nearestPanic.otherAgent.position[2];
    const dist = Math.sqrt(nearestPanic.distSq);

    if (dist < 0.1) return false; // Too close, can't avoid

    // Calculate avoidance target (move away from panic robot)
    const avoidStrength = 1.0 - nearestPanic.distSq / avoidDistSq; // 0 to 1

    // If already within avoidance zone, ensure we move far enough to exit it
    // Minimum distance to move: current distance + buffer to get beyond avoidance threshold
    const minExitDistance = dist + (avoidDist - dist) + 0.2; // Current dist + gap to exit + 0.2m buffer
    const maxAvoidDistance = 1.0 * avoidStrength; // Original calculation
    const avoidDistance = Math.max(minExitDistance, maxAvoidDistance); // Use whichever is larger

    const avoidDirX = (dx / dist) * avoidDistance;
    const avoidDirZ = (dz / dist) * avoidDistance;

    const avoidTarget = [
      agent.position[0] + avoidDirX,
      agent.position[1],
      agent.position[2] + avoidDirZ,
    ];

    // Find nearest navmesh point to avoidance target
    if (this.navMesh) {
      const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        this.navMesh,
        avoidTarget,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER
      );

      if (nearestResult.success) {
        // Request move to avoidance target
        crowd.requestMoveTarget(
          this.agents,
          agentId,
          nearestResult.nodeRef,
          nearestResult.position
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Check if robot should avoid the player position and adjust navigation.
   * Prevents robots from steering through the user's legs.
   */
  _checkPlayerAvoidance(entityIndex, agent, agentId) {
    const player = this.world?.player;
    if (!player?.head) return false;

    // Get player head position and project down to floor level
    player.head.getWorldPosition(this._tempVec3);
    const playerFloorX = this._tempVec3.x;
    const playerFloorZ = this._tempVec3.z;
    // Use robot's Y since they're on the same navmesh level
    const playerFloorY = agent.position[1];

    // Avoidance radius around player (0.15m)
    const avoidRadius = 0.15;
    const avoidRadiusSq = avoidRadius * avoidRadius;

    // Calculate distance from robot to player floor position
    const dx = agent.position[0] - playerFloorX;
    const dz = agent.position[2] - playerFloorZ;
    const distSq = dx * dx + dz * dz;

    // Not within avoidance radius
    if (distSq >= avoidRadiusSq) return false;

    const dist = Math.sqrt(distSq);
    if (dist < 0.01) return false; // Too close to calculate direction

    // Calculate avoidance direction (away from player)
    const avoidStrength = 1.0 - distSq / avoidRadiusSq;
    const minExitDistance = dist + (avoidRadius - dist) + 0.1;
    const maxAvoidDistance = 0.3 * avoidStrength;
    const avoidDistance = Math.max(minExitDistance, maxAvoidDistance);

    const avoidDirX = (dx / dist) * avoidDistance;
    const avoidDirZ = (dz / dist) * avoidDistance;

    const avoidTarget = [
      agent.position[0] + avoidDirX,
      playerFloorY,
      agent.position[2] + avoidDirZ,
    ];

    // Find nearest navmesh point to avoidance target
    if (this.navMesh) {
      const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        this.navMesh,
        avoidTarget,
        [0.5, 0.5, 0.5],
        DEFAULT_QUERY_FILTER
      );

      if (nearestResult.success) {
        crowd.requestMoveTarget(
          this.agents,
          agentId,
          nearestResult.nodeRef,
          nearestResult.position
        );
        return true;
      }
    }

    return false;
  }

  setGoalFromPosition(pos) {
    this.navigationManager.setGoalFromPosition(pos);
    this.goalPosition = this.navigationManager.goalPosition;
    this.goalAccessible = this.navigationManager.goalAccessible;
    this.robotsAtGoal = this.navigationManager.robotsAtGoal;
  }

  /**
   * Start the panic minigame - robots overheat and need to be calmed by patting
   * @param {Object} wristUI - SpatialUIManager instance for score display
   */
  startPanicMinigame(wristUI = null) {
    const pim = this.playerInteractionManager;
    if (!pim) {
      this.logger.warn("PlayerInteractionManager not available");
      return;
    }

    // Wire up UI callbacks if wristUI provided
    if (wristUI) {
      pim.onScoreUpdate = (current, total) => {
        wristUI.updateScoreDisplay(current, total);
        // Flash "CALMED" when a robot is calmed
        wristUI.scoreUI?.flashCalmed(() => pim.isAnyRobotPanicking());
      };
      pim.onMinigameComplete = () => {
        wristUI.hideScorePanel();
        this.logger.log("Panic minigame complete!");
        gameState.setState({ panicMinigameCompleted: true });
      };
      // Set callback for when panic starts (panic count is tracked in pim.minigamePanicCount)
      pim.onPanicStart = () => {
        wristUI.scoreUI?.setPanicking(() => pim.isAnyRobotPanicking());

        const panicCount = pim.minigamePanicCount;
        const dialogManager = this.world?.aiManager?.dialogManager;
        if (dialogManager) {
          if (panicCount === 1) {
            this.logger.log("Playing first panic dialog: panicWorkedUp");
            dialogManager.playDialog("panicWorkedUp");
          } else if (panicCount === 4) {
            this.logger.log("Playing fourth panic dialog: panicFourth");
            dialogManager.playDialog("panicFourth");
          }
        }
      };
      wristUI.showScorePanel();

      // Switch from world call panel to HUD call panel
      wristUI.switchToHUDCallPanel();
    }

    pim.startPanicMinigame();
    this.logger.log("Panic minigame started");
  }

  /**
   * End the panic minigame early
   */
  endPanicMinigame() {
    this.playerInteractionManager?.endPanicMinigame();
  }

  /**
   * Check if panic minigame is active
   */
  isPanicMinigameActive() {
    return this.playerInteractionManager?.minigameActive || false;
  }

  evaluateGoalAccessibility() {
    this.navigationManager.evaluateGoalAccessibility();
    this.goalAccessible = this.navigationManager.goalAccessible;
  }

  selectRandomWanderTarget(robotEntity, agentId) {
    this.navigationManager.selectRandomWanderTarget(robotEntity, agentId);
  }

  update() {
    const time = performance.now();
    const deltaTime = (time - this.prevTime) / 1000;
    const clampedDeltaTime = Math.min(deltaTime, 0.1);
    this.prevTime = time;

    // Increment frame counter for throttled updates
    this._frameCounter++;

    // Sync robot audio master volume with SFX setting
    const sfxVol = gameState.getState().sfxVolume ?? 1.0;
    setMasterVolume(sfxVol);

    // Update nametag fade-in animations
    this.characterManager.update(clampedDeltaTime);

    // Update room setup (handles room capture UI, NavMesh init)
    this.roomSetupManager.update();

    if (!this.navMeshInitialized || !this.agents || !this.navMesh) {
      return;
    }

    // Update audio listener position from camera
    if (this.world.camera) {
      this.audioManager.updateListenerPosition(
        this.world.camera,
        this._audioForward
      );
    }

    // Check if robots have returned to spawn after greeting
    this._checkGreetingReturn();

    // Process pending robots that were handed off from RobotSpawnerSystem
    // These already have positions from portal spawn, so don't require spawnPosition
    if (
      this.pendingRobotEntities.length > 0 &&
      this.robotEntities.size < this.maxRobots
    ) {
      const robotEntity = this.pendingRobotEntities.shift();
      if (robotEntity) {
        const success = this.spawnRobot(robotEntity);
        if (!success) {
          // Put it back at the front to retry next frame
          this.pendingRobotEntities.unshift(robotEntity);
        }
      }
    }

    // Auto-spawn additional robots if spawnPosition is set (from navmesh first surface)
    if (this.spawnPosition && this.originalRobotEntity) {
      this.spawnTimer += deltaTime * 1000;
      if (this.spawnTimer >= this.spawnInterval) {
        this.spawnTimer = 0;
        if (
          this.robotEntities.size < this.maxRobots &&
          this.pendingRobotEntities.length === 0
        ) {
          const clonedEntity = this.cloneRobotEntity(this.originalRobotEntity);
          if (clonedEntity) {
            this.spawnRobot(clonedEntity);
          }
        }
      }
    }

    crowd.update(this.agents, this.navMesh, clampedDeltaTime);

    // Update robot-to-robot interactions (proximity-based)
    this.interactionManager.update(clampedDeltaTime, time);

    // Update panic minigame (random panic outbreaks + data link VFX)
    this.playerInteractionManager?.updatePanicMinigame(clampedDeltaTime);

    // Periodic debug logging (every 2 seconds) - only calculate if logging is enabled
    let shouldDebugLog = false;
    if (this.logger.debug) {
      if (!this._lastDebugLog) this._lastDebugLog = 0;
      shouldDebugLog = time - this._lastDebugLog > 2000;
      if (shouldDebugLog) this._lastDebugLog = time;
    }

    // Throttle face/tie updates to ~3x per second (333ms)
    const shouldUpdateFaceTie = time - this._lastFaceTieUpdate > 333;
    if (shouldUpdateFaceTie) {
      this._lastFaceTieUpdate = time;
    }

    for (const [entityIndex, robotEntity] of this.robotEntities.entries()) {
      // Get consolidated state for this robot (single lookup instead of many)
      const state = this.robotState.get(entityIndex);
      const agentId = state?.agentId;
      if (agentId === null || agentId === undefined) continue;

      const agent = this.agents.agents[agentId];
      if (!agent) continue;

      // DEBUG: Skip all movement calculations - just update position from navcat
      if (this._debugDisableMovement) {
        const robotObject = robotEntity.object3D;
        if (robotObject) {
          robotObject.position.set(
            agent.position[0],
            agent.position[1],
            agent.position[2]
          );
        }
        continue; // Skip all procedural animation
      }

      // Debug log agent state periodically (skip calculations if not logging)
      if (shouldDebugLog) {
        const vel = agent.velocity || [0, 0, 0];
        const velMag = Math.sqrt(
          vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]
        );
        const desVel = agent.desiredVelocity || [0, 0, 0];
        const desVelMag = Math.sqrt(
          desVel[0] * desVel[0] + desVel[1] * desVel[1] + desVel[2] * desVel[2]
        );
        const corridorLen = agent.corridor?.path?.length || 0;
        const cornersLen = agent.corners?.length || 0;

        this.logger.log(
          `Agent ${agentId}: state=${agent.state}, targetState=${
            agent.targetState
          }, vel=${velMag.toFixed(3)}, desVel=${desVelMag.toFixed(
            3
          )}, corridor=${corridorLen}, corners=${cornersLen}, isAtTarget=${crowd.isAgentAtTarget(
            this.agents,
            agentId,
            agent.radius
          )}`
        );
      }

      // Calculate current speed early (needed for anticipation + squash + tilt)
      const vel = agent.velocity || [0, 0, 0];
      const currentSpeed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);

      // Get all movement states in single lookup (performance optimization)
      const baseScale = robotEntity.object3D
        ? robotEntity.object3D.scale.x
        : 0.5;
      const movementStates = this.movementManager.getAllStates(
        entityIndex,
        baseScale,
        0
      );
      const squashState = movementStates.squash;
      const tiltState = movementStates.tilt;
      const facingState = movementStates.facing;

      let targetSquash = 0; // Target deformation this frame

      // === JUMP HANDLING (delegated to JumpManager) ===
      if (agent.state === crowd.AgentState.OFFMESH && agent.offMeshAnimation) {
        const anim = agent.offMeshAnimation;

        // Initialize jump if not already started
        if (!squashState.isJumping) {
          const jumpDurationMultiplier =
            state?.character?.physics?.jumpDurationMultiplier ?? 1.0;
          this.jumpManager.startJump(
            entityIndex,
            anim.startPosition,
            anim.endPosition,
            movementStates.facing.currentFacing,
            jumpDurationMultiplier
          );
          squashState.isJumping = true;
          // Fade out contact shadow during jump
          if (state.blobShadow) state.blobShadow.setJumping(true);
          // Update state machine
          this.stateMachine.setState(entityIndex, ROBOT_STATE.JUMPING);
        }

        // Update jump animation
        const jumpResult = this.jumpManager.updateJump(
          entityIndex,
          agent,
          squashState,
          clampedDeltaTime
        );

        if (jumpResult) {
          targetSquash = jumpResult.squash;
          squashState.jumpLean = jumpResult.lean;
          squashState.currentJumpFacing = jumpResult.facing;

          if (jumpResult.isComplete) {
            // Complete the jump
            this.jumpManager.completeJump(entityIndex, agentId);
            squashState.isJumping = false;
            squashState.landingTimer = 0;
            // Set shadow to landing position and fade in
            if (state.blobShadow) {
              state.blobShadow.setLandingPosition(
                agent.position[0],
                agent.position[1],
                agent.position[2]
              );
              state.blobShadow.setJumping(false);
            }
            // Update state machine - return to previous state
            this.stateMachine.onStateComplete(entityIndex);
          }
        }
      } else if (
        squashState.landingTimer <
        this.movementManager.squashConfig.landingRecovery
      ) {
        // Post-landing recovery (delegated to JumpManager)
        targetSquash = this.jumpManager.updateLandingRecovery(
          squashState,
          clampedDeltaTime,
          this.movementManager.squashConfig
        );
      } else {
        // Not jumping - decay any residual jump lean
        this.jumpManager.decayJumpLean(squashState, clampedDeltaTime);
      }

      // Get all interaction values in single lookup (performance optimization)
      const interactionValues =
        this.interactionManager.getInteractionValues(entityIndex);
      // Cache interaction state for later use (avoids duplicate Map.get calls)
      const interactionState =
        this.interactionManager.interactionState.get(entityIndex);

      // Add interaction squash contribution (angry shake / happy jump)
      if (interactionValues?.squash) {
        // Interaction animations take priority - blend with navigation squash
        targetSquash = targetSquash * 0.3 + interactionValues.squash * 0.7;
      }

      // Add pat squash contribution (player patting robot head)
      const patSquash = this.playerInteractionManager.getPatSquash(entityIndex);
      if (patSquash !== 0) {
        // Pat squash adds directly to current squash (negative = squash down)
        targetSquash += patSquash;
      }

      // Smooth lerp toward target (linear approximation of exponential decay)
      const squashLerpFactor = Math.min(
        1,
        this.movementManager.squashConfig.lerpSpeed * clampedDeltaTime
      );
      squashState.currentSquash +=
        (targetSquash - squashState.currentSquash) * squashLerpFactor;

      // Clamp squash/stretch
      squashState.currentSquash = Math.max(
        -1,
        Math.min(1, squashState.currentSquash)
      );

      const robotObject = robotEntity.object3D;
      if (!robotObject) continue;

      // Get height offset from character appearance (lifts robot above navmesh)
      const heightOffset = state?.character?.appearance?.heightOffset || 0;

      // Get position offsets from interaction animations (happy jumps, barrel roll)
      const interactionYOffset = interactionValues?.yOffset || 0;
      const interactionXOffset = interactionValues?.xOffset || 0;
      const interactionZOffset = interactionValues?.zOffset || 0;

      // Get hover float offsets (subtle continuous floating animation)
      // This provides position offset + tilt for thruster bottom animation
      // Always active - robots are always hovering even during movement/jumps
      const hoverFloat = this.movementManager.updateHover(
        entityIndex,
        time / 1000,
        clampedDeltaTime,
        currentSpeed,
        squashState.isJumping
      );

      // Calculate hop animation offset (from triggerNamedRobotReaction)
      let hopOffset = 0;
      if (state?.hopStartTime) {
        const hopElapsed = time - state.hopStartTime;
        const hopT = Math.min(hopElapsed / (state.hopDuration || 350), 1);
        if (hopT < 1) {
          // Parabolic arc: starts at 0, peaks at 0.5, ends at 0
          hopOffset = 4 * hopT * (1 - hopT) * (state.hopHeight || 0.15);
        } else {
          // Hop complete, clear state
          state.hopStartTime = null;
          // Fade shadow back in (unless interaction animation is still airborne)
          if (state.blobShadow && interactionYOffset < 0.05) {
            state.blobShadow.setJumping(false);
          }
        }
      }

      // Fade shadow for interaction animations (happy jumps, barrel rolls, etc.)
      // But don't override if already in an offmesh jump
      if (state?.blobShadow && !state.hopStartTime && !squashState.isJumping) {
        const isAirborne = interactionYOffset > 0.05;
        state.blobShadow.setJumping(isAirborne);
      }

      // Handle spawn transition animation (smooth arc from portal to navmesh)
      let baseX = agent.position[0];
      let baseY = agent.position[1];
      let baseZ = agent.position[2];

      if (state?.spawnTransition?.active) {
        const transition = state.spawnTransition;
        const elapsed = (time - transition.startTime) / 1000;
        transition.progress = Math.min(1, elapsed / transition.duration);

        if (transition.progress >= 1) {
          // Transition complete - sync agent position to final transition position
          agent.position[0] = transition.targetPosition[0];
          agent.position[1] = transition.targetPosition[1];
          agent.position[2] = transition.targetPosition[2];

          // Set agent target to current position to prevent movement until transition is fully complete
          if (agent.targetPosition) {
            agent.targetPosition[0] = transition.targetPosition[0];
            agent.targetPosition[1] = transition.targetPosition[1];
            agent.targetPosition[2] = transition.targetPosition[2];
          }

          transition.active = false;
          this.logger.log(`Robot ${entityIndex} spawn transition complete`);
        } else {
          // During transition, prevent agent from moving by setting target to transition target
          if (agent.targetPosition) {
            agent.targetPosition[0] = transition.targetPosition[0];
            agent.targetPosition[1] = transition.targetPosition[1];
            agent.targetPosition[2] = transition.targetPosition[2];
          }

          // Calculate arc position - ease out for smooth landing
          const t = transition.progress;
          const eased = 1 - Math.pow(1 - t, 3); // Ease out cubic

          // Lerp horizontal position
          baseX =
            transition.startPosition[0] +
            (transition.targetPosition[0] - transition.startPosition[0]) *
              eased;
          baseZ =
            transition.startPosition[2] +
            (transition.targetPosition[2] - transition.startPosition[2]) *
              eased;

          // Arc height - parabolic curve that peaks at 50% progress
          const heightDiff =
            transition.targetPosition[1] - transition.startPosition[1];
          const arcHeight = 0.15; // Peak height of arc above the straight line
          const arcOffset = 4 * t * (1 - t) * arcHeight; // Parabola: peaks at t=0.5
          baseY = transition.startPosition[1] + heightDiff * eased + arcOffset;

          // Add some squash at the end of transition (anticipating landing)
          if (t > 0.8) {
            const landingT = (t - 0.8) / 0.2;
            squashState.currentSquash = -0.15 * landingT;
          }
        }
      }

      // Add vertical offset so robot doesn't sink into floor (navmesh is at floor level)
      // Also add interaction offsets for jump/loop animations + hover float + reaction hop
      robotObject.position.set(
        baseX + interactionXOffset + hoverFloat.offsetX,
        baseY +
          heightOffset +
          interactionYOffset +
          hoverFloat.offsetY +
          hopOffset,
        baseZ + interactionZOffset + hoverFloat.offsetZ
      );

      // Apply squash & stretch scale (preserve volume)
      const scale = this.movementManager.computeScale(
        squashState.currentSquash,
        squashState.baseScale
      );
      robotObject.scale.set(scale.scaleX, scale.scaleY, scale.scaleZ);

      // === BB-8 STYLE TILT ANIMATION ===
      // tiltState already fetched via getAllStates above
      const speed = currentSpeed;
      const { smoothedSpeed, acceleration } = this.movementManager.updateTilt(
        entityIndex,
        speed,
        clampedDeltaTime
      );

      // === Y ROTATION (facing direction) with turn rate smoothing ===
      let targetAngle = null;

      // Check if robot should face interaction partner (highest priority)
      const interactionLookTarget =
        this.interactionManager.getLookTarget(entityIndex);
      if (interactionLookTarget && interactionValues?.shouldPause) {
        // Face partner during chat/reaction phases
        const dx = interactionLookTarget.x - agent.position[0];
        const dz = interactionLookTarget.z - agent.position[2];
        targetAngle = Math.atan2(dx, dz);
      } else if (this._robotsLookAtEachOther) {
        // Inquisitive mode - robots look at random other robots
        const lookTarget = this._getInterRobotLookTarget(entityIndex, agent);
        if (lookTarget) {
          const dx = lookTarget.x - agent.position[0];
          const dz = lookTarget.z - agent.position[2];
          targetAngle = Math.atan2(dx, dz);

          // Also rotate head toward target
          const faceManager = state?.faceManager;
          if (faceManager) {
            this._tempVec3.set(
              agent.position[0],
              agent.position[1],
              agent.position[2]
            );
            faceManager.lookAtWithBodyOverflow(
              lookTarget,
              this._tempVec3,
              facingState.currentFacing
            );
          }
        }
      } else if (this.lookAtPlayer && this.world.camera) {
        // Head leads the look-at, body only rotates for overflow beyond head's maxYaw
        const camPos = this.world.camera.position;
        const faceManager = state?.faceManager;

        // Calculate world angle from robot to player
        const dx = camPos.x - agent.position[0];
        const dz = camPos.z - agent.position[2];
        const worldAngleToPlayer = Math.atan2(dx, dz);

        if (faceManager) {
          // facingState already fetched via getAllStates above

          // Get robot world position for pitch calculation
          this._tempVec3.set(
            agent.position[0],
            agent.position[1],
            agent.position[2]
          );

          // Let head look at player, get body overflow
          const bodyOverflow = faceManager.lookAtWithBodyOverflow(
            camPos,
            this._tempVec3,
            facingState.currentFacing
          );

          // Body rotates by overflow amount (head handles up to ±maxYaw)
          // This means body only turns when head hits its rotation limit
          if (Math.abs(bodyOverflow) > 0.02) {
            targetAngle = facingState.currentFacing + bodyOverflow;
          }
          // When no overflow, body stays put and head handles the look
        } else {
          // Fallback: body looks directly at player
          targetAngle = worldAngleToPlayer;
        }
      } else {
        // Check for panicking robots to avoid and look at
        const panicLookTarget = this._getPanicLookTarget(
          entityIndex,
          agent,
          facingState.currentFacing
        );
        if (panicLookTarget) {
          // Brief head-only glance at panicking robot (no body turning)
          const faceManager = state?.faceManager;
          if (faceManager) {
            faceManager.lookAtPosition(
              panicLookTarget,
              facingState.currentFacing
            );
          }
          // Keep body facing navigation direction (don't turn toward panic)
          let faceVel = vel;
          let faceVelMag = speed;
          if (faceVelMag < 0.01 && agent.desiredVelocity) {
            faceVel = agent.desiredVelocity;
            faceVelMag = agent.desiredSpeed || 0;
          }
          if (faceVelMag > 0.01) {
            targetAngle = Math.atan2(faceVel[0], faceVel[2]);
          }
        } else {
          // Normal velocity-based facing
          let faceVel = vel;
          let faceVelMag = speed;

          if (faceVelMag < 0.01 && agent.desiredVelocity) {
            faceVel = agent.desiredVelocity;
            faceVelMag = agent.desiredSpeed || 0; // Use navcat's pre-computed value
          }

          if (faceVelMag > 0.01) {
            targetAngle = Math.atan2(faceVel[0], faceVel[2]);
          }
        }
      }

      // Update facing angle with turn rate limiting
      // facingState already fetched via getAllStates above
      const turnSpeedMultiplier =
        state?.character?.physics?.turnSpeedMultiplier ?? 1.0;
      const { turnRate } = this.movementManager.updateFacing(
        entityIndex,
        targetAngle,
        clampedDeltaTime,
        turnSpeedMultiplier
      );

      // Bank into turns
      this.movementManager.updateBank(
        entityIndex,
        turnRate,
        smoothedSpeed,
        clampedDeltaTime
      );

      // === ANTICIPATION & FOLLOW-THROUGH (Classic Animation Principles) ===
      // Throttled to every 2nd frame for performance
      let anticipation = { squash: 0, tilt: 0 };
      let followThrough = { tilt: 0 };
      if (this._frameCounter % 2 === 0) {
        anticipation = this.movementManager.updateAnticipation(
          entityIndex,
          speed,
          turnRate,
          clampedDeltaTime * 2
        );
        followThrough = this.movementManager.updateFollowThrough(
          entityIndex,
          clampedDeltaTime * 2
        );
        state._cachedAnticipation = anticipation;
        state._cachedFollowThrough = followThrough;
      } else {
        anticipation = state._cachedAnticipation || anticipation;
        followThrough = state._cachedFollowThrough || followThrough;
      }

      // === IDLE FIDGETS (Secondary Action when stationary) ===
      const isIdle = speed < 0.05 && !this.scanManager.isScanning(entityIndex);
      const idleFidget = this.movementManager.updateIdle(
        entityIndex,
        isIdle,
        clampedDeltaTime
      );

      // Combine all tilt/bank contributions (excluding hover - added after combine)
      const normalTilt =
        tiltState.currentTilt +
        anticipation.tilt +
        followThrough.tilt +
        idleFidget.tilt;
      const normalBank = tiltState.currentBank + idleFidget.bank;

      let { combinedTilt, combinedBank } = this.movementManager.combineTiltBank(
        squashState,
        tiltState,
        normalTilt,
        normalBank,
        clampedDeltaTime
      );

      // Add hover tilt AFTER combine so it always applies (even during jumps)
      // Robots are always hovering, so this subtle thruster tilt is always present
      combinedTilt += hoverFloat.tiltX;
      combinedBank += hoverFloat.tiltZ;

      // Apply combined rotation via Transform component (Y facing + X tilt + Z bank)
      let facingAngle = this.movementManager.blendFacing(
        squashState,
        facingState,
        clampedDeltaTime
      );

      // Panic rotation removed - panicked robots should continue navigating, not spin
      // Only apply smooth rotation transition when panic ends
      const transitionOffset =
        this.playerInteractionManager?.getPanicRotationTransition(
          entityIndex,
          facingAngle
        ) || 0;

      facingAngle += transitionOffset;

      const halfY = facingAngle / 2;
      this._quatY.set(0, Math.sin(halfY), 0, Math.cos(halfY));

      // Add interaction X rotation (for loop-the-loop animation)
      const interactionXRotation = interactionValues?.xRotation || 0;
      const finalTilt = combinedTilt + interactionXRotation;

      // X rotation quaternion (forward/back tilt) - includes anticipation, follow-through, idle, or jump lean, and loop animation
      const halfX = finalTilt / 2;
      this._quatX.set(Math.sin(halfX), 0, 0, Math.cos(halfX));

      // Add interaction Z rotation (for barrel roll animation)
      const interactionZRotation = interactionValues?.zRotation || 0;
      const finalBank = combinedBank + interactionZRotation;

      // Z rotation quaternion (bank into turns + idle fidget + barrel roll)
      const halfZ = finalBank / 2;
      this._quatZ.set(0, 0, Math.sin(halfZ), Math.cos(halfZ));

      // Combine: first Y (facing), then X (tilt), then Z (bank) in local space
      this._quatCombined
        .copy(this._quatY)
        .multiply(this._quatX)
        .multiply(this._quatZ);

      // Set on Transform component
      const orientation = robotEntity.getVectorView(Transform, "orientation");
      orientation[0] = this._quatCombined.x;
      orientation[1] = this._quatCombined.y;
      orientation[2] = this._quatCombined.z;
      orientation[3] = this._quatCombined.w;

      // Apply anticipation squash to scale (layered on top of jump squash)
      if (Math.abs(anticipation.squash) > 0.01) {
        const finalScale = this.movementManager.applyAnticipationSquash(
          anticipation.squash,
          {
            scaleX: robotObject.scale.x,
            scaleY: robotObject.scale.y,
            scaleZ: robotObject.scale.z,
          }
        );
        robotObject.scale.set(
          finalScale.scaleX,
          finalScale.scaleY,
          finalScale.scaleZ
        );
      }

      // === PROCEDURAL AUDIO (engine hum) ===
      const characterMaxSpeed = state?.character?.physics?.maxSpeed ?? 1.4;
      if (this.audioManager.audioEnabled) {
        let engine = this.audioManager.getEngine(entityIndex);
        if (!engine) {
          engine = this.audioManager.createEngineForRobot(entityIndex);
        }
        const isJumping = squashState.isJumping;
        engine.setSpeedAndAcceleration(speed, characterMaxSpeed, isJumping);
        engine.setPosition(
          agent.position[0],
          agent.position[1],
          agent.position[2]
        );
      }

      // === ENGINE THRUST VFX (fusion propulsion rings) ===
      const thrustVFX = state?.thrustVFX;
      if (thrustVFX) {
        thrustVFX.updateFromContext(
          speed,
          characterMaxSpeed,
          squashState,
          interactionState,
          agent,
          clampedDeltaTime
        );
      }

      // === PROCEDURAL VOICE (random chatter) ===
      if (this.audioManager.voiceEnabled) {
        let voice = this.audioManager.getVoice(entityIndex);
        if (!voice) {
          // Get or assign character for this robot (via CharacterManager)
          let character = state?.character;
          if (!character) {
            character = this.characterManager.assignCharacter(entityIndex);
            if (state) state.character = character;
            this.characterManager.createNameTag(entityIndex, character);
          }
          voice = this.audioManager.createVoiceForRobot(entityIndex, character);
        }

        // Update voice position
        voice.setPosition(
          agent.position[0],
          agent.position[1],
          agent.position[2]
        );

        // Update name tag position and billboard (include animation offsets so tag follows jumps)
        const nameTagYOffset =
          heightOffset + interactionYOffset + hoverFloat.offsetY + hopOffset;
        this.characterManager.updateNameTag(
          entityIndex,
          agent.position,
          nameTagYOffset
        );

        // Check for chatter
        this.audioManager.updateChatter(entityIndex);

        // Animate mouth while voice is speaking
        if (state?.faceManager && voice?.isSpeaking) {
          state.faceManager.updateTalkingMouth(clampedDeltaTime);
        } else if (state?.faceManager?.isTalking()) {
          state.faceManager.stopTalking();
        }
      }

      // Face emotion and look-at updates
      const faceManager = state?.faceManager;
      if (faceManager) {
        const isScanning = this.scanManager.isScanning(entityIndex);

        // Update emotion flash - throttled to ~3x per second
        if (shouldUpdateFaceTie) {
          if (!state.faceFlashState) {
            state.faceFlashState = RobotFaceManager.createFlashState(
              this.faceFlashConfig
            );
            // If starting mid-flash, set a random emotion immediately
            if (state.faceFlashState.isFlashing) {
              const randomEmotion =
                this.faceFlashConfig.emotions[
                  Math.floor(
                    Math.random() * this.faceFlashConfig.emotions.length
                  )
                ];
              this.setRobotFaceEmotion(entityIndex, randomEmotion);
            }
          }
          faceManager.updateEmotionFlash(
            state.faceFlashState,
            this.faceFlashConfig,
            isScanning,
            (emotion) => this.setRobotFaceEmotion(entityIndex, emotion)
          );
        }

        // Update turn rate and rotation animation
        const robotYaw = Math.atan2(
          2 *
            (this._quatCombined.w * this._quatCombined.y +
              this._quatCombined.x * this._quatCombined.z),
          1 -
            2 *
              (this._quatCombined.y * this._quatCombined.y +
                this._quatCombined.z * this._quatCombined.z)
        );
        faceManager.updateTurnRate(robotYaw, clampedDeltaTime, smoothedSpeed);
        faceManager.updateRotation(clampedDeltaTime);

        // Update look targets (throttled - every 2 frames)
        if (this._frameCounter % 2 === 0) {
          if (!state.faceLookState) {
            state.faceLookState = RobotFaceManager.createLookState(
              this.faceLookConfig
            );
          }
          const interactionLookTarget =
            this.interactionManager.getLookTarget(entityIndex);
          faceManager.updateLookTarget(
            state.faceLookState,
            this.faceLookConfig,
            isScanning,
            this.isStationary,
            interactionLookTarget,
            facingState?.currentFacing ?? 0
          );
        }
      }

      // Update tie animation - throttled to ~3x per second
      const tieManager = state?.tieManager;
      if (tieManager && shouldUpdateFaceTie) {
        tieManager.update(turnRate, smoothedSpeed, acceleration, 0.333);
      }

      // Update arm animations
      const armManager = state?.armManager;
      if (armManager) {
        const armState = armManager.determineStateFromContext(
          interactionState,
          squashState,
          smoothedSpeed
        );

        // Set pointing angle for chatting
        if (
          armState === ArmState.CHATTING &&
          interactionState?.partnerId !== null
        ) {
          const partnerEntity = this.robotEntities.get(
            interactionState.partnerId
          );
          const pointingAngle = armManager.calculatePointingAngle(
            robotObject,
            partnerEntity?.object3D
          );
          if (pointingAngle !== null) {
            armManager.setPointingAngle(pointingAngle);
          }
        }

        armManager.setState(armState);
        armManager.update(
          clampedDeltaTime,
          smoothedSpeed,
          turnRate,
          vel[0],
          vel[2]
        );
      }

      // Update eye animations (lead motion with eyes - Lasseter anticipation)
      if (faceManager) {
        if (squashState.isJumping) {
          // Eyes follow jump phases
          const jumpState = this.jumpManager.getJumpState?.(entityIndex);
          const phase = jumpState?.phase || "none";
          faceManager.updateEyesForJump(phase, squashState.jumpProgress || 0);
        } else if (
          squashState.landingTimer > 0 &&
          squashState.landingTimer < 0.15
        ) {
          // Squint eyes briefly on landing impact
          faceManager.updateEyesForJump("landing", 1);
        } else {
          // Eyes lead turns during normal movement
          faceManager.updateEyesForMotion(
            turnRate,
            smoothedSpeed,
            clampedDeltaTime
          );

          // Occasional random eye variation when idle (pupils, shape changes)
          if (smoothedSpeed < 0.1 && Math.random() < 0.001) {
            faceManager.randomEyeVariation();
          }
        }
      }

      // Update agent debug visualization
      const agentHelper = state?.agentHelper;
      if (agentHelper) {
        agentHelper.position.set(
          agent.position[0],
          agent.position[1] + 0.05,
          agent.position[2]
        );
        agentHelper.renderOrder = 1000;
      }

      const lastTargetTime = state?.lastTargetTime ?? 0;
      const isAtTarget = crowd.isAgentAtTarget(
        this.agents,
        agentId,
        agent.radius
      );

      // Re-evaluate goal accessibility periodically or after navmesh changes
      if (
        this.navigationManager.goalPosition &&
        time - this.lastNavMeshRebuildTime < 100
      ) {
        this.navigationManager.evaluateGoalAccessibility();
      }

      // === SCANNING STATE MANAGEMENT (delegated to ScanManager) ===
      const wasScanningBefore =
        this.stateMachine.getState(entityIndex) === ROBOT_STATE.SCANNING;
      const isScanningNow = this.scanManager.update(
        entityIndex,
        robotEntity,
        agent,
        clampedDeltaTime
      );

      // Update state machine for scanning transitions
      if (isScanningNow && !wasScanningBefore) {
        this.stateMachine.setState(entityIndex, ROBOT_STATE.SCANNING);
      } else if (!isScanningNow && wasScanningBefore) {
        this.stateMachine.onStateComplete(entityIndex);
      }

      // === PLAYER INTERACTION UPDATE (pat detection, follow, minigame) ===
      this.playerInteractionManager.update(
        entityIndex,
        robotEntity,
        agent,
        clampedDeltaTime
      );

      // Skip movement logic if state machine says so, or interaction pause
      // Note: isMovementAllowed already handles robots 4 and 5 panicking exception
      const movementAllowed = this.stateMachine.isMovementAllowed(entityIndex);
      const pauseMovement =
        this.interactionManager.shouldPauseMovement(entityIndex);
      if (!movementAllowed || pauseMovement) {
        // Debug log if in wandering debug period
        if (
          this._wanderingDebugUntil &&
          performance.now() < this._wanderingDebugUntil
        ) {
          const smState = this.stateMachine.getState(entityIndex);
          this.logger.log(
            `Robot ${entityIndex}: SKIPPING movement - movementAllowed=${movementAllowed}, pauseMovement=${pauseMovement}, smState=${smState}`
          );
        }
        continue;
      }

      // For 4th and 5th panic robots, always ensure they have a navigation target
      const currentState = this.stateMachine.getState(entityIndex);
      const pimState = this.pim?.getState(entityIndex);
      if (
        currentState === ROBOT_STATE.PANICKING &&
        pimState?.panicNumber >= 4
      ) {
        // Set a new target periodically, regardless of isAtTarget status
        const timeSinceTarget = time - lastTargetTime;
        if (timeSinceTarget > this.wanderInterval) {
          this.selectRandomWanderTarget(robotEntity, agentId);
          if (state) state.lastTargetTime = time;
          continue;
        }
      }

      if (isAtTarget) {
        // Check if robot reached the goal (delegated to NavigationManager)
        this.navigationManager.checkRobotAtGoal(entityIndex, agent.position);

        const timeSinceTarget = time - lastTargetTime;

        // Skip re-navigation while awaiting interpretation or during greeting response
        if (this._awaitingInterpretation || this._greetingReturnPending) {
          // Debug log
          if (
            this._wanderingDebugUntil &&
            performance.now() < this._wanderingDebugUntil
          ) {
            this.logger.log(
              `Robot ${entityIndex}: SKIPPING nav (isAtTarget) - _awaitingInterpretation=${this._awaitingInterpretation}, _greetingReturnPending=${this._greetingReturnPending}`
            );
          }
          continue;
        }

        // Debug log
        if (
          this._wanderingDebugUntil &&
          performance.now() < this._wanderingDebugUntil
        ) {
          this.logger.log(
            `Robot ${entityIndex}: isAtTarget=true, timeSinceTarget=${timeSinceTarget.toFixed(
              0
            )}, targetInterval=${this.targetInterval}`
          );
        }

        if (timeSinceTarget > this.targetInterval) {
          // Check if it should scan (delegated to ScanManager)
          if (this.scanManager.onGoalReached(entityIndex, agent.position)) {
            continue; // Started scanning
          }

          // Try to go to goal if accessible, otherwise wander
          this.navigationManager.tryGoalOrWander(robotEntity, agentId);
          if (state) state.lastTargetTime = time;
        }
      } else if (!this.isStationary && !this._awaitingInterpretation) {
        // Skip navigation changes while awaiting interpretation (robots are gathering)

        // Check for player avoidance first (highest priority - don't walk through user's legs)
        if (this._checkPlayerAvoidance(entityIndex, agent, agentId)) {
          if (state) state.lastTargetTime = time;
          continue;
        }

        // Check for panic avoidance (higher priority than goal)
        if (this._checkPanicAvoidance(entityIndex, agent, agentId)) {
          // Avoidance target set, skip other navigation
          if (state) state.lastTargetTime = time;
          continue;
        }

        // If goal becomes accessible while moving, switch to it
        const nav = this.navigationManager;
        if (nav.goalAccessible && nav.goalNodeRef) {
          const pathResult = findPath(
            this.navMesh,
            agent.position,
            nav.goalPosition,
            [2, 2, 2],
            DEFAULT_QUERY_FILTER
          );
          if (pathResult.success && pathResult.path.length > 0) {
            crowd.requestMoveTarget(
              this.agents,
              agentId,
              nav.goalNodeRef,
              nav.goalPosition
            );
            if (state) state.lastTargetTime = time;
          }
        } else if (time - lastTargetTime > this.wanderInterval) {
          // Periodically pick a new random target while moving
          if (this.useWandering) {
            this.selectRandomWanderTarget(robotEntity, agentId);
            if (state) state.lastTargetTime = time;
          }
        }

        // Stuck detection - try goal or wander
        if (
          agent.velocity?.[0] === 0 &&
          agent.velocity?.[1] === 0 &&
          agent.velocity?.[2] === 0
        ) {
          if (time - lastTargetTime > 2000) {
            this.navigationManager.tryGoalOrWander(robotEntity, agentId);
            if (state) state.lastTargetTime = time;
          }
        }
      }
    }

    // Update VFX manager (handles contact shadows, etc.)
    if (this.world.vfxManager) {
      this.world.vfxManager.update(clampedDeltaTime);
    }

    // Update Entropod minigame (waits for XR + scene understanding before starting)
    if (this.world.entropodMinigame) {
      this.world.entropodMinigame.update(clampedDeltaTime);
    }
  }
}
