/**
 * DialogManager.js - UNIFIED AUDIO, CAPTIONS, AND LIP SYNC
 * =============================================================================
 *
 * ROLE: Manages dialog playback including audio, 3D captions, and lip sync
 * animation. Dialogs trigger based on game state criteria from dialogData.js.
 *
 * KEY RESPONSIBILITIES:
 * - Play audio files with volume control
 * - Display timed 3D captions parented to player head
 * - Drive LipSyncManager for phoneme animation
 * - Subscribe to game state for criteria-based auto-play
 * - Queue and manage dialog sequences
 *
 * DIALOG FLOW:
 * 1. Game state changes trigger getDialogsForState()
 * 2. Matching dialogs queued for playback
 * 3. Audio plays, captions display with timing
 * 4. LipSyncManager analyzes audio for visemes
 * 5. onFrameChange callback updates phoneme display
 *
 * CAPTION SYSTEM:
 * 3D text mesh positioned in front of head, follows gaze.
 * Captions defined with start/end times in dialogData.js.
 *
 * VOLUME:
 * Respects OptionsMenu sfxVolume setting.
 *
 * USAGE: Created by AIManager, plays dialogs based on game state
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import { gameState, GAME_STATES } from "../gameState.js";
import {
  dialogTracks,
  getDialogsForState,
  getDialogById,
} from "../data/dialogData.js";
import { checkCriteria } from "../utils/CriteriaHelper.js";
import { LipSyncManager } from "./LipSyncManager.js";
import * as THREE from "three";

export class DialogManager {
  constructor(options = {}) {
    this.logger = new Logger("Dialog", options.debug || false);

    this.world = options.world;
    this.player = options.player;

    // Volume settings
    this.baseVolume = options.volume || 0.8;
    this.audioVolume = this.baseVolume;

    // Active dialog state
    this.currentDialog = null;
    this.isPlaying = false;
    this.dialogStartTime = 0;
    this._firedEvents = new Set(); // Track which timed events have fired

    // Caption state
    this.captions = [];
    this.currentCaptionIndex = -1;
    this.captionMesh = null;
    this.textCanvas = null;
    this.textContext = null;
    this.textTexture = null;

    // Caption position relative to head
    this.captionOffset =
      options.captionOffset || new THREE.Vector3(0, -0.25, -0.6);
    this.captionScale = options.captionScale || 0.35;

    // Text styling
    this.fontSize = options.fontSize || 42;
    this.fontFamily = options.fontFamily || "Arial, sans-serif";
    this.textColor = options.textColor || "#ffffff";
    this.backgroundColor = options.backgroundColor || "rgba(0, 0, 0, 0.75)";
    this.padding = options.padding || 16;
    this.maxWidth = options.maxWidth || 700;
    this.borderRadius = options.borderRadius || 10;

    // LipSyncManager for viseme animation
    this.lipSyncManager = null;
    this.onFrameChange = options.onFrameChange || null; // Callback for viseme frame changes

    // Tracking
    this.playedDialogs = new Set();
    this.pendingDialogs = new Map(); // dialogId -> { dialog, timer, delay }

    // State subscription
    this._stateHandler = null;
    this._animationId = null;

    // Callbacks
    this.onDialogStart = options.onDialogStart || null;
    this.onDialogComplete = options.onDialogComplete || null;
    this.onCaptionChange = options.onCaptionChange || null;

    // XR pause state
    this._pausedForXR = false;
    this._pausedAudioTime = 0;
  }

  async initialize() {
    if (!this.world || !this.player?.head) {
      this.logger.warn("World or player.head not available");
      return false;
    }

    // Create caption panel
    this._createCaptionPanel();

    // Create LipSyncManager
    this.lipSyncManager = new LipSyncManager({
      debug: true,
      onFrameChange: (frame, uv) => {
        if (this.onFrameChange) {
          this.onFrameChange(frame, uv);
        }
      },
    });
    await this.lipSyncManager.initialize();

    // Subscribe to game state changes
    this._subscribeToState();

    this.logger.log("Initialized");
    return true;
  }

  _createCaptionPanel() {
    // Create canvas for text rendering
    this.textCanvas = document.createElement("canvas");
    this.textCanvas.width = this.maxWidth;
    this.textCanvas.height = 160;
    this.textContext = this.textCanvas.getContext("2d");

    // Create texture from canvas
    this.textTexture = new THREE.CanvasTexture(this.textCanvas);
    this.textTexture.minFilter = THREE.LinearFilter;
    this.textTexture.magFilter = THREE.LinearFilter;

    // Create plane geometry for caption panel
    const aspectRatio = this.textCanvas.width / this.textCanvas.height;
    const geometry = new THREE.PlaneGeometry(aspectRatio * 0.2, 0.2);
    const material = new THREE.MeshBasicMaterial({
      map: this.textTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.captionMesh = new THREE.Mesh(geometry, material);
    this.captionMesh.scale.set(this.captionScale, this.captionScale, 1);
    this.captionMesh.position.copy(this.captionOffset);
    this.captionMesh.visible = false;
    this.captionMesh.renderOrder = 9999;

    // Parent to player head
    this.player.head.add(this.captionMesh);

    this._clearCanvas();
  }

  _clearCanvas() {
    const ctx = this.textContext;
    ctx.clearRect(0, 0, this.textCanvas.width, this.textCanvas.height);
    this.textTexture.needsUpdate = true;
  }

  _renderCaption(text) {
    const ctx = this.textContext;
    const canvas = this.textCanvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!text) {
      this.textTexture.needsUpdate = true;
      return;
    }

    ctx.font = `bold ${this.fontSize}px ${this.fontFamily}`;

    // Word wrap
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    const maxTextWidth = canvas.width - this.padding * 2;

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxTextWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineHeight = this.fontSize * 1.25;
    const textHeight = lines.length * lineHeight;
    const textStartY = (canvas.height - textHeight) / 2 + lineHeight / 2;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Draw black outline then white fill
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 4;
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;

    for (let i = 0; i < lines.length; i++) {
      const y = textStartY + i * lineHeight;
      ctx.strokeText(lines[i], canvas.width / 2, y);
    }

    ctx.fillStyle = "#ffffff";
    for (let i = 0; i < lines.length; i++) {
      const y = textStartY + i * lineHeight;
      ctx.fillText(lines[i], canvas.width / 2, y);
    }

    this.textTexture.needsUpdate = true;
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _subscribeToState() {
    if (!gameState) return;

    // Use gameState.on() - no "subscribe" method exists
    this._stateHandler = (newState, oldState) => {
      // Handle XR pause/resume - pause dialogs when:
      // - XR session ends (state < XR_ACTIVE)
      // - XR paused: headset removed (hidden) or system UI showing (visible-blurred)
      const wasActiveXR =
        oldState?.currentState >= GAME_STATES.XR_ACTIVE &&
        oldState?.currentState !== GAME_STATES.XR_PAUSED;
      const isActiveXR =
        newState?.currentState >= GAME_STATES.XR_ACTIVE &&
        newState?.currentState !== GAME_STATES.XR_PAUSED;

      // XR became inactive (exited, paused, or system UI) - pause dialog
      if (wasActiveXR && !isActiveXR) {
        this.logger.log(
          `XR inactive (state ${oldState?.currentState} -> ${newState?.currentState}) - pausing dialog`
        );
        this._pauseForXR();
      }
      // XR became active again - resume dialog
      else if (!wasActiveXR && isActiveXR && this._pausedForXR) {
        this.logger.log(
          `XR active (state ${oldState?.currentState} -> ${newState?.currentState}) - resuming dialog`
        );
        this._resumeFromXR();
      }

      // Check for any relevant state changes (not just currentState)
      // NOTE: Must include ALL keys used in dialogData.js criteria!
      const relevantChanges =
        newState?.currentState !== oldState?.currentState ||
        newState?.roomSetupRequired !== oldState?.roomSetupRequired ||
        newState?.robotsActive !== oldState?.robotsActive ||
        newState?.robotBehavior !== oldState?.robotBehavior ||
        newState?.introPlayed !== oldState?.introPlayed ||
        newState?.portalPlacementPlayed !== oldState?.portalPlacementPlayed ||
        newState?.ambassadorPresentationPlayed !==
          oldState?.ambassadorPresentationPlayed ||
        newState?.greetingResult !== oldState?.greetingResult ||
        newState?.firstCalmCompleted !== oldState?.firstCalmCompleted ||
        newState?.secondCalmCompleted !== oldState?.secondCalmCompleted ||
        newState?.thirdCalmCompleted !== oldState?.thirdCalmCompleted ||
        newState?.panicMinigameCompleted !== oldState?.panicMinigameCompleted ||
        newState?.reassuranceResult !== oldState?.reassuranceResult ||
        newState?.firstEntropodSpawned !== oldState?.firstEntropodSpawned ||
        newState?.entropodMinigameCompleted !==
          oldState?.entropodMinigameCompleted ||
        newState?.modemApproaching !== oldState?.modemApproaching ||
        newState?.modemArrived !== oldState?.modemArrived ||
        newState?.modemStayResult !== oldState?.modemStayResult ||
        newState?.voiceInputEnabled !== oldState?.voiceInputEnabled ||
        newState?.gameEnding !== oldState?.gameEnding;

      if (relevantChanges) {
        // Log relevant state changes for debugging
        if (
          newState?.entropodMinigameCompleted !==
          oldState?.entropodMinigameCompleted
        ) {
          this.logger.log(
            `entropodMinigameCompleted: ${oldState?.entropodMinigameCompleted} -> ${newState?.entropodMinigameCompleted}`
          );
        }
        if (newState?.modemArrived !== oldState?.modemArrived) {
          this.logger.log(
            `modemArrived: ${oldState?.modemArrived} -> ${newState?.modemArrived}`
          );
        }
        if (newState?.voiceInputEnabled !== oldState?.voiceInputEnabled) {
          this.logger.log(
            `voiceInputEnabled: ${oldState?.voiceInputEnabled} -> ${newState?.voiceInputEnabled}`
          );
        }
        if (newState?.gameEnding !== oldState?.gameEnding) {
          this.logger.log(
            `gameEnding: ${oldState?.gameEnding} -> ${newState?.gameEnding}`
          );
        }
        if (newState?.modemStayResult !== oldState?.modemStayResult) {
          this.logger.log(
            `modemStayResult: ${oldState?.modemStayResult} -> ${newState?.modemStayResult}`
          );
        }
        this._checkAutoPlayDialogs(newState);
      }
    };
    gameState.on("state:changed", this._stateHandler);
    this.logger.log("Subscribed to state changes");

    // Check initial state
    const currentState = gameState.getState();
    if (currentState) {
      this.logger.log(`Checking initial state: ${currentState.currentState}`);
      this._checkAutoPlayDialogs(currentState);
    }
  }

  _checkAutoPlayDialogs(state) {
    // Debug: log calm states
    if (
      state?.firstCalmCompleted ||
      state?.secondCalmCompleted ||
      state?.thirdCalmCompleted
    ) {
      this.logger.log(
        `Calm states: 1st=${state.firstCalmCompleted}, 2nd=${state.secondCalmCompleted}, 3rd=${state.thirdCalmCompleted}, isPlaying=${this.isPlaying}`
      );
    }

    if (this.isPlaying) {
      this.logger.log(
        `Skipping auto-play check - dialog already playing: ${this.currentDialog?.id}`
      );
      return;
    }

    // Debug: log greeting-related state
    if (state?.greetingResult) {
      this.logger.log(
        `Checking dialogs with greetingResult=${state.greetingResult}, friendlyGreetingReceived=${state.friendlyGreetingReceived}`
      );
    }

    const matching = getDialogsForState(state, this.playedDialogs);
    this.logger.log(
      `Found ${matching.length} matching dialogs: ${
        matching.map((d) => d.id).join(", ") || "none"
      }`
    );

    for (const dialog of matching) {
      // Skip if already playing or pending
      if (this.currentDialog?.id === dialog.id) continue;
      if (this.pendingDialogs.has(dialog.id)) continue;

      this.logger.log(`Auto-play triggered: ${dialog.id}`);

      // Mark as played if once
      if (dialog.once) {
        this.playedDialogs.add(dialog.id);
      }

      // Schedule with delay or play immediately
      if (dialog.delay && dialog.delay > 0) {
        this._scheduleDialog(dialog);
      } else {
        this.playDialog(dialog);
      }

      break; // Only play one dialog per state change
    }
  }

  _scheduleDialog(dialog) {
    this.pendingDialogs.set(dialog.id, {
      dialog,
      timer: 0,
      delay: dialog.delay,
    });
    this.logger.log(
      `Scheduled dialog "${dialog.id}" with ${dialog.delay}s delay`
    );
  }

  /**
   * Play a dialog
   * @param {Object|string} dialogOrId - Dialog object or ID string
   */
  async playDialog(dialogOrId) {
    const dialog =
      typeof dialogOrId === "string" ? getDialogById(dialogOrId) : dialogOrId;

    if (!dialog) {
      this.logger.warn(`Dialog not found: ${dialogOrId}`);
      return;
    }

    // Stop current dialog if playing
    if (this.isPlaying) {
      this.stop();
    }

    this.currentDialog = dialog;
    this.captions = dialog.captions || [];
    this.currentCaptionIndex = -1;
    this.isPlaying = true;
    this._firedEvents.clear(); // Reset for new dialog
    this.dialogStartTime = performance.now();

    this.logger.log(`Playing dialog: ${dialog.id}`);

    if (this.onDialogStart) {
      this.onDialogStart(dialog);
    }

    // Load and play audio with LipSyncManager
    if (dialog.audio && this.lipSyncManager) {
      try {
        this.logger.log(`Loading audio: ${dialog.audio}`);
        await this.lipSyncManager.loadAudio(dialog.audio);
        this.logger.log("Audio loaded, starting playback...");
        this.lipSyncManager.play();
      } catch (e) {
        this.logger.error(`Failed to load audio: ${e}`);
      }
    } else {
      this.logger.warn(
        `No audio or lipSyncManager - audio: ${dialog.audio}, lipSync: ${!!this
          .lipSyncManager}`
      );
    }

    // Start caption/playback loop
    this._startPlaybackLoop();
  }

  _startPlaybackLoop() {
    // Playback is now driven by update() method called from ECS system each frame
    // Just set a flag that we're playing - actual updates happen in update()
    this._playbackActive = true;
  }

  /**
   * Update playback state - call this from ECS system update() each frame
   */
  _updatePlayback() {
    if (!this.isPlaying || !this._playbackActive || this._pausedForXR) return;

    // Check if captions are enabled
    const captionsEnabled = gameState?.getState?.()?.captionsEnabled ?? true;

    // Get current time from audio or elapsed time
    let currentTimeMs;
    if (this.lipSyncManager?.audioElement) {
      currentTimeMs = this.lipSyncManager.audioElement.currentTime * 1000;

      // Check if audio ended
      if (this.lipSyncManager.audioElement.ended) {
        this._handleDialogComplete();
        return;
      }
    } else {
      currentTimeMs = performance.now() - this.dialogStartTime;
    }

    // Update caption display
    if (captionsEnabled && this.captions.length > 0) {
      const captionIndex = this._findCaptionIndex(currentTimeMs);

      if (captionIndex !== this.currentCaptionIndex) {
        this.currentCaptionIndex = captionIndex;

        if (captionIndex >= 0 && captionIndex < this.captions.length) {
          const caption = this.captions[captionIndex];
          this._renderCaption(caption.text);
          this.captionMesh.visible = true;

          if (this.onCaptionChange) {
            this.onCaptionChange(caption, captionIndex);
          }
        } else {
          this._clearCanvas();
          this.captionMesh.visible = false;
        }
      }
    } else {
      this.captionMesh.visible = false;
    }

    // Check if dialog is complete (no audio, just captions)
    if (
      !this.lipSyncManager?.audioElement &&
      this._isDialogComplete(currentTimeMs)
    ) {
      this._handleDialogComplete();
      return;
    }

    // Update lip sync analysis
    if (this.lipSyncManager) {
      this.lipSyncManager.updateAnalysis();
    }

    // Process timed events
    this._processTimedEvents(currentTimeMs / 1000);
  }

  _processTimedEvents(currentTimeSec) {
    if (!this.currentDialog?.timedEvents) return;

    for (const event of this.currentDialog.timedEvents) {
      const eventKey = `${this.currentDialog.id}_${event.time}`;
      if (this._firedEvents.has(eventKey)) continue;

      if (currentTimeSec >= event.time) {
        this._firedEvents.add(eventKey);
        this._fireTimedEvent(event);
      }
    }
  }

  _fireTimedEvent(event) {
    this.logger.log(`Timed event: ${event.type} at ${event.time}s`);

    if (event.type === "robotReaction" && event.robotName) {
      const robotSystem = this.world?.robotSystem;
      if (robotSystem) {
        robotSystem.showNameTagByName(event.robotName);
        robotSystem.triggerNamedRobotReaction(event.robotName, event.reaction);
      }
    } else if (event.callback) {
      event.callback(this.world, gameState);
    }
  }

  _findCaptionIndex(currentTimeMs) {
    let cumulativeTime = 0;

    for (let i = 0; i < this.captions.length; i++) {
      const caption = this.captions[i];
      const startTime =
        caption.startTime !== undefined
          ? caption.startTime * 1000
          : cumulativeTime;
      const duration = (caption.duration || 3.0) * 1000;
      const endTime = startTime + duration;

      if (currentTimeMs >= startTime && currentTimeMs < endTime) {
        return i;
      }

      if (caption.startTime === undefined) {
        cumulativeTime += duration;
      }
    }

    return -1;
  }

  _isDialogComplete(currentTimeMs) {
    if (this.captions.length === 0) return true;

    const lastCaption = this.captions[this.captions.length - 1];
    let lastCaptionEnd;

    if (lastCaption.startTime !== undefined) {
      lastCaptionEnd =
        (lastCaption.startTime + (lastCaption.duration || 3.0)) * 1000;
    } else {
      lastCaptionEnd = this.captions.reduce(
        (sum, c) => sum + (c.duration || 3.0) * 1000,
        0
      );
    }

    return currentTimeMs >= lastCaptionEnd;
  }

  _handleDialogComplete() {
    const completedDialog = this.currentDialog;

    this.logger.log(`Dialog complete: ${completedDialog?.id}`);

    // Stop playback
    this.isPlaying = false;
    this._playbackActive = false;

    // Hide captions
    this._clearCanvas();
    this.captionMesh.visible = false;

    // Stop lip sync
    if (this.lipSyncManager) {
      this.lipSyncManager.stop();
    }

    // Call dialog's onComplete
    if (completedDialog?.onComplete) {
      completedDialog.onComplete(gameState);
    }

    // Call manager's onDialogComplete
    if (this.onDialogComplete) {
      this.onDialogComplete(completedDialog);
    }

    this.currentDialog = null;

    // Handle playNext chaining
    if (completedDialog?.playNext) {
      const nextDialog = getDialogById(completedDialog.playNext);
      if (nextDialog) {
        if (nextDialog.delay && nextDialog.delay > 0) {
          this._scheduleDialog(nextDialog);
        } else {
          this.playDialog(nextDialog);
        }
        return; // Don't re-check if we're chaining to next dialog
      }
    }

    // Re-check for auto-play dialogs that might have been queued while playing
    const currentState = gameState?.getState?.();
    if (currentState) {
      this._checkAutoPlayDialogs(currentState);
    }
  }

  /**
   * Update method - call from ECS system update() each XR frame
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    // Skip updates when paused for XR
    if (this._pausedForXR) return;

    // Update pending delayed dialogs
    for (const [dialogId, pending] of this.pendingDialogs) {
      pending.timer += dt;

      if (pending.timer >= pending.delay) {
        this.pendingDialogs.delete(dialogId);
        this.playDialog(pending.dialog);
        break;
      }
    }

    // Update active dialog playback (captions, audio end detection)
    this._updatePlayback();
  }

  /**
   * Stop current dialog
   */
  stop() {
    this.isPlaying = false;
    this._playbackActive = false;
    this._pausedForXR = false;

    if (this.lipSyncManager) {
      this.lipSyncManager.stop();
    }

    this._clearCanvas();
    this.captionMesh.visible = false;
    this.currentDialog = null;
    this.currentCaptionIndex = -1;
  }

  /**
   * Pause dialog for XR exit/pause
   */
  _pauseForXR() {
    if (!this.isPlaying || this._pausedForXR) return;

    this._pausedForXR = true;
    this.logger.log(`Pausing dialog for XR exit: ${this.currentDialog?.id}`);

    // Save current audio time and pause
    if (this.lipSyncManager?.audioElement) {
      this._pausedAudioTime = this.lipSyncManager.audioElement.currentTime;
      this.lipSyncManager.audioElement.pause();
    }

    // Hide captions
    if (this.captionMesh) {
      this.captionMesh.visible = false;
    }
  }

  /**
   * Resume dialog after XR re-entry
   */
  _resumeFromXR() {
    if (!this._pausedForXR) return;

    this._pausedForXR = false;
    this.logger.log(
      `Resuming dialog after XR entry: ${this.currentDialog?.id}`
    );

    // Resume audio from where we left off
    if (this.lipSyncManager?.audioElement && this.isPlaying) {
      this.lipSyncManager.audioElement.currentTime = this._pausedAudioTime;
      this.lipSyncManager.audioElement.play().catch((e) => {
        this.logger.warn(`Failed to resume audio: ${e}`);
      });
    }
  }

  /**
   * Set audio volume
   * @param {number} volume - Volume 0.0 to 1.0
   */
  setVolume(volume) {
    this.audioVolume = Math.max(0, Math.min(1, volume)) * this.baseVolume;
    // TODO: Apply to audio element if exists
  }

  /**
   * Check if dialog is currently playing
   * @returns {boolean}
   */
  isDialogPlaying() {
    return this.isPlaying;
  }

  destroy() {
    this.stop();

    if (this._stateHandler) {
      gameState.off("state:changed", this._stateHandler);
      this._stateHandler = null;
    }

    if (this.captionMesh) {
      this.captionMesh.parent?.remove(this.captionMesh);
      this.captionMesh.geometry?.dispose();
      this.captionMesh.material?.dispose();
      this.captionMesh = null;
    }

    if (this.textTexture) {
      this.textTexture.dispose();
      this.textTexture = null;
    }

    if (this.lipSyncManager) {
      this.lipSyncManager.destroy();
      this.lipSyncManager = null;
    }

    this.textCanvas = null;
    this.textContext = null;
  }
}
