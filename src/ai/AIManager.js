/**
 * AIManager.js - CENTRAL ORCHESTRATOR for AI/CV and voice interaction
 * =============================================================================
 *
 * ROLE: The main ECS system that coordinates all AI-related subsystems including
 * object detection, depth processing, voice input, and 3D model generation.
 * This is the entry point for camera-based scene understanding.
 *
 * KEY RESPONSIBILITIES:
 * - ECS system lifecycle (init, update, destroy)
 * - Coordinates specialized managers (ObjectTracker, DepthProcessor, LabelManager, etc.)
 * - Voice recording flow: capture audio -> transcribe (Whisper) -> interpret (Llama)
 * - Object detection pipeline: camera frame -> SAM3 API -> depth fusion -> tracking
 * - Game state transitions and XR module initialization
 * - Wrist UI and dialog management for user interaction
 *
 * MANAGER DELEGATION PATTERN:
 * AIManager owns instances of specialized modules and coordinates their lifecycle:
 *   - apiClient: HTTP calls to SAM3/Whisper/Llama backend
 *   - cameraCapture: Frame capture and intrinsics extraction
 *   - depthProcessor: Depth map to 3D position conversion
 *   - objectTracker: Multi-view tracking with uncertainty
 *   - labelManager/wireframeManager: Visual feedback for detections
 *   - inputHandler: Gamepad button polling
 *
 * CONFIGURATION: AIManagerConfig exported object controls which submodules are enabled.
 * Set from index.js before system registration.
 *
 * KNOWN ISSUES:
 * - Large file (~1000 lines) - consider further decomposition
 * =============================================================================
 */

import {
  createSystem,
  Transform,
  PanelUI,
  PanelDocument,
  VisibilityState,
  CameraSource,
  Interactable,
  Pressed,
} from "@iwsdk/core";
import { Logger } from "../utils/Logger.js";
import { GAME_STATES, gameState } from "../gameState.js";
import {
  IS_EMULATOR,
  USE_TEST_IMAGE_IN_EMULATOR,
  TRACKING_CONFIG,
} from "./config.js";

// Import modules (lazy-loaded when needed)
import { ApiClient } from "./ApiClient.js";
import { DebugVisualizer } from "./DebugVisualizer.js";
import { CameraCapture } from "./CameraCapture.js";
import { ObjectTracker } from "./ObjectTracker.js";
import { LabelManager } from "./LabelManager.js";
import { WireframeManager } from "./WireframeManager.js";
import { DepthProcessor } from "./DepthProcessor.js";
import { ModelGenerator } from "./ModelGenerator.js";
import { VoiceRecorder } from "../utils/VoiceRecorder.js";
import { InputHandler } from "./InputHandler.js";
import { SpatialUIManager } from "../ui/SpatialUIManager.js";
import { DialogManager } from "../ui/DialogManager.js";
import { KeyboardManager } from "../utils/KeyboardManager.js";
import { UIStateManager } from "../ui/UIStateManager.js";

/**
 * AIManager Configuration - set from index.js before system registration
 * This allows index.js to control which submodules are enabled
 */
export const AIManagerConfig = {
  enableVoicePanel: true,
  enableDebugVisualizer: true,
  enableVoiceRecording: true,
};

