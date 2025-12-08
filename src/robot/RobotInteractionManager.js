/**
 * RobotInteractionManager.js - Robot-to-robot social interactions
 * =============================================================================
 *
 * ROLE: Manages proximity-triggered interactions between robot pairs. Creates
 * emergent social behavior where robots stop, "chat", and react to each other.
 *
 * INTERACTION FLOW (PHASES):
 *   0. NONE - No interaction
 *   1. APPROACH - Robots navigate toward each other
 *   2. CHAT_A - First robot makes mood sound
 *   3. CHAT_B - Second robot responds
 *   4. CHAT_PAUSE - Brief pause before reaction
 *   5. REACTION - Animated response (angry shake or happy celebration)
 *
 * HAPPY ANIMATION VARIANTS (randomly selected):
 *   - "happy" (50%): Simple celebratory jump
 *   - "happyLoop" (25%): Rocket up, forward 360° flip, land
 *   - "happyBarrel" (25%): Fly up, trace sideways loop path, gentle descent
 *
 * KEY APIs FOR RobotSystem:
 *   - update(deltaTime, now): Main update, call each frame
 *   - shouldPauseMovement(entityIndex): Returns true if robot should stop
 *   - getInteractionSquash/YOffset/XOffset/ZOffset/XRotation/ZRotation():
 *     Animation values to apply to robot transform
 *   - getLookTarget(entityIndex): World position robot should look at
 *
 * STATE: Per-robot state in this.interactionState Map. Active interaction pairs
 * tracked in this.activeInteractions Map.
 *
 * VFX: Creates RobotDataLinkVFX (particle line between antennas) during chat.
 *
 * INTEGRATION: Cancels active scans when interaction starts. Sets face emotions.
 *
 * KNOWN ISSUES:
 * - Loop animations must snap rotation to 0 mid-animation to avoid 2π→0 unwinding
 * =============================================================================
 */
import { Logger } from "../utils/Logger.js";
import { RobotEmotion } from "./RobotFaceManager.js";
import { RobotDataLinkVFX } from "./RobotDataLinkVFX.js";
import { gameState } from "../gameState.js";

// Interaction phases
const PHASE = {
  NONE: 0,
  APPROACH: 1, // Robots navigating toward each other
  CHAT_A: 2, // First robot speaking
  CHAT_B: 3, // Second robot responding
  CHAT_PAUSE: 4, // Brief pause after chat
  REACTION: 5, // Angry/happy animation
};