export class AIManager extends createSystem({
  voicePanelReady: { required: [PanelUI, Transform] },
  camera: { required: [CameraSource] },
  labelClicked: { required: [Interactable, Pressed] },
}) {
  /**
   * System initialization - called when system is registered
   * Only initializes minimal state; XR-dependent resources are deferred
   */
  init() {
    this.logger = new Logger("AIManager", false);
    this.logger.log("System initializing...");
    this.logger.log("Config:", JSON.stringify(AIManagerConfig));

    // Register on world for other systems to access
    this.world.aiManager = this;

    this.player = this.world.player || this.world.getPlayer?.();
    this.isEmulator = IS_EMULATOR;
    this.useTestImage = USE_TEST_IMAGE_IN_EMULATOR && IS_EMULATOR;

    // Track initialization state
    this._xrInitialized = false;
    this._modulesInitialized = false;

    // Null references for deferred modules
    this.mountEntity = null;
    this.voicePanelEntity = null;
    this.voicePanelDocument = null;
    this.debugVisualizer = null;

    // Wrist UI Manager
    this.dialogManager = null;
    this.wristUI = null;
    this.uiStateManager = null; // Centralized UI visibility control

    // Initialize lightweight modules immediately (no XR dependency)
    this._initCoreModules();

    // Subscribe to game state changes
    this._boundOnStateChange = this._onGameStateChange.bind(this);
    gameState.on("state:changed", this._boundOnStateChange);

    // Initialize state
    this._initState();

    // Subscribe to camera entity (if not emulator)
    this._setupCameraSubscription();

    // Subscribe to label click events
    this._setupLabelClickSubscription();

    this.logger.log("System initialized (XR modules deferred)");
  }

  /**
   * Initialize core modules that don't require XR
   */
  _initCoreModules() {
    this.apiClient = new ApiClient();
    this.cameraCapture = new CameraCapture(this.world, this.player);
    this.inputHandler = new InputHandler(this.world, null, this.player);
    this.depthProcessor = new DepthProcessor();

    // Trackers
    this.objectTracker = new ObjectTracker(TRACKING_CONFIG);
    this.videoObjectTracker = new ObjectTracker(TRACKING_CONFIG);

    // Label/wireframe managers
    this.labelManager = new LabelManager(
      this.world,
      this.player,
      TRACKING_CONFIG
    );
    this.videoLabelManager = new LabelManager(
      this.world,
      this.player,
      TRACKING_CONFIG
    );
    this.wireframeManager = new WireframeManager(this.world, TRACKING_CONFIG);
    this.videoWireframeManager = new WireframeManager(
      this.world,
      TRACKING_CONFIG
    );

    // Model generator
    this.modelGenerator = new ModelGenerator(
      this.world,
      this.player,
      this.apiClient
    );

    // Voice recorder (lightweight)
    if (AIManagerConfig.enableVoiceRecording) {
      this.voiceRecorder = new VoiceRecorder();
    }

    // Wrist panel will be created when START_SCREEN state is reached
    // (after startScreen loads, so Horizon Kit context is ready)
    this._wristPanelCreated = false;

    this.setupTrackerCallbacks();
  }

  /**
   * Initialize XR-dependent modules - called when XR becomes active
   */
  _initXRModules() {
    if (this._xrInitialized) return;

    this.logger.log("Initializing XR-dependent modules...");

    // Voice panel was created in _initCoreModules - just subscribe to ready event
    if (AIManagerConfig.enableVoicePanel && this.voicePanelEntity) {
      this.queries.voicePanelReady.subscribe("qualify", (entity) => {
        if (entity === this.voicePanelEntity) {
          this.logger.log(`Voice panel qualified: index=${entity.index}`);
        }
      });
    }

    // Debug visualizer
    if (AIManagerConfig.enableDebugVisualizer) {
      this.debugVisualizer = new DebugVisualizer(true);
    }

    this._xrInitialized = true;
    this.logger.log("XR modules initialized");
  }

  /**
   * Clean up XR modules when XR ends
   */
  _cleanupXRModules() {
    if (!this._xrInitialized) return;

    this.logger.log("Cleaning up XR modules...");

    this._xrInitialized = false;
  }

  /**
   * Handle game state changes
   */
  _onGameStateChange(newState, oldState) {
    const current = newState.currentState;
    const previous = oldState.currentState;

    // START_SCREEN reached - create SpatialUIManager (after startScreen loads, Horizon Kit ready)
    if (
      current === GAME_STATES.START_SCREEN &&
      !this._wristPanelCreated &&
      AIManagerConfig.enableVoicePanel
    ) {
      // Set flag BEFORE async work to prevent duplicate creation on rapid state changes
      this._wristPanelCreated = true;

      // Delay slightly to ensure startScreen panel is fully loaded
      setTimeout(async () => {
        // Create UIStateManager first - it will control UI visibility
        this.uiStateManager = new UIStateManager(this.world, { debug: true });

        // Create SpatialUIManager - use handedness from gameState (defaults to right)
        const currentHandedness = gameState.getState().handedness || "right";
        this.wristUI = new SpatialUIManager(this.world, {
          debug: true,
          preferHand: currentHandedness,
          onCallAnswered: () => {
            this.logger.log("Call answered - transitioning to PLAYING");
            gameState.setState({
              currentState: GAME_STATES.PLAYING,
              callAnswered: true,
            });
          },
          onCallEnded: () => this.logger.log("Call ended"),
        });
        await this.wristUI.initialize();

        // Register on world for direct access by other systems
        this.world.spatialUIManager = this.wristUI;

        // Register wristUI with UIStateManager for centralized control
        this.uiStateManager.registerWristUI(this.wristUI);

        // Create DialogManager for unified audio + captions + lip sync
        this.dialogManager = new DialogManager({
          world: this.world,
          player: this.player,
          debug: true,
          onFrameChange: (frame, uv) => {
            if (this.wristUI) {
              this.wristUI.updatePhonemeFrame(frame, uv);
            }
          },
          onDialogStart: (dialog) => {
            this.logger.log(`Dialog started: ${dialog.id}`);
            if (this.wristUI) {
              this.wristUI.showPhoneme();
              // Fade in call panel for dialogs that request it
              if (dialog.showCallPanel) {
                this.wristUI.fadeInCallPanel();
              }
            }
          },
          onDialogComplete: (dialog) => {
            this.logger.log(`Dialog complete: ${dialog?.id}`);
            if (this.wristUI) {
              // Fade out call panel for dialogs that showed it
              if (dialog?.showCallPanel) {
                this.wristUI.fadeOutCallPanel();
              }
            }
          },
        });
        await this.dialogManager.initialize();

        this.logger.log(
          "SpatialUIManager + DialogManager + UIStateManager created"
        );
      }, 100);
    }

    // XR became active - initialize XR modules
    // Use >= to handle debug spawn jumping directly to PORTAL_PLACEMENT
    if (current >= GAME_STATES.XR_ACTIVE && previous < GAME_STATES.XR_ACTIVE) {
      this._initXRModules();
      KeyboardManager.enableXRKeyboard();
      // UI visibility is handled by UIStateManager based on UIStateConfig
    }

    // XR ended - cleanup
    if (
      current === GAME_STATES.START_SCREEN &&
      previous >= GAME_STATES.XR_ACTIVE
    ) {
      KeyboardManager.disableXRKeyboard();
      // UI visibility is handled by UIStateManager based on UIStateConfig
    }
  }

  _initState() {
    this.isProcessing = false;
    this.trackedObjects = new Map();
    this.videoTrackedObjects = new Map();
    this.nextObjectId = 0;
    this.nextVideoObjectId = 0;
    this.imageCounter = 0;
    this.sessionId = null;
    this.frameIndex = 0;
    this.xrInput = null;
    this.cameraEntity = null;
    this.generating3D = false;
    this.lastXRFrame = null;
    this.capturedDepthData = null;
    this.pendingDepthCapture = null;
    this.isRecording = false;
    this.isProcessingVoice = false;
    this.recordingStartTime = null;
    this.recordedAudioBlob = null;
    this._panelButtonsSetup = false;
  }

  _setupCameraSubscription() {
    if (!IS_EMULATOR) {
      this.queries.camera.subscribe("qualify", (entity) => {
        this.logger.log("Camera entity qualified");
        this.cameraEntity = entity;
      });

      const existingCameras = Array.from(this.queries.camera.entities);
      if (existingCameras.length > 0) {
        this.cameraEntity = existingCameras[0];
      }
    }
  }

  _setupLabelClickSubscription() {
    this.queries.labelClicked.subscribe("qualify", (entity) => {
      this._handleLabelClick(entity);
    });
  }

  setupTrackerCallbacks() {
    const createCallbacks = (isVideoMode) => ({
      onCreateLabel: (objectId, tracked, mode) => {
        const manager = isVideoMode
          ? this.videoLabelManager
          : this.labelManager;
        manager.createLabel(objectId, tracked, mode);
      },
      onUpdateLabel: (objectId, tracked) => {
        const manager = tracked.isVideoMode
          ? this.videoLabelManager
          : this.labelManager;
        manager.updateLabel(objectId, tracked, tracked.isVideoMode);
      },
      onCreateWireframe: (objectId, tracked, mode) => {
        const manager = mode
          ? this.videoWireframeManager
          : this.wireframeManager;
        manager.createWireframeBox(objectId, tracked, mode, false);
        const hasNativePos =
          tracked.nativeFusedPosition || tracked.nativeWorldPosition;
        if (hasNativePos) {
          manager.createWireframeBox(objectId, tracked, mode, true);
        }
      },
      onUpdateWireframe: (objectId, tracked) => {
        const manager = tracked.isVideoMode
          ? this.videoWireframeManager
          : this.wireframeManager;
        manager.updateWireframeBox(objectId, tracked, tracked.isVideoMode);
      },
      onRemoveLabel: (objectId) => {
        this.labelManager.removeLabel(objectId);
        this.videoLabelManager.removeLabel(objectId);
      },
      onRemoveWireframe: (objectId) => {
        this.wireframeManager.removeWireframeBox(objectId);
        this.videoWireframeManager.removeWireframeBox(objectId);
      },
    });

    this.objectTracker.setCallbacks(createCallbacks(false));
    this.videoObjectTracker.setCallbacks(createCallbacks(true));
  }

  /**
   * Per-frame update - only runs heavy logic when XR is active
   */
  update(dt) {
    const state = gameState.getState();

    // Early exit if not in XR
    if (state.currentState < GAME_STATES.XR_ACTIVE) {
      return;
    }

    // Get XRInputManager from XrInputSystem if available
    this._updateXRInput();

    // Determine XR active state
    const isXRActive = state.currentState >= GAME_STATES.XR_ACTIVE;

    // Update InputHandler's xrInput reference
    if (this.inputHandler && this.xrInput) {
      if (this.inputHandler.xrInput !== this.xrInput) {
        this.inputHandler.setXRInput(this.xrInput);
      }
    }

    // Handle wrist UI attachment (new system)
    if (this.wristUI && this.xrInput && isXRActive) {
      this.wristUI.updateAttachment(this.xrInput, isXRActive);
    }

    // Update wrist UI for audio-reactive animations
    if (this.wristUI) {
      this.wristUI.update(dt);
    }

    // Update DialogManager for pending dialogs and playback
    if (this.dialogManager) {
      this.dialogManager.update(dt);
    }

    // Update ModelGenerator for fading indicators
    if (this.modelGenerator) {
      this.modelGenerator.update();
    }

    // Store latest XR frame
    if (isXRActive && this.world.renderer?.xr) {
      const xrFrame = this.world.renderer.xr.getFrame?.();
      if (xrFrame) {
        this.lastXRFrame = xrFrame;
      }
    }

    // Handle gamepad buttons with press-and-hold for voice recording
    this.inputHandler.pollGamepadButtons({
      onAButtonDown: () => {
        // Let room capture UI intercept A button first
        if (this.world.robotSystem?.roomSetupManager?.handleButtonPress("a"))
          return;
        // Let wristUI intercept A button next (for answering calls, etc.)
        if (this.wristUI?.handleButtonPress("a")) return;
        this._handleRecordButtonDown();
      },
      onAButtonUp: () => {
        this._handleRecordButtonUp();
      },
      onBButton: () => {
        // Let wristUI intercept B button first
        if (this.wristUI?.handleButtonPress("b")) return;
        this._resetAllObjects();
      },
    });

    // Update debug visualization planes
    if (this.debugVisualizer) {
      this.debugVisualizer.updateVisualizationPlanes(this.player);
    }

    // Sync recording state
    this._syncRecordingState();
  }

  _updateXRInput() {
    if (this.world.xrInputSystem?.xrInput) {
      if (this.xrInput !== this.world.xrInputSystem.xrInput) {
        this.xrInput = this.world.xrInputSystem.xrInput;
      }
    }
  }

  _syncRecordingState() {
    if (!this.voiceRecorder) return;

    const currentIsRecording = this.voiceRecorder.isRecording;
    if (this.isRecording !== currentIsRecording) {
      this.isRecording = currentIsRecording;
      if (!currentIsRecording) {
        this.recordingStartTime = null;
      }
    }
  }

  _handleRecordButtonDown() {
    // Only allow voice recording when voiceInputEnabled is true
    const state = gameState.getState();
    if (!state.voiceInputEnabled) {
      this.logger.log("Voice recording blocked - voiceInputEnabled is false");
      return;
    }

    if (state.currentState < GAME_STATES.PLAYING) {
      this.logger.log("Voice recording blocked - not in PLAYING state");
      return;
    }

    // Start recording on button down (block if already recording or processing)
    if (!this.isRecording && !this.isProcessingVoice) {
      this.startVoiceRecording();
    }
  }

  _handleRecordButtonUp() {
    // Stop recording and process on button release
    if (this.isRecording) {
      this.stopVoiceRecordingAndProcess();
    }
  }

  // Legacy toggle method for UI button clicks (backward compatibility)
  _handleRecordButtonClick() {
    if (this.isRecording) {
      this.stopVoiceRecordingAndProcess();
    } else {
      this._handleRecordButtonDown();
    }
  }

  _resetAllObjects() {
    this.logger.log("Resetting all tracked objects");
    this.objectTracker.resetAll(this.trackedObjects);
    this.labelManager.resetAll();
    this.wireframeManager.resetAll();
    this.videoObjectTracker.resetAll(this.videoTrackedObjects);
    this.videoLabelManager.resetAll();
    this.videoWireframeManager.resetAll();
    this.debugVisualizer?.removeAllVisualizationPlanes(this.world);
  }

  _handleLabelClick(entity) {
    this.world.hitTestManager?.markUIHit();

    const object3D = entity.object3D;
    if (!object3D?.userData) return;

    const { objectId, label, isVideoMode } = object3D.userData;
    if (!objectId || !label) return;

    this.logger.log(`Label clicked: ${label} (${objectId})`);

    if (this.generating3D) return;

    this._generate3DForObject(objectId, label, isVideoMode || false);
  }

  async _generate3DForObject(objectId, label, isVideoMode = false) {
    if (this.generating3D) return;

    this.generating3D = true;
    try {
      await this.modelGenerator.generate3DModel(
        objectId,
        label,
        this.cameraEntity,
        isVideoMode ? this.videoTrackedObjects : this.trackedObjects
      );
    } catch (error) {
      this.logger.error(`3D generation failed for ${label}:`, error);
    } finally {
      this.generating3D = false;
    }
  }

  async startVoiceRecording() {
    if (!this.voiceRecorder) return false;

    // Block recording during minigame
    if (gameState.getState().minigameActive) {
      this.logger.log("Voice recording blocked - minigame active");
      return false;
    }

    const started = await this.voiceRecorder.startVoiceRecording();
    if (started) {
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.wristUI?.setVoiceRecordingState("recording");
    }
    return started;
  }

  async stopVoiceRecordingAndProcess() {
    if (!this.voiceRecorder?.isRecording) return;

    this.wristUI?.setVoiceRecordingState("processing");
    this.isProcessingVoice = true;

    const audioBlob = await this.voiceRecorder.stopVoiceRecording();

    this.isRecording = false;
    this.recordedAudioBlob = audioBlob;

    if (audioBlob?.size > 0) {
      await this._processRecordedAudio(audioBlob);
    } else {
      // No audio recorded, reset to idle
      this.wristUI?.setVoiceRecordingState("idle");
    }
    this.isProcessingVoice = false;
  }

  async _processRecordedAudio(audioBlob) {
    try {
      // Step 1: Transcribe audio (OpenAI Whisper)
      let transcription;
      try {
        const transcribeResult = await this.apiClient.transcribeAudio(
          audioBlob
        );
        transcription = transcribeResult.transcription;
      } catch (error) {
        this.logger.warn("Transcription failed:", error.message);
        const errorMsg = error.message?.includes("400")
          ? "No speech detected"
          : "Transcription failed";
        this.wristUI?.showTranscription(errorMsg, "error");
        return;
      }

      // Show transcription immediately
      this.logger.log(`Transcribed: "${transcription}"`);
      this.wristUI?.showTranscription(transcription, "pending");

      // Notify robots that transcription was received - they should gather
      const robotSystem = this.world?.robotSystem;
      if (robotSystem) {
        robotSystem.onTranscription();
      }

      // Step 2: Interpret with Llama (slower, don't block UI)
      this._interpretTranscription(transcription);
    } catch (error) {
      this.logger.error("Error processing audio:", error);
      this.wristUI?.showTranscription("Error processing audio", "error");
    }
  }

  async _interpretTranscription(transcription) {
    try {
      const currentGameState = gameState.getState();
      const result = await this.apiClient.interpretText(
        transcription,
        null,
        currentGameState
      );
      this._handleInterpretResponse(result);
    } catch (error) {
      this.logger.warn("Interpretation failed:", error.message);

      // Still check for robot names even without Llama
      this._checkRobotNameInTranscription(transcription);

      const fallbackResult = {
        transcription: transcription,
        intent: "unknown",
        is_greeting: false,
        sentiment: {
          sentiment: "unknown",
          score: 0,
          is_rude: false,
          tone_description: "Llama unavailable",
        },
      };

      // Even if Llama fails, we already showed the transcription
      this.wristUI?.showInterpretResult(fallbackResult);

      // Notify robots with fallback result
      const robotSystem = this.world?.robotSystem;
      if (robotSystem) {
        robotSystem.onInterpretResponse(fallbackResult);
      }
    }
  }

  _checkRobotNameInTranscription(transcription) {
    if (!transcription) return;

    const robotSystem = this.world?.robotSystem;
    if (
      !robotSystem?.characterManager ||
      !robotSystem?.playerInteractionManager
    )
      return;

    const text = transcription.toLowerCase();
    const robotNames = ["modem", "blit", "baud"];

    for (const name of robotNames) {
      if (text.includes(name)) {
        const robot = robotSystem.characterManager.getByName(name);
        if (robot) {
          this.logger.log(
            `Robot name "${name}" detected in transcription - summoning robot ${robot.entityIndex}`
          );
          robotSystem.playerInteractionManager.summonRobot(robot.entityIndex);
          break; // Only summon one robot per transcription
        }
      }
    }
  }

  _handleInterpretResponse(result) {
    this.logger.log(
      `Interpretation: "${result.transcription}" -> ${result.intent} (greeting: ${result.is_greeting})`
    );

    // Check for robot names using corrected transcription if available
    const textToCheck = result.corrected_transcription || result.transcription;
    this._checkRobotNameInTranscription(textToCheck);

    const state = gameState.getState();
    this.logger.log(
      `Interpret result - interpretMode: ${state.interpretMode}, voiceInputEnabled: ${state.voiceInputEnabled}`
    );

    // Show result in wrist UI (pass interpretMode for different display)
    this.wristUI?.showInterpretResult(result, state.interpretMode);

    // Notify robots of interpretation result - they react based on intent/sentiment
    const robotSystem = this.world?.robotSystem;
    if (robotSystem) {
      robotSystem.onInterpretResponse(result);
      this.logger.log("Robot interpret response initiated");
    }

    // Handle based on current interpret mode
    if (state.voiceInputEnabled) {
      if (state.interpretMode === "reassurance") {
        // Reassurance mode: check if speech is reassuring/comforting
        const isReassuring =
          result.intent === "reassuring" ||
          (result.sentiment?.sentiment === "friendly" &&
            result.sentiment?.score > 0.3);

        this.logger.log(
          `Setting reassuranceResult: ${isReassuring ? "positive" : "negative"}`
        );
        gameState.setState({
          reassuranceResult: isReassuring ? "positive" : "negative",
        });

        // Trigger Baud reaction based on result
        this._triggerBaudReaction(isReassuring, result);
      } else if (state.interpretMode === "modem_stay") {
        // Modem stay mode: looking for yes/no answer
        const transcription = (
          result.corrected_transcription ||
          result.transcription ||
          ""
        ).toLowerCase();

        this.logger.log(`Modem stay check - transcription: "${transcription}"`);

        // Check for affirmative or negative responses
        // Expanded patterns to catch more natural responses
        const yesPatterns =
          /\b(yes|yeah|yep|yup|sure|okay|ok|of course|absolutely|definitely|please|stay|welcome|friend|can stay|love to|i'd love|would love|happy to|gladly)\b/i;
        const noPatterns =
          /\b(no|nope|nah|sorry|leave|go away|goodbye|bye|can't stay|cannot stay|have to go|must go|go home)\b/i;

        let modemStayResult = null;
        if (yesPatterns.test(transcription)) {
          modemStayResult = "yes";
        } else if (noPatterns.test(transcription)) {
          modemStayResult = "no";
        }

        this.logger.log(
          `Setting modemStayResult: ${modemStayResult || "non_answer"}`
        );

        if (modemStayResult) {
          // Clear yes/no answer
          gameState.setState({ modemStayResult });

          // Trigger Modem's reaction
          const robotSystem = this.world?.robotSystem;
          robotSystem?._handleModemStayResponse(modemStayResult === "yes");
        } else {
          // Non-answer - prompt again
          gameState.setState({ modemStayResult: "non_answer" });
        }
      } else {
        // Default greeting mode
        const isPositiveGreeting =
          result.is_greeting &&
          result.sentiment?.sentiment !== "negative" &&
          !result.sentiment?.is_rude;

        this.logger.log(
          `Setting greetingResult: ${
            isPositiveGreeting ? "positive" : "negative"
          }`
        );
        gameState.setState({
          greetingResult: isPositiveGreeting ? "positive" : "negative",
        });
      }
    }

    window._lastInterpretResult = result;
  }

  _triggerBaudReaction(isPositive, result) {
    const robotSystem = this.world?.robotSystem;
    if (!robotSystem) return;

    const baudResult = robotSystem.characterManager?.getByName("Baud");
    if (!baudResult) return;

    const { entityIndex } = baudResult;
    const voice = robotSystem.audioManager?.getVoice(entityIndex);
    const pim = robotSystem.playerInteractionManager;

    if (isPositive) {
      // Happy reaction - Baud is finally reassured!
      robotSystem.setRobotFaceEmotion(entityIndex, "HAPPY");
      voice?.happy?.();
      robotSystem.interactionManager?.triggerSoloAnimation(
        entityIndex,
        "happyBounce"
      );
      this.logger.log("Baud is happy - reassurance received!");

      // Clear reassurance mode and let Baud resume normal behavior
      pim?.clearReassurance(entityIndex);

      // Disable voice input and reset interpret mode after success
      gameState.setState({
        voiceInputEnabled: false,
        interpretMode: "greeting",
      });
    } else {
      // Sad reaction - but Baud stays and keeps waiting for reassurance
      robotSystem.setRobotFaceEmotion(entityIndex, "SAD");
      voice?.sad?.();
      this.logger.log("Baud is sad - still waiting for reassurance");

      // Baud stays in ATTENDING_PLAYER state with needsReassurance=true
      // (already set by setNeedsReassurance, just keep waiting)
    }
  }

  async _processVoiceSegmentation(audioBase64) {
    // Get camera frame for object detection
    let imageBase64 = null;
    let originalImageCanvas = null;

    if (!this.cameraEntity) {
      const existingCameras = Array.from(this.queries.camera.entities);
      if (existingCameras.length > 0) {
        this.cameraEntity = existingCameras[0];
      }
    }

    if (this.cameraEntity && this.cameraCapture) {
      let canvas = this.useTestImage
        ? await this.cameraCapture.loadTestImage()
        : this.cameraCapture.captureFrame(this.cameraEntity);

      if (canvas) {
        originalImageCanvas = canvas;
        const imageData = canvas.toDataURL("image/jpeg", 0.95);
        imageBase64 = imageData.split(",")[1];
      }
    }

    if (!imageBase64) {
      this.logger.warn("Camera frame required for voice segmentation");
      return;
    }

    const result = await this.apiClient.sendVoiceToAPI(
      imageBase64,
      audioBase64
    );
    this._handleApiResponse(result, originalImageCanvas);
  }

  _handleApiResponse(result, originalImageCanvas) {
    let detectedTerms = result.detected_terms;
    if (!detectedTerms && result.detections?.length > 0) {
      detectedTerms = result.detections.map((d) => d.label).filter(Boolean);
    }

    if (result.detections?.length > 0) {
      const headTransform = this.cameraCapture?.getHeadTransform();
      const cameraIntrinsics = this.cameraCapture?.getCameraIntrinsics?.(
        this.cameraEntity
      );
      const cameraExtrinsics = this.cameraCapture?.getCameraExtrinsics?.(
        this.cameraEntity
      );

      this.processVoiceAPIResponse(
        result,
        headTransform,
        cameraIntrinsics,
        cameraExtrinsics,
        originalImageCanvas
      );
    }
  }

  async processVoiceAPIResponse(
    response,
    headTransform,
    cameraIntrinsics,
    cameraExtrinsics,
    originalImageCanvas
  ) {
    const detections = response.detections || [];
    if (detections.length === 0) return;

    let depthMap = null;
    let imageWidth = 1280;
    let imageHeight = 960;

    if (response.depth_map) {
      try {
        depthMap = await this.depthProcessor.loadDepthMap(response.depth_map);
      } catch (error) {
        this.logger.error("Error loading depth map:", error);
      }
    }

    if (this.cameraEntity) {
      const CameraSourceModule = (await import("@iwsdk/core")).CameraSource;
      const videoElement =
        CameraSourceModule.data.videoElement?.[this.cameraEntity.index];
      if (videoElement) {
        imageWidth = videoElement.videoWidth || imageWidth;
        imageHeight = videoElement.videoHeight || imageHeight;
      }
    }

    await this.updateTracking(
      detections,
      depthMap
        ? { depthMap, imageWidth, imageHeight, masks: response.masks }
        : null,
      headTransform,
      cameraIntrinsics,
      cameraExtrinsics,
      false
    );

    this.objectTracker.decayTrackingConfidence(detections, this.trackedObjects);
    this.objectTracker.cleanupLowConfidenceObjects(this.trackedObjects);
  }

  async updateTracking(
    detections,
    imageData,
    headTransform,
    cameraIntrinsics,
    cameraExtrinsics,
    isVideoMode
  ) {
    const trackedObjectsMap = isVideoMode
      ? this.videoTrackedObjects
      : this.trackedObjects;
    const matchedObjectIds = new Set();

    for (const detection of detections) {
      const label = detection.label || "object";
      const detectionScore = detection.score || 0.5;

      let worldPosResult = null;
      let nativeWorldPosResult = null;

      if (imageData?.depthMap) {
        let maskData = null;
        if (imageData.masks && detection.mask_index !== undefined) {
          maskData = await this.depthProcessor.loadMask(
            imageData.masks[detection.mask_index]
          );
        }

        worldPosResult = this.depthProcessor.calculateWorldPosition(
          detection,
          imageData.depthMap,
          imageData.imageWidth,
          imageData.imageHeight,
          headTransform,
          cameraIntrinsics,
          cameraExtrinsics,
          maskData
        );

        try {
          nativeWorldPosResult =
            await this.depthProcessor.calculateNativeDepthPosition(
              detection,
              imageData.imageWidth,
              imageData.imageHeight,
              headTransform,
              cameraIntrinsics,
              cameraExtrinsics,
              maskData
            );
        } catch (error) {
          // Native depth calculation failed
        }
      }

      const worldPos = worldPosResult?.position;
      if (!worldPos) continue;

      const tracker = isVideoMode
        ? this.videoObjectTracker
        : this.objectTracker;

      const matchedObjectId = tracker.matchToTrackedObject(
        label,
        worldPos,
        detectionScore,
        trackedObjectsMap,
        matchedObjectIds
      );

      if (matchedObjectId) {
        tracker.updateTrackedObject(
          matchedObjectId,
          worldPos,
          worldPosResult?.depth,
          detectionScore,
          headTransform,
          cameraIntrinsics,
          detection.bbox,
          trackedObjectsMap,
          nativeWorldPosResult?.position,
          nativeWorldPosResult?.depth,
          worldPosResult?.ray,
          worldPosResult?.uncertainty || 0.1
        );
        matchedObjectIds.add(matchedObjectId);
      } else {
        const newObjectId = tracker.createTrackedObject(
          label,
          worldPos,
          worldPosResult?.depth,
          detectionScore,
          headTransform,
          cameraIntrinsics,
          detection.bbox,
          detection.mask_index,
          isVideoMode,
          trackedObjectsMap,
          nativeWorldPosResult?.position,
          nativeWorldPosResult?.depth,
          worldPosResult?.ray,
          worldPosResult?.uncertainty || 0.1
        );
        matchedObjectIds.add(newObjectId);
      }
    }
  }

  /**
   * Clean up when system is destroyed
   */
  destroy() {
    gameState.off("state:changed", this._boundOnStateChange);
    this.logger.log("System destroyed");
  }
}