export class RobotInteractionManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotInteraction", false);

    // Interaction state per robot (keyed by entity index)
    this.interactionState = new Map();

    // Active interaction pairs (to coordinate between two robots)
    this.activeInteractions = new Map(); // interactionId -> { robotA, robotB, phase, ... }
    this._nextInteractionId = 0;

    // Configuration
    this.config = {
      // Proximity triggers
      interactionRadius: 2.0, // Distance to trigger interaction check (meters) - wider range
      interactionRadiusSq: 4.0, // Squared for fast comparison
      approachStopRadius: 0.5, // Distance to consider "arrived" for face-to-face chat (~0.35m per robot)
      approachStopRadiusSq: 0.25, // Squared for fast comparison
      interactionCooldown: 6.0, // Min seconds between interactions for a robot
      globalCooldown: 1.0, // Min seconds between any interactions
      approachTimeout: 5.0, // Max seconds to wait for approach before canceling

      // Chances (0-1)
      interactionChance: 0.5, // Chance to interact when in proximity - higher
      angryChance: 0.35, // Chance the interaction is negative (angry)

      // Chat phase timing
      chatSoundDuration: 0.6, // How long each "speech" lasts
      chatPauseBetween: 0.3, // Pause between A and B speaking
      chatPauseAfter: 0.4, // Pause after chat before reaction

      // Animation durations
      angryDuration: 1.0, // How long the angry animation plays
      happyDuration: 0.7, // How long the happy animation plays

      // Angry shake animation
      angryShakeFrequency: 25, // Shake oscillations per second
      angryShakeIntensity: 0.15, // Max squash/stretch during shake
      angryShakeDecay: 2.5, // How fast shake intensity decays

      // Happy jump animation (simple variant)
      happyJumpHeight: 0.08, // Height of celebratory jump (meters)
      happyJumpDuration: 0.35, // Duration of jump arc
      happyAnticipation: 0.12, // Squat before jump
      happySquashOnLand: 0.25, // Squash on landing
      happyStretchAtPeak: 0.2, // Stretch at jump peak

      // Happy loop-the-loop animation (epic variant - forward flip)
      loopChance: 0.25, // Chance of doing a forward loop
      loopHeight: 0.35, // Higher jump for the loop (meters)
      loopDuration: 2.2, // Total duration of loop animation
      loopAnticipation: 0.25, // Longer squat to build energy
      loopRiseTime: 0.5, // Time to reach peak
      loopFlipTime: 0.8, // Time for the flip portion
      loopFallTime: 0.4, // Time to fall back down
      loopLandTime: 0.25, // Landing recovery

      // Happy barrel roll animation (sideways loop variant)
      barrelRollChance: 0.25, // Chance of doing a barrel roll
      barrelHeight: 0.3, // Jump height for barrel roll
      barrelDuration: 2.5, // Total duration
      barrelAnticipation: 0.2, // Wind-up
      barrelRiseTime: 0.4, // Initial rise
      barrelRollTime: 1.2, // The sideways loop portion
      barrelSettleTime: 0.5, // Gentle descent
      barrelLandTime: 0.2, // Landing recovery

      // Happy bounce animation (multi-bounce for big bots)
      bounceDuration: 1.4, // Total duration
      bounceJumpHeight: 0.05, // Small hop height
      bounceAnticipation: 0.15, // Squat before jump
      bounceCount: 3, // Number of bounces on landing
    };

    this.lastGlobalInteraction = 0;

    // Chat sound options (alternating between curious and content tones)
    this.chatSounds = ["content", "curious", "content", "curious"];

    // Look target offsets from partner's base position (robot is ~0.3m tall)
    this.lookTargetOffsets = {
      face: { y: 0.28, xz: 0 }, // Look at face
      antenna: { y: 0.35, xz: 0 }, // Look at antenna tip
      bowtie: { y: 0.15, xz: 0 }, // Look at bowtie/chest
      shoulderL: { y: 0.18, xz: 0.06 }, // Look at left shoulder
      shoulderR: { y: 0.18, xz: -0.06 }, // Look at right shoulder
    };
    // Weighted toward face, with variety
    this.lookTargetTypes = [
      "face",
      "face",
      "face",
      "antenna",
      "bowtie",
      "shoulderL",
      "shoulderR",
    ];

    // Look target switching during interactions
    this.lookSwitchInterval = { min: 0.8, max: 2.0 }; // seconds between look target changes

    // Data link VFX for visual connection during interactions
    this.dataLinkVFX = null; // Lazy init when scene is available
  }

  /**
   * Get or create interaction state for a robot
   */
  getState(entityIndex) {
    let state = this.interactionState.get(entityIndex);
    if (!state) {
      state = {
        lastInteractionTime: performance.now(), // Set to now so newly spawned robots respect cooldown
        interactionId: null, // ID of current interaction (if any)
        currentAnimation: null, // 'chatting' | 'angry' | 'happy' | 'happyLoop' | 'happyBarrel' | null
        animationTimer: 0,
        animationPhase: 0, // Phase within animation
        targetSquash: 0, // Target squash/stretch from interaction
        yOffset: 0, // Y position offset for happy jump
        xOffset: 0, // X position offset for barrel roll path
        zOffset: 0, // Z position offset for barrel roll path
        xRotation: 0, // X rotation for loop-the-loop (radians)
        zRotation: 0, // Z rotation for barrel roll (radians)
        partnerId: null, // Entity index of interaction partner
        reactionType: null, // 'angry' | 'happy' - decided at chat start
        isPaused: false, // Whether robot's movement is paused
        lookTargetType: "face", // Where to look on partner
        nextLookSwitchTime: 0, // When to switch look target
      };
      this.interactionState.set(entityIndex, state);
    }
    return state;
  }

  /**
   * Check for and trigger proximity interactions between robots.
   * Called each frame from RobotSystem.update()
   */
  update(deltaTime, now) {
    const robots = Array.from(this.robotSystem.robotEntities.entries());

    // Update any active interactions first
    this._updateActiveInteractions(deltaTime, now);

    // Update solo animations (not part of an interaction)
    for (const [entityIndex] of robots) {
      const state = this.getState(entityIndex);
      if (state?.currentAnimation && !state.interactionId) {
        this._updateReactionAnimation(state, deltaTime);
        // Clear animation when complete
        if (state.currentAnimation === null) {
          this.robotSystem.setRobotFaceEmotion(
            entityIndex,
            RobotEmotion.CONTENT
          );
        }
      }
    }

    // Update data link VFX
    if (this.dataLinkVFX) {
      this.dataLinkVFX.update(deltaTime);
    }

    if (robots.length < 2) return;

    // Throttle new interaction detection to every 4th frame for performance
    if (!this._frameCounter) this._frameCounter = 0;
    this._frameCounter++;
    if (this._frameCounter % 4 !== 0) return;

    // Disable new interactions in gathered mode (robots focused on player)
    if (this.robotSystem.gatheredMode) {
      return;
    }

    // Disable new interactions after player greeting (robots become focused on player)
    const gsState = gameState.getState();
    if (gsState.friendlyGreetingReceived) {
      return;
    }

    // Disable new robot-robot interactions during panic minigame
    if (gsState.minigameActive) {
      return;
    }

    // Check global cooldown
    if (now - this.lastGlobalInteraction < this.config.globalCooldown * 1000) {
      return;
    }

    // Check proximity between all robot pairs
    for (let i = 0; i < robots.length; i++) {
      for (let j = i + 1; j < robots.length; j++) {
        const [indexA, entityA] = robots[i];
        const [indexB, entityB] = robots[j];

        const stateA = this.getState(indexA);
        const stateB = this.getState(indexB);

        // Skip if either robot is already in an interaction
        if (stateA.interactionId !== null || stateB.interactionId !== null)
          continue;

        // Skip if either robot is on cooldown
        if (
          now - stateA.lastInteractionTime <
          this.config.interactionCooldown * 1000
        )
          continue;
        if (
          now - stateB.lastInteractionTime <
          this.config.interactionCooldown * 1000
        )
          continue;

        // Check distance
        const posA = entityA.object3D?.position;
        const posB = entityB.object3D?.position;
        if (!posA || !posB) continue;

        const dx = posA.x - posB.x;
        const dz = posA.z - posB.z;
        const distSq = dx * dx + dz * dz;

        if (distSq < this.config.interactionRadiusSq) {
          // Chance to interact
          if (Math.random() < this.config.interactionChance) {
            this._triggerInteraction(indexA, indexB, now);
          }
        }
      }
    }
  }

  /**
   * Trigger an interaction between two robots
   */
  _triggerInteraction(indexA, indexB, now) {
    const stateA = this.getState(indexA);
    const stateB = this.getState(indexB);

    // Cancel any active scans on either robot (interaction takes priority)
    const scanManager = this.robotSystem.scanManager;
    if (scanManager) {
      if (scanManager.isScanning(indexA)) {
        this.logger.log(`Canceling scan on Robot ${indexA} for interaction`);
        scanManager.stopScan(indexA);
      }
      if (scanManager.isScanning(indexB)) {
        this.logger.log(`Canceling scan on Robot ${indexB} for interaction`);
        scanManager.stopScan(indexB);
      }
    }

    // Create interaction record
    const interactionId = this._nextInteractionId++;
    const interaction = {
      id: interactionId,
      robotA: indexA,
      robotB: indexB,
      phase: PHASE.APPROACH,
      phaseTimer: 0,
      startTime: now,
      // Determine outcome now (but don't reveal until reaction phase)
      isNegative: Math.random() < this.config.angryChance,
      aIsAngry: false,
      bIsAngry: false,
    };

    // If negative, randomly pick who gets angry
    if (interaction.isNegative) {
      if (Math.random() < 0.5) {
        interaction.aIsAngry = true;
      } else {
        interaction.bIsAngry = true;
      }
    }

    this.activeInteractions.set(interactionId, interaction);

    // Link robots to this interaction (in APPROACH phase, not paused yet)
    stateA.interactionId = interactionId;
    stateA.partnerId = indexB;
    stateA.currentAnimation = "approaching";
    stateA.animationTimer = 0;
    stateA.isPaused = false; // Still moving during approach
    stateA.reactionType = interaction.aIsAngry ? "angry" : "happy";
    stateA.lookTargetType = this._pickRandomLookTarget();
    stateA.nextLookSwitchTime = now + this._randomLookSwitchDelay();

    stateB.interactionId = interactionId;
    stateB.partnerId = indexA;
    stateB.currentAnimation = "approaching";
    stateB.animationTimer = 0;
    stateB.isPaused = false; // Still moving during approach
    stateB.reactionType = interaction.bIsAngry ? "angry" : "happy";
    stateB.lookTargetType = this._pickRandomLookTarget();
    stateB.nextLookSwitchTime = now + this._randomLookSwitchDelay();

    // Update cooldowns
    stateA.lastInteractionTime = now;
    stateB.lastInteractionTime = now;
    this.lastGlobalInteraction = now;

    // Set each robot to navigate toward the other
    this._setApproachTargets(indexA, indexB);

    // Set curious/interested faces during approach
    this.robotSystem.setRobotFaceEmotion(indexA, RobotEmotion.CURIOUS);
    this.robotSystem.setRobotFaceEmotion(indexB, RobotEmotion.CURIOUS);

    this.logger.log(
      `Interaction ${interactionId} started (APPROACH): Robot ${indexA} ↔ Robot ${indexB}`
    );
  }

  /**
   * Update all active interactions through their phases
   */
  _updateActiveInteractions(deltaTime, now) {
    for (const [
      interactionId,
      interaction,
    ] of this.activeInteractions.entries()) {
      interaction.phaseTimer += deltaTime;

      const stateA = this.getState(interaction.robotA);
      const stateB = this.getState(interaction.robotB);

      switch (interaction.phase) {
        case PHASE.APPROACH:
          // Check if robots are close enough to start chat
          if (
            this._checkApproachComplete(interaction.robotA, interaction.robotB)
          ) {
            // Transition to chat phase
            this._startChatPhase(interaction, stateA, stateB);
            this.logger.log(
              `Interaction ${interactionId}: Approach complete, starting chat`
            );
          } else if (interaction.phaseTimer >= this.config.approachTimeout) {
            // Approach timed out - cancel interaction
            this._cancelInteraction(interaction, stateA, stateB, interactionId);
            this.logger.log(
              `Interaction ${interactionId}: Approach timed out, canceling`
            );
          }
          break;

        case PHASE.CHAT_A:
          // First robot is speaking
          if (interaction.phaseTimer >= this.config.chatSoundDuration) {
            interaction.phase = PHASE.CHAT_B;
            interaction.phaseTimer = 0;
            // Second robot responds
            this._playMoodSound(interaction.robotB);
          }
          break;

        case PHASE.CHAT_B:
          // Second robot is speaking
          if (
            interaction.phaseTimer >=
            this.config.chatSoundDuration + this.config.chatPauseBetween
          ) {
            interaction.phase = PHASE.CHAT_PAUSE;
            interaction.phaseTimer = 0;
          }
          break;

        case PHASE.CHAT_PAUSE:
          // Brief pause before reactions
          if (interaction.phaseTimer >= this.config.chatPauseAfter) {
            interaction.phase = PHASE.REACTION;
            interaction.phaseTimer = 0;
            // Start reaction animations
            this._startReactionPhase(interaction);
          }
          break;

        case PHASE.REACTION:
          // Update reaction animations
          this._updateReactionAnimation(stateA, deltaTime);
          this._updateReactionAnimation(stateB, deltaTime);

          // Check if both animations are complete
          if (
            stateA.currentAnimation === null &&
            stateB.currentAnimation === null
          ) {
            // Interaction complete - reset faces to content
            this.robotSystem.setRobotFaceEmotion(
              interaction.robotA,
              RobotEmotion.CONTENT
            );
            this.robotSystem.setRobotFaceEmotion(
              interaction.robotB,
              RobotEmotion.CONTENT
            );

            // Remove data link VFX (graceful outro)
            if (this.dataLinkVFX) {
              this.dataLinkVFX.removeLinkGraceful(interaction.id);
            }

            stateA.interactionId = null;
            stateA.isPaused = false;
            stateB.interactionId = null;
            stateB.isPaused = false;
            this.activeInteractions.delete(interactionId);
            this.logger.log(`Interaction ${interactionId} completed`);
          }
          break;
      }
    }
  }

  /**
   * Set navigation targets for robots to approach each other
   */
  _setApproachTargets(indexA, indexB) {
    const entityA = this.robotSystem.robotEntities.get(indexA);
    const entityB = this.robotSystem.robotEntities.get(indexB);
    if (!entityA?.object3D || !entityB?.object3D) return;

    const posA = entityA.object3D.position;
    const posB = entityB.object3D.position;

    // Calculate midpoint and offset positions so they meet in the middle
    const midX = (posA.x + posB.x) / 2;
    const midZ = (posA.z + posB.z) / 2;

    // Direction from A to B
    const dx = posB.x - posA.x;
    const dz = posB.z - posA.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 0.1) return; // Already very close

    const nx = dx / dist;
    const nz = dz / dist;

    // Target positions: slightly past midpoint toward each other
    const offset = this.config.approachStopRadius * 0.6;
    const targetAx = midX - nx * offset;
    const targetAz = midZ - nz * offset;
    const targetBx = midX + nx * offset;
    const targetBz = midZ + nz * offset;

    // Set navigation targets via RobotSystem
    this.robotSystem.setRobotNavigationTarget(
      indexA,
      targetAx,
      posA.y,
      targetAz
    );
    this.robotSystem.setRobotNavigationTarget(
      indexB,
      targetBx,
      posB.y,
      targetBz
    );
  }

  /**
   * Check if both robots have approached close enough
   */
  _checkApproachComplete(indexA, indexB) {
    const entityA = this.robotSystem.robotEntities.get(indexA);
    const entityB = this.robotSystem.robotEntities.get(indexB);
    if (!entityA?.object3D || !entityB?.object3D) return false;

    const posA = entityA.object3D.position;
    const posB = entityB.object3D.position;

    const dx = posA.x - posB.x;
    const dz = posA.z - posB.z;
    const distSq = dx * dx + dz * dz;

    return distSq <= this.config.approachStopRadiusSq;
  }

  /**
   * Start the chat phase after approach is complete
   */
  _startChatPhase(interaction, stateA, stateB) {
    interaction.phase = PHASE.CHAT_A;
    interaction.phaseTimer = 0;

    // Now pause movement
    stateA.currentAnimation = "chatting";
    stateA.isPaused = true;
    stateB.currentAnimation = "chatting";
    stateB.isPaused = true;

    // Stop the agents completely
    this.robotSystem.stopRobotMovement(interaction.robotA);
    this.robotSystem.stopRobotMovement(interaction.robotB);

    // Start first robot speaking
    this._playMoodSound(interaction.robotA);

    // Create data link VFX between antennas
    this._createDataLink(interaction);
  }

  /**
   * Create visual data link between robot antennas
   */
  _createDataLink(interaction) {
    // Lazy init the VFX manager
    if (!this.dataLinkVFX && this.robotSystem.world?.scene) {
      this.dataLinkVFX = new RobotDataLinkVFX(this.robotSystem.world.scene);
    }

    if (!this.dataLinkVFX) return;

    const entityA = this.robotSystem.robotEntities.get(interaction.robotA);
    const entityB = this.robotSystem.robotEntities.get(interaction.robotB);

    if (entityA?.object3D && entityB?.object3D) {
      this.dataLinkVFX.createLink(
        interaction.id,
        entityA.object3D,
        entityB.object3D
      );
      this.logger.log(`Data link created for interaction ${interaction.id}`);
    }
  }

  /**
   * Cancel an interaction (e.g., approach timed out)
   */
  _cancelInteraction(interaction, stateA, stateB, interactionId) {
    // Reset states
    stateA.interactionId = null;
    stateA.isPaused = false;
    stateA.currentAnimation = null;
    stateB.interactionId = null;
    stateB.isPaused = false;
    stateB.currentAnimation = null;

    // Reset faces
    this.robotSystem.setRobotFaceEmotion(
      interaction.robotA,
      RobotEmotion.CONTENT
    );
    this.robotSystem.setRobotFaceEmotion(
      interaction.robotB,
      RobotEmotion.CONTENT
    );

    // Remove data link VFX if it exists (graceful outro)
    if (this.dataLinkVFX) {
      this.dataLinkVFX.removeLinkGraceful(interaction.id);
    }

    this.activeInteractions.delete(interactionId);
  }

  /**
   * Play a mood sound for a robot during chat
   */
  _playMoodSound(entityIndex) {
    const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
    if (voice) {
      // Pick between content and curious for chat sounds
      const sound =
        this.chatSounds[Math.floor(Math.random() * this.chatSounds.length)];
      if (typeof voice[sound] === "function") {
        voice[sound]();
      }
    }
  }

  /**
   * Start the reaction phase for both robots
   */
  _startReactionPhase(interaction) {
    const stateA = this.getState(interaction.robotA);
    const stateB = this.getState(interaction.robotB);

    // Start reaction animation for robot A
    if (interaction.aIsAngry) {
      this._startAngryAnimation(interaction.robotA, stateA, interaction.robotB);
    } else {
      this._startHappyAnimation(interaction.robotA, stateA, interaction.robotB);
    }

    // Start reaction animation for robot B
    if (interaction.bIsAngry) {
      this._startAngryAnimation(interaction.robotB, stateB, interaction.robotA);
    } else {
      this._startHappyAnimation(interaction.robotB, stateB, interaction.robotA);
    }

    this.logger.log(
      `Reaction phase: Robot ${interaction.robotA} (${
        interaction.aIsAngry ? "angry" : "happy"
      }) ↔ Robot ${interaction.robotB} (${
        interaction.bIsAngry ? "angry" : "happy"
      })`
    );
  }

  _startAngryAnimation(entityIndex, state, partnerId) {
    state.currentAnimation = "angry";
    state.animationTimer = 0;
    state.animationPhase = 0;
    state.targetSquash = 0;

    // Set angry face
    this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.ANGRY);

    // Play angry sound
    const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
    if (voice?.angry) voice.angry();
  }

  _startHappyAnimation(entityIndex, state, partnerId, forcedType = null) {
    const character =
      this.robotSystem.characterManager?.getCharacter(entityIndex);
    const charId = character?.id;

    // Per-character animation restrictions
    // Modem: flip (happyLoop), Blit: barrel roll, Baud: bounce
    let animTypes;
    if (charId === "modem") {
      animTypes = ["happy", "happyLoop"];
    } else if (charId === "blit") {
      animTypes = ["happy", "happyBarrel"];
    } else if (charId === "baud") {
      animTypes = ["happy", "happyBounce"];
    } else {
      animTypes = ["happy"];
    }

    let animType;

    // If explicitly forced (e.g. from dialog), use it directly
    if (forcedType) {
      animType = forcedType;
    } else {
      // Check partner's animation to ensure we pick a different one
      const partnerState = partnerId != null ? this.getState(partnerId) : null;
      const partnerAnim = partnerState?.currentAnimation;

      // Filter out partner's animation type
      let availableTypes = animTypes;
      if (partnerAnim && animTypes.includes(partnerAnim)) {
        availableTypes = animTypes.filter((t) => t !== partnerAnim);
      }

      // Randomly choose from available types
      animType =
        availableTypes[Math.floor(Math.random() * availableTypes.length)];
    }

    state.currentAnimation = animType;
    state.animationTimer = 0;
    state.animationPhase = 0;
    state.targetSquash = 0;
    state.yOffset = 0;
    state.xOffset = 0;
    state.zOffset = 0;
    state.xRotation = 0;
    state.zRotation = 0;

    // Get character animation scale (dampens spatial movements for longer robots)
    state.animationScale = character?.animationScale ?? 1.0;

    // Set happy face
    this.robotSystem.setRobotFaceEmotion(entityIndex, RobotEmotion.EXCITED);

    // Play happy sound
    const voice = this.robotSystem.audioManager?.getVoice(entityIndex);
    if (voice?.happy) voice.happy();

    if (animType === "happyLoop") {
      this.logger.log(`Robot ${entityIndex} doing FORWARD LOOP!`);
    } else if (animType === "happyBarrel") {
      this.logger.log(`Robot ${entityIndex} doing BARREL ROLL!`);
    } else if (animType === "happyBounce") {
      this.logger.log(`Robot ${entityIndex} doing MULTI-BOUNCE!`);
    }
  }

  /**
   * Trigger a solo animation (not part of an interaction)
   * Used for presentation reactions, etc.
   */
  triggerSoloAnimation(entityIndex, animType) {
    this.logger.log(
      `triggerSoloAnimation called: entity=${entityIndex}, type=${animType}`
    );
    const state = this.getState(entityIndex);
    if (!state) {
      this.logger.warn(`No state for entity ${entityIndex}`);
      return;
    }

    this._startHappyAnimation(entityIndex, state, null, animType);
    this.logger.log(
      `Animation started, state.currentAnimation=${state.currentAnimation}`
    );
  }

  /**
   * Update a robot's reaction animation (angry or happy)
   */
  _updateReactionAnimation(state, deltaTime) {
    if (!state.currentAnimation || state.currentAnimation === "chatting")
      return;

    state.animationTimer += deltaTime;

    if (state.currentAnimation === "angry") {
      this._updateAngryAnimation(state, deltaTime);
    } else if (state.currentAnimation === "happy") {
      this._updateHappyAnimation(state, deltaTime);
    } else if (state.currentAnimation === "happyLoop") {
      this._updateHappyLoopAnimation(state, deltaTime);
    } else if (state.currentAnimation === "happyBarrel") {
      this._updateHappyBarrelAnimation(state, deltaTime);
    } else if (state.currentAnimation === "happyBounce") {
      this._updateHappyBounceAnimation(state, deltaTime);
    }
  }

  /**
   * Angry animation: shake with squash/stretch like gritting teeth
   */
  _updateAngryAnimation(state, deltaTime) {
    const cfg = this.config;
    const progress = state.animationTimer / cfg.angryDuration;

    if (progress >= 1) {
      // Animation complete
      state.currentAnimation = null;
      state.targetSquash = 0;
      state.animationTimer = 0;
      // Face will be reset when interaction ends
      return;
    }

    // Intensity envelope: quick attack, slow decay
    const envelope = Math.exp(-cfg.angryShakeDecay * progress);

    // High frequency shake (squash/stretch oscillation)
    const shakePhase =
      state.animationTimer * cfg.angryShakeFrequency * Math.PI * 2;
    const shake = Math.sin(shakePhase) * cfg.angryShakeIntensity * envelope;

    state.targetSquash = shake;
  }

  /**
   * Happy animation: anticipation squat → celebratory jump → land with bounce
   */
  _updateHappyAnimation(state, deltaTime) {
    const cfg = this.config;
    const totalDuration = cfg.happyDuration;
    const progress = state.animationTimer / totalDuration;

    if (progress >= 1) {
      // Animation complete
      state.currentAnimation = null;
      state.targetSquash = 0;
      state.yOffset = 0;
      state.animationTimer = 0;
      state.animationPhase = 0;
      // Face will be reset when interaction ends
      return;
    }

    // Phase timing
    const anticipationEnd = cfg.happyAnticipation / totalDuration;
    const jumpEnd =
      (cfg.happyAnticipation + cfg.happyJumpDuration) / totalDuration;

    if (progress < anticipationEnd) {
      // Phase 0: Anticipation - squat down
      state.animationPhase = 0;
      const phaseProgress = progress / anticipationEnd;
      // Ease in-out squat
      const squat = Math.sin(phaseProgress * Math.PI * 0.5);
      state.targetSquash = -squat * 0.3; // Negative = squash
      state.yOffset = 0;
    } else if (progress < jumpEnd) {
      // Phase 1: Jump arc
      state.animationPhase = 1;
      const jumpProgress =
        (progress - anticipationEnd) / (jumpEnd - anticipationEnd);

      // Parabolic arc for Y position
      const arcProgress = jumpProgress;
      state.yOffset = cfg.happyJumpHeight * 4 * arcProgress * (1 - arcProgress);

      // Stretch at peak, squash at takeoff/landing
      if (jumpProgress < 0.3) {
        // Takeoff: quick stretch
        state.targetSquash = cfg.happyStretchAtPeak * (jumpProgress / 0.3);
      } else if (jumpProgress < 0.7) {
        // Mid-air: full stretch
        state.targetSquash = cfg.happyStretchAtPeak;
      } else {
        // Approaching landing: transition to squash
        const landApproach = (jumpProgress - 0.7) / 0.3;
        state.targetSquash = cfg.happyStretchAtPeak * (1 - landApproach * 2);
      }
    } else {
      // Phase 2: Landing recovery
      state.animationPhase = 2;
      const landProgress = (progress - jumpEnd) / (1 - jumpEnd);
      state.yOffset = 0;

      // Landing squash then bounce back
      if (landProgress < 0.3) {
        // Impact squash
        const impactProgress = landProgress / 0.3;
        state.targetSquash =
          -cfg.happySquashOnLand * Math.sin(impactProgress * Math.PI * 0.5);
      } else {
        // Bounce overshoot then settle
        const settleProgress = (landProgress - 0.3) / 0.7;
        const bounce =
          Math.sin(settleProgress * Math.PI) * 0.1 * (1 - settleProgress);
        state.targetSquash = bounce;
      }
    }
  }

  /**
   * Happy loop-the-loop animation: rocket up, forward flip, land
   * Phases: 0=anticipation, 1=rise, 2=flip, 3=fall, 4=land
   */
  _updateHappyLoopAnimation(state, deltaTime) {
    const cfg = this.config;
    const progress = state.animationTimer / cfg.loopDuration;

    if (progress >= 1) {
      // Animation complete
      state.currentAnimation = null;
      state.targetSquash = 0;
      state.yOffset = 0;
      state.xRotation = 0;
      state.animationTimer = 0;
      state.animationPhase = 0;
      return;
    }

    // Scale spatial movements by character's animationScale
    const scale = state.animationScale ?? 1.0;
    const loopHeight = cfg.loopHeight * scale;

    // Calculate phase boundaries (normalized to 0-1)
    const anticipationEnd = cfg.loopAnticipation / cfg.loopDuration;
    const riseEnd = anticipationEnd + cfg.loopRiseTime / cfg.loopDuration;
    const flipEnd = riseEnd + cfg.loopFlipTime / cfg.loopDuration;
    const fallEnd = flipEnd + cfg.loopFallTime / cfg.loopDuration;
    // landEnd = 1.0

    if (progress < anticipationEnd) {
      // Phase 0: Anticipation - deep squat, building energy
      state.animationPhase = 0;
      const phaseProgress = progress / anticipationEnd;
      // Ease in-out squat, deeper than normal jump
      const squat = Math.sin(phaseProgress * Math.PI * 0.5);
      state.targetSquash = -squat * 0.4; // Deep squash
      state.yOffset = -squat * 0.02; // Slight downward
      state.xRotation = 0;
    } else if (progress < riseEnd) {
      // Phase 1: Rising - rocket up with stretch
      state.animationPhase = 1;
      const phaseProgress =
        (progress - anticipationEnd) / (riseEnd - anticipationEnd);
      // Ease out for rocket launch feel
      const riseEase = 1 - Math.pow(1 - phaseProgress, 2);

      state.yOffset = loopHeight * riseEase;
      state.targetSquash = 0.3 * (1 - phaseProgress * 0.5); // Stretch on launch, ease off
      // Start tilting forward slightly
      state.xRotation = phaseProgress * 0.3;
    } else if (progress < flipEnd) {
      // Phase 2: The flip! Full 360° rotation while at peak
      state.animationPhase = 2;
      const phaseProgress = (progress - riseEnd) / (flipEnd - riseEnd);

      // Stay near peak height with slight arc
      const arcProgress = Math.sin(phaseProgress * Math.PI);
      state.yOffset = loopHeight * (0.9 + arcProgress * 0.1);

      // Full forward flip (360° = 2π)
      // Ease in-out for smooth rotation
      const flipEase =
        phaseProgress < 0.5
          ? 2 * phaseProgress * phaseProgress
          : 1 - Math.pow(-2 * phaseProgress + 2, 2) / 2;
      state.xRotation = flipEase * Math.PI * 2;

      // Stretch during flip, squash at rotation extremes
      const rotationSpeed = Math.abs(Math.cos(phaseProgress * Math.PI));
      state.targetSquash = 0.15 + rotationSpeed * 0.1;
    } else if (progress < fallEnd) {
      // Phase 3: Falling back down - quickly finish the rotation in first half
      state.animationPhase = 3;
      const phaseProgress = (progress - flipEnd) / (fallEnd - flipEnd);
      // Ease in for accelerating fall
      const fallEase = phaseProgress * phaseProgress;

      state.yOffset = loopHeight * (1 - fallEase);

      // Complete the last bit of rotation in first half of fall, then stay at 0
      // This avoids the 2π→0 wrap-around issue (they're visually the same)
      if (phaseProgress < 0.5) {
        // Finish rotation: go from 2π to 2π (visually same as 0)
        state.xRotation = Math.PI * 2;
      } else {
        // Snap to 0 - visually identical to 2π but avoids unwinding
        state.xRotation = 0;
      }
      // Stretch during fall
      state.targetSquash = 0.2 * (1 - phaseProgress * 0.5);
    } else {
      // Phase 4: Landing recovery - rotation already at 0
      state.animationPhase = 4;
      const phaseProgress = (progress - fallEnd) / (1 - fallEnd);
      state.yOffset = 0;
      state.xRotation = 0; // Already settled, keep at 0

      // Landing impact squash then bounce back
      if (phaseProgress < 0.4) {
        // Deep impact squash
        const impactProgress = phaseProgress / 0.4;
        const impactEase = Math.sin(impactProgress * Math.PI * 0.5);
        state.targetSquash = -0.35 * impactEase;
      } else {
        // Bounce overshoot then settle
        const settleProgress = (phaseProgress - 0.4) / 0.6;
        const bounce =
          Math.sin(settleProgress * Math.PI * 2) * 0.15 * (1 - settleProgress);
        state.targetSquash = bounce;
      }
    }
  }

  /**
   * Happy barrel roll animation: fly up, curve into sideways loop path, continue up, descend
   * The robot traces a lasso/loop flight path in 3D space (like the user's drawing)
   * Phases: 0=anticipation, 1=rise, 2=loop, 3=rise-out, 4=settle, 5=land
   */
  _updateHappyBarrelAnimation(state, deltaTime) {
    const cfg = this.config;
    const progress = state.animationTimer / cfg.barrelDuration;

    if (progress >= 1) {
      // Animation complete
      state.currentAnimation = null;
      state.targetSquash = 0;
      state.yOffset = 0;
      state.xOffset = 0;
      state.zOffset = 0;
      state.xRotation = 0;
      state.zRotation = 0;
      state.animationTimer = 0;
      state.animationPhase = 0;
      return;
    }

    // Phase timing (normalized to 0-1)
    const anticipationEnd = 0.06;
    const riseEnd = 0.18;
    const loopEnd = 0.62;
    const riseOutEnd = 0.75;
    const settleEnd = 0.92;

    // Loop parameters - scaled by character's animationScale
    const scale = state.animationScale ?? 1.0;
    const loopRadius = 0.18 * scale; // Radius of the sideways loop (meters)
    const riseHeight = 0.22 * scale; // Initial rise height before loop
    const loopBaseHeight = 0.28 * scale; // Height where loop starts
    const postLoopHeight = 0.38 * scale; // Height after completing loop

    if (progress < anticipationEnd) {
      // Phase 0: Anticipation - squat
      state.animationPhase = 0;
      const phaseProgress = progress / anticipationEnd;
      const squat = Math.sin(phaseProgress * Math.PI * 0.5);
      state.targetSquash = -squat * 0.35;
      state.yOffset = -squat * 0.01;
      state.xOffset = 0;
      state.zOffset = 0;
      state.xRotation = 0;
      state.zRotation = 0;
    } else if (progress < riseEnd) {
      // Phase 1: Rising straight up
      state.animationPhase = 1;
      const phaseProgress =
        (progress - anticipationEnd) / (riseEnd - anticipationEnd);
      const riseEase = 1 - Math.pow(1 - phaseProgress, 2);

      state.yOffset = riseHeight * riseEase;
      state.xOffset = 0;
      state.zOffset = 0;
      state.targetSquash = 0.2 * (1 - phaseProgress * 0.5);
      state.xRotation = 0;
      state.zRotation = 0;
    } else if (progress < loopEnd) {
      // Phase 2: The loop! Robot traces a circular path to the side
      state.animationPhase = 2;
      const phaseProgress = (progress - riseEnd) / (loopEnd - riseEnd);

      // Circular path: trace a loop to the right
      // Angle goes from 0 to 2π (full circle), starting at "top" going clockwise
      const loopAngle = phaseProgress * Math.PI * 2;

      // X offset: horizontal displacement (right then back)
      // sin(0)=0, sin(π/2)=1 (rightmost), sin(π)=0, sin(3π/2)=-1 (leftmost), sin(2π)=0
      state.xOffset = Math.sin(loopAngle) * loopRadius;

      // Y offset: the loop dips down then comes back up
      // At loopAngle=0: at loopBaseHeight
      // At loopAngle=π: at bottom of loop (loopBaseHeight - 2*loopRadius)
      // At loopAngle=2π: back at loopBaseHeight
      const loopVertical = (1 - Math.cos(loopAngle)) * loopRadius;
      state.yOffset = loopBaseHeight - loopVertical;

      state.zOffset = 0;

      // Bank into the turn - lean toward center of loop
      // Going right (0 to π): lean right (negative Z)
      // Going left (π to 2π): lean left (positive Z)
      state.zRotation = -Math.sin(loopAngle) * 0.5;

      // Pitch forward slightly going down, back slightly going up
      state.xRotation = Math.cos(loopAngle) * 0.25;

      // Stretch during fast parts of loop (sides), squash at top/bottom
      state.targetSquash = 0.08 + Math.abs(Math.sin(loopAngle)) * 0.12;
    } else if (progress < riseOutEnd) {
      // Phase 3: Continue upward after completing loop
      state.animationPhase = 3;
      const phaseProgress = (progress - loopEnd) / (riseOutEnd - loopEnd);
      const riseEase = 1 - Math.pow(1 - phaseProgress, 2);

      state.yOffset =
        loopBaseHeight + (postLoopHeight - loopBaseHeight) * riseEase;
      state.xOffset = 0;
      state.zOffset = 0;
      state.xRotation = 0;
      state.zRotation = 0;
      state.targetSquash = 0.1 * (1 - phaseProgress);
    } else if (progress < settleEnd) {
      // Phase 4: Gentle settling descent
      state.animationPhase = 4;
      const phaseProgress = (progress - riseOutEnd) / (settleEnd - riseOutEnd);
      const settleEase = phaseProgress * phaseProgress;

      state.yOffset = postLoopHeight * (1 - settleEase);
      state.xOffset = 0;
      state.zOffset = 0;
      state.xRotation = 0;
      state.zRotation = 0;
      state.targetSquash = 0.05 * (1 - phaseProgress);
    } else {
      // Phase 5: Landing recovery
      state.animationPhase = 5;
      const phaseProgress = (progress - settleEnd) / (1 - settleEnd);
      state.yOffset = 0;
      state.xOffset = 0;
      state.zOffset = 0;
      state.xRotation = 0;
      state.zRotation = 0;

      // Soft landing squash and settle
      if (phaseProgress < 0.5) {
        const impactProgress = phaseProgress / 0.5;
        const impactEase = Math.sin(impactProgress * Math.PI * 0.5);
        state.targetSquash = -0.18 * impactEase;
      } else {
        const settleProgress = (phaseProgress - 0.5) / 0.5;
        const bounce =
          Math.sin(settleProgress * Math.PI) * 0.06 * (1 - settleProgress);
        state.targetSquash = bounce;
      }
    }
  }

  /**
   * Happy bounce animation: small hop with exaggerated multi-bounce landing
   * For big robots like Baud - heavy, weighty squash/stretch
   * Phases: 0=anticipation, 1=jump, 2-4=bounce 1-3
   */
  _updateHappyBounceAnimation(state, deltaTime) {
    const cfg = this.config;
    const progress = state.animationTimer / cfg.bounceDuration;

    if (progress >= 1) {
      state.currentAnimation = null;
      state.targetSquash = 0;
      state.yOffset = 0;
      state.animationTimer = 0;
      state.animationPhase = 0;
      return;
    }

    // Phase timing (normalized to 0-1)
    const anticipationEnd = cfg.bounceAnticipation / cfg.bounceDuration;
    const jumpEnd = anticipationEnd + 0.2; // Short hop
    const bounce1End = jumpEnd + 0.25; // First big bounce
    const bounce2End = bounce1End + 0.18; // Second smaller bounce
    const bounce3End = bounce2End + 0.12; // Third tiny bounce
    // Remainder is settle

    if (progress < anticipationEnd) {
      // Phase 0: Deep anticipation squat
      state.animationPhase = 0;
      const phaseProgress = progress / anticipationEnd;
      const squat = Math.sin(phaseProgress * Math.PI * 0.5);
      state.targetSquash = -squat * 0.35; // Deep squat for heavy bot
      state.yOffset = 0;
    } else if (progress < jumpEnd) {
      // Phase 1: Small hop
      state.animationPhase = 1;
      const phaseProgress =
        (progress - anticipationEnd) / (jumpEnd - anticipationEnd);
      const arcProgress = phaseProgress;
      state.yOffset =
        cfg.bounceJumpHeight * 4 * arcProgress * (1 - arcProgress);
      // Stretch during hop
      if (phaseProgress < 0.4) {
        state.targetSquash = 0.25 * (phaseProgress / 0.4);
      } else {
        state.targetSquash = 0.25 * (1 - (phaseProgress - 0.4) / 0.6);
      }
    } else if (progress < bounce1End) {
      // Phase 2: First bounce - big squash then stretch
      state.animationPhase = 2;
      const phaseProgress = (progress - jumpEnd) / (bounce1End - jumpEnd);
      state.yOffset = 0;
      if (phaseProgress < 0.3) {
        // Impact squash
        const impactEase = Math.sin((phaseProgress / 0.3) * Math.PI * 0.5);
        state.targetSquash = -0.4 * impactEase;
      } else if (phaseProgress < 0.6) {
        // Rebound stretch
        const reboundProgress = (phaseProgress - 0.3) / 0.3;
        state.targetSquash = -0.4 + 0.6 * reboundProgress; // -0.4 to +0.2
      } else {
        // Settle toward neutral
        const settleProgress = (phaseProgress - 0.6) / 0.4;
        state.targetSquash = 0.2 * (1 - settleProgress);
      }
    } else if (progress < bounce2End) {
      // Phase 3: Second bounce - medium squash
      state.animationPhase = 3;
      const phaseProgress = (progress - bounce1End) / (bounce2End - bounce1End);
      state.yOffset = 0;
      if (phaseProgress < 0.35) {
        const impactEase = Math.sin((phaseProgress / 0.35) * Math.PI * 0.5);
        state.targetSquash = -0.25 * impactEase;
      } else if (phaseProgress < 0.65) {
        const reboundProgress = (phaseProgress - 0.35) / 0.3;
        state.targetSquash = -0.25 + 0.35 * reboundProgress;
      } else {
        const settleProgress = (phaseProgress - 0.65) / 0.35;
        state.targetSquash = 0.1 * (1 - settleProgress);
      }
    } else if (progress < bounce3End) {
      // Phase 4: Third bounce - small squash
      state.animationPhase = 4;
      const phaseProgress = (progress - bounce2End) / (bounce3End - bounce2End);
      state.yOffset = 0;
      if (phaseProgress < 0.4) {
        const impactEase = Math.sin((phaseProgress / 0.4) * Math.PI * 0.5);
        state.targetSquash = -0.12 * impactEase;
      } else {
        const settleProgress = (phaseProgress - 0.4) / 0.6;
        const bounce =
          Math.sin(settleProgress * Math.PI) * 0.05 * (1 - settleProgress);
        state.targetSquash = bounce;
      }
    } else {
      // Phase 5: Final settle
      state.animationPhase = 5;
      const phaseProgress = (progress - bounce3End) / (1 - bounce3End);
      state.yOffset = 0;
      // Tiny wobble settling to rest
      const wobble =
        Math.sin(phaseProgress * Math.PI * 2) * 0.03 * (1 - phaseProgress);
      state.targetSquash = wobble;
    }
  }

  /**
   * Get the current squash/stretch contribution from interaction animation.
   * Called by RobotSystem when calculating final squash values.
   */
  getInteractionSquash(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || !state.currentAnimation) return 0;
    if (state.currentAnimation === "chatting") return 0; // No squash during chat
    return state.targetSquash;
  }

  /**
   * Get the Y offset for happy jump animation.
   * Called by RobotSystem when positioning robots.
   */
  getInteractionYOffset(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state) return 0;
    const anim = state.currentAnimation;
    if (
      anim !== "happy" &&
      anim !== "happyLoop" &&
      anim !== "happyBarrel" &&
      anim !== "happyBounce"
    ) {
      return 0;
    }
    return state.yOffset;
  }

  /**
   * Get the X position offset for barrel roll loop path.
   * Called by RobotSystem when positioning robots.
   */
  getInteractionXOffset(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || state.currentAnimation !== "happyBarrel") return 0;
    return state.xOffset || 0;
  }

  /**
   * Get the Z position offset for barrel roll loop path.
   * Called by RobotSystem when positioning robots.
   */
  getInteractionZOffset(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || state.currentAnimation !== "happyBarrel") return 0;
    return state.zOffset || 0;
  }

  /**
   * Get the X rotation for loop animations.
   * Called by RobotSystem when rotating robots.
   * @returns {number} X rotation in radians (0 if not in special animation)
   */
  getInteractionXRotation(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state) return 0;
    const anim = state.currentAnimation;
    if (anim !== "happyLoop" && anim !== "happyBarrel") return 0;
    return state.xRotation;
  }

  /**
   * Get the Z rotation for barrel roll animation.
   * Called by RobotSystem when rotating robots.
   * @returns {number} Z rotation in radians (0 if not in barrel roll)
   */
  getInteractionZRotation(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || state.currentAnimation !== "happyBarrel") return 0;
    return state.zRotation;
  }

  /**
   * Get all interaction values in a single call (performance optimization).
   * Consolidates 6+ separate Map.get() calls into one.
   * @returns {Object|null} All interaction values or null if no state
   */
  getInteractionValues(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state) return null;

    const anim = state.currentAnimation;
    const isHappyAnim =
      anim === "happy" ||
      anim === "happyLoop" ||
      anim === "happyBarrel" ||
      anim === "happyBounce";
    const isBarrel = anim === "happyBarrel";
    const isLoopOrBarrel = anim === "happyLoop" || isBarrel;

    return {
      squash: anim === "chatting" ? 0 : state.targetSquash || 0,
      yOffset: isHappyAnim ? state.yOffset || 0 : 0,
      xOffset: isBarrel ? state.xOffset || 0 : 0,
      zOffset: isBarrel ? state.zOffset || 0 : 0,
      xRotation: isLoopOrBarrel ? state.xRotation || 0 : 0,
      zRotation: isBarrel ? state.zRotation || 0 : 0,
      shouldPause: state.isPaused === true,
    };
  }

  /**
   * Check if a robot is currently in an interaction (should stop moving).
   */
  isInInteraction(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    return state?.interactionId !== null;
  }

  /**
   * Check if a robot's movement should be paused.
   */
  shouldPauseMovement(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    return state?.isPaused === true;
  }

  /**
   * Check if a robot is currently in an interaction animation.
   */
  isAnimating(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    return state?.currentAnimation !== null;
  }

  /**
   * Check if robot should be looking at its partner (during chat/reaction phases).
   */
  isLookingAtPartner(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || state.interactionId === null) return false;
    // Look at partner during chatting and reaction phases, not during approach
    const anim = state.currentAnimation;
    return (
      anim === "chatting" ||
      anim === "angry" ||
      anim === "happy" ||
      anim === "happyLoop" ||
      anim === "happyBarrel"
    );
  }

  /**
   * Get the world position a robot should look at during interaction.
   * Returns null if robot is not in an interaction or is still approaching.
   * @param {number} entityIndex - Robot entity index
   * @returns {Object|null} - { x, y, z } world position to look at, or null
   */
  getLookTarget(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (!state || state.interactionId === null || state.partnerId === null) {
      return null;
    }

    // Don't force look-at during approach phase (let natural movement control facing)
    if (state.currentAnimation === "approaching") {
      return null;
    }

    // Get partner's position
    const partnerEntity = this.robotSystem.robotEntities.get(state.partnerId);
    if (!partnerEntity?.object3D) return null;

    // Check if it's time to switch look target
    const now = performance.now();
    if (now >= state.nextLookSwitchTime) {
      const oldTarget = state.lookTargetType;
      // Pick a different target
      let newTarget;
      let attempts = 0;
      do {
        newTarget = this._pickRandomLookTarget();
        attempts++;
      } while (newTarget === oldTarget && attempts < 5);

      state.lookTargetType = newTarget;
      state.nextLookSwitchTime = now + this._randomLookSwitchDelay();
    }

    const partnerPos = partnerEntity.object3D.position;
    const offset =
      this.lookTargetOffsets[state.lookTargetType] ||
      this.lookTargetOffsets.face;

    // Calculate look target with offset
    // For shoulders, add xz offset perpendicular to the line between robots
    let xOffset = 0;
    let zOffset = 0;

    if (offset.xz !== 0) {
      // Get direction from this robot to partner
      const thisEntity = this.robotSystem.robotEntities.get(entityIndex);
      if (thisEntity?.object3D) {
        const dx = partnerPos.x - thisEntity.object3D.position.x;
        const dz = partnerPos.z - thisEntity.object3D.position.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.01) {
          // Perpendicular offset (positive = left shoulder, negative = right shoulder)
          const perpX = -dz / len;
          const perpZ = dx / len;
          xOffset = perpX * offset.xz;
          zOffset = perpZ * offset.xz;
        }
      }
    }

    const lookTarget = {
      x: partnerPos.x + xOffset,
      y: partnerPos.y + offset.y,
      z: partnerPos.z + zOffset,
    };

    // Debug log (throttled - only every ~60 calls)
    if (!this._lookDebugCounter) this._lookDebugCounter = 0;
    this._lookDebugCounter++;
    if (this._lookDebugCounter % 60 === 0) {
      this.logger.log(
        `Robot ${entityIndex} looking at partner ${state.partnerId} (${
          state.lookTargetType
        }): (${lookTarget.x.toFixed(2)}, ${lookTarget.y.toFixed(
          2
        )}, ${lookTarget.z.toFixed(2)})`
      );
    }

    return lookTarget;
  }

  /**
   * Pick a random look target type (weighted toward face)
   */
  _pickRandomLookTarget() {
    return this.lookTargetTypes[
      Math.floor(Math.random() * this.lookTargetTypes.length)
    ];
  }

  /**
   * Get random delay before switching look target (in ms)
   */
  _randomLookSwitchDelay() {
    const { min, max } = this.lookSwitchInterval;
    return (min + Math.random() * (max - min)) * 1000;
  }

  /**
   * Clean up state for a removed robot
   */
  removeRobot(entityIndex) {
    const state = this.interactionState.get(entityIndex);
    if (state?.interactionId !== null) {
      // Clean up the interaction
      this.activeInteractions.delete(state.interactionId);
    }
    this.interactionState.delete(entityIndex);
  }

  /**
   * Cancel all active interactions (used when robots need to gather)
   */
  cancelAllInteractions() {
    for (const [interactionId, interaction] of this.activeInteractions) {
      const stateA = this.getState(interaction.robotA);
      const stateB = this.getState(interaction.robotB);

      if (stateA && stateB) {
        this._cancelInteraction(interaction, stateA, stateB, interactionId);
      }
    }

    // Clear all active interactions
    this.activeInteractions.clear();

    // Remove any data link VFX
    if (this.dataLinkVFX) {
      this.dataLinkVFX.removeAllLinks();
    }

    this.logger.log("All interactions canceled");
  }
}
