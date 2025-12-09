/**
 * SpatialUIManager.js - CENTRAL ORCHESTRATOR FOR SPATIAL UI
 * =============================================================================
 *
 * Central orchestrator that composes SpatialMountManager, PanelRegistry, and
 * individual panel UIs (CallPanelUI, TranslatorUI, ScorePanelUI). Maintains
 * the state machine and routes state changes to appropriate panels.
 *
 * This is the main entry point for spatial UI - external code interacts with
 * this class which delegates to the specialized sub-modules.
 *
 * STATE MACHINE (WRIST_UI_STATE):
 * HIDDEN -> INCOMING_CALL -> ACTIVE_CALL -> VOICE_INPUT
 * =============================================================================
 */

import { Vector3 } from "three";
import { Logger } from "../utils/Logger.js";
import { gameState, GAME_STATES } from "../gameState.js";
import { SpatialMountManager, ATTACHMENT_MODE } from "./SpatialMountManager.js";
import { PanelRegistry, PANEL_DEFS } from "./PanelRegistry.js";
import { CallPanelUI, CALL_STATE } from "./CallPanelUI.js";
import { TranslatorUI } from "./TranslatorUI.js";
import { ScorePanelUI } from "./ScorePanelUI.js";
import { hapticManager } from "../utils/HapticManager.js";
import { uiAudio } from "../audio/UIAudio.js";

export const WRIST_UI_STATE = {
  HIDDEN: "hidden",
  INCOMING_CALL: "incoming_call",
  ACTIVE_CALL: "active_call",
  PORTAL_PLACEMENT: "portal_placement",
  VOICE_INPUT: "voice_input",
};

// Re-export for backward compatibility
export { ATTACHMENT_MODE };

// State -> which panels are visible
const STATE_PANELS = {
  [WRIST_UI_STATE.HIDDEN]: [],
  [WRIST_UI_STATE.INCOMING_CALL]: ["call"],
  [WRIST_UI_STATE.ACTIVE_CALL]: ["call"],
  [WRIST_UI_STATE.PORTAL_PLACEMENT]: ["call", "portalPlacement"],
  [WRIST_UI_STATE.VOICE_INPUT]: ["call", "voice"],
};

// State -> mount overrides
const STATE_MOUNT_OVERRIDES = {
  [WRIST_UI_STATE.INCOMING_CALL]: { call: ATTACHMENT_MODE.WRIST },
  [WRIST_UI_STATE.ACTIVE_CALL]: { call: ATTACHMENT_MODE.CENTER },
};

export class SpatialUIManager {
  constructor(world, options = {}) {
    this.world = world;
    this.logger = new Logger("SpatialUI", options.debug ?? false);

    this.currentState = WRIST_UI_STATE.HIDDEN;
    this.previousState = null;

    // Compose sub-modules
    this.mountManager = new SpatialMountManager(world, options);
    this.registry = new PanelRegistry(world, this.mountManager, options);
    this.callUI = new CallPanelUI(this.registry, this.mountManager, options);
    this.voiceUI = new TranslatorUI(this.registry, options);
    this.scoreUI = new ScorePanelUI(this.registry, this.mountManager, options);

    // Callbacks
    this.onCallAnswered = options.onCallAnswered || null;
    this.onCallEnded = options.onCallEnded || null;

    // World mode tracking for call panel (using separate callWorld panel)
    this._callPanelWorldMode = false;
    this._worldFadeDuration = 0.5; // seconds - matches position lerp timing

    // Voice panel active (outside state machine)
    this._voicePanelActive = false;

    // Dialog call panel active (for showCallPanel dialogs during minigame)
    this._dialogCallPanelActive = false;

    // Throttle for render settings enforcement (UIKit creates meshes dynamically)
    this._renderSettingsCounter = 0;
    this._renderSettingsInterval = 10; // Every N frames

    this._setupGameStateListener();
  }

  _setupGameStateListener() {
    gameState.on("state:changed", (newState, oldState) => {
      if (newState.introPlayed && !oldState.introPlayed) {
        this.logger.log("Intro complete - moving call panel to HUD");
        this.registry.reparentPanel("call", ATTACHMENT_MODE.HUD);
        if (this.currentState === WRIST_UI_STATE.ACTIVE_CALL) {
          this.mountManager.setMountVisibility(ATTACHMENT_MODE.CENTER, false);
          this.mountManager.setMountVisibility(ATTACHMENT_MODE.HUD, true);
        }
      }

      if (newState.voiceInputEnabled && !oldState.voiceInputEnabled) {
        this.logger.log("Voice input enabled - showing voice panel on wrist");
        this._voicePanelActive = true;
        this.registry.createPanel("voice", ATTACHMENT_MODE.WRIST).then(() => {
          this.registry.fadeInPanel("voice", 0.75);
          hapticManager.pulseBoth(0.8, 80);
          setTimeout(() => hapticManager.pulseBoth(0.8, 80), 120);
        });
      }

      // Handle input mode changes (controllers vs hands)
      if (newState.inputMode !== oldState.inputMode) {
        this.logger.log(
          `Input mode changed: ${oldState.inputMode} -> ${newState.inputMode}`
        );
        this._updateInputModeUI(newState.inputMode);
      }

      // Handle handedness changes (which wrist the UI appears on)
      if (newState.handedness !== oldState.handedness) {
        this.logger.log(
          `Handedness changed: ${oldState.handedness} -> ${newState.handedness}`
        );
        this.mountManager.setPreferHand(newState.handedness);
      }
    });
  }

  _updateInputModeUI(inputMode) {
    this.callUI.updateInputModeUI(inputMode);
    this.voiceUI.updateInputModeUI(inputMode);
  }

  async initialize() {
    this.mountManager.createMountGroups();
    this.logger.log("SpatialUIManager initialized");
  }

  syncToGameState(state) {
    this.logger.log(
      `Syncing to game state: currentState=${state.currentState}, voiceInputEnabled=${state.voiceInputEnabled}, inputMode=${state.inputMode}`
    );

    if (state.voiceInputEnabled) {
      this.setState(WRIST_UI_STATE.VOICE_INPUT);
      this.logger.log("Synced to VOICE_INPUT state");
    } else if (state.currentState >= GAME_STATES.PLAYING) {
      this.setState(WRIST_UI_STATE.ACTIVE_CALL);
      this.logger.log("Synced to ACTIVE_CALL state");
    }

    // Sync input mode on init (hands vs controllers)
    if (state.inputMode) {
      this._updateInputModeUI(state.inputMode);
    }
  }

  _getMountModeForPanel(panelKey) {
    const state = gameState.getState();

    // callWorld always uses WORLD mount
    if (panelKey === "callWorld") {
      return ATTACHMENT_MODE.WORLD;
    }

    // "call" panel NEVER goes to world - stays in HUD
    const overrides = STATE_MOUNT_OVERRIDES[this.currentState] || {};
    if (overrides[panelKey]) {
      if (panelKey === "call" && state.introPlayed) {
        return ATTACHMENT_MODE.HUD;
      }
      return overrides[panelKey];
    }

    const def = PANEL_DEFS[panelKey];
    return def?.mount || ATTACHMENT_MODE.WRIST;
  }

  _getPanelsForState(state) {
    return STATE_PANELS[state] || [];
  }

  async setState(newState) {
    if (newState === this.currentState) return;

    this.logger.log(`State: ${this.currentState} -> ${newState}`);
    this.previousState = this.currentState;
    this.currentState = newState;

    if (newState === WRIST_UI_STATE.INCOMING_CALL) {
      // Only play ring if it hasn't been played yet (prevents re-ring on XR re-entry)
      if (!gameState.getState().callRingPlayed) {
        uiAudio.callRing();
        gameState.setState({ callRingPlayed: true });
      }
    } else if (newState === WRIST_UI_STATE.VOICE_INPUT) {
      uiAudio.voiceStart();
    } else if (
      newState === WRIST_UI_STATE.HIDDEN &&
      this.previousState !== null
    ) {
      uiAudio.panelClose();
    }

    const visiblePanels = this._getPanelsForState(newState);

    // Update panel visibility (but preserve world panel when in world mode)
    for (const panelKey of Object.keys(this.registry.panels)) {
      // Skip callWorld - it's managed by world mode, not state machine
      if (panelKey === "callWorld") continue;

      // Skip "call" panel - it uses CallPanelUI's own fade system
      if (panelKey === "call") continue;

      const shouldShow = visiblePanels.includes(panelKey);
      this.registry.setPanelVisible(panelKey, shouldShow);
    }

    // Reparent panels to correct mounts
    for (const panelKey of visiblePanels) {
      const newMount = this._getMountModeForPanel(panelKey);
      this.registry.reparentPanel(panelKey, newMount);
    }

    // Update mount group visibility
    const activeMounts = new Set(
      visiblePanels.map((p) => this._getMountModeForPanel(p)).filter(Boolean)
    );
    this.mountManager.setMountVisibility(
      ATTACHMENT_MODE.WRIST,
      activeMounts.has(ATTACHMENT_MODE.WRIST)
    );
    this.mountManager.setMountVisibility(
      ATTACHMENT_MODE.HUD,
      activeMounts.has(ATTACHMENT_MODE.HUD)
    );
    this.mountManager.setMountVisibility(
      ATTACHMENT_MODE.CENTER,
      activeMounts.has(ATTACHMENT_MODE.CENTER)
    );

    if (newState === WRIST_UI_STATE.HIDDEN) {
      this.callUI.setState(CALL_STATE.HIDDEN);
      return;
    }

    // Create/show panels
    for (const panelKey of visiblePanels) {
      await this.registry.createPanel(
        panelKey,
        this._getMountModeForPanel(panelKey)
      );
      this.registry.setPanelVisible(panelKey, true);
      this.registry.forceVisibilityRefresh(panelKey);
    }

    // Update call panel state
    if (visiblePanels.includes("call")) {
      if (newState === WRIST_UI_STATE.INCOMING_CALL) {
        this.callUI.setState(CALL_STATE.INCOMING);
      } else if (
        newState === WRIST_UI_STATE.ACTIVE_CALL ||
        newState === WRIST_UI_STATE.VOICE_INPUT
      ) {
        this.callUI.setState(CALL_STATE.ACTIVE);
        if (newState === WRIST_UI_STATE.VOICE_INPUT) {
          this.callUI.setStatusText("LISTENING");
        }
      }
    }

    // Setup interactions when documents are ready
    this._setupInteractionsWhenReady();
  }

  _setupInteractionsWhenReady() {
    const callDoc = this.registry.getDocument("call");
    if (callDoc) {
      this.callUI.setupInteractions(() => this.endCall());
    }

    const voiceDoc = this.registry.getDocument("voice");
    if (voiceDoc) {
      this.voiceUI.setupInteractions(null);
    }
  }

  // Public API - Call Panel
  showIncomingCall(callerName = "Prof. Sea") {
    this.setState(WRIST_UI_STATE.INCOMING_CALL).then(() => {
      this.callUI.setCallerName(callerName);
    });
  }

  answerCall() {
    this.callUI.stopHapticPulse();
    uiAudio.callAnswer();
    hapticManager.pulseBoth(0.8, 80);
    this.setState(WRIST_UI_STATE.ACTIVE_CALL).then(() => {
      if (this.onCallAnswered) this.onCallAnswered();
    });
  }

  endCall() {
    uiAudio.callEnd();
    hapticManager.pulseBoth(0.5, 60);
    this.callUI.setState(CALL_STATE.HIDDEN);
    this.setState(WRIST_UI_STATE.HIDDEN);
    if (this.onCallEnded) this.onCallEnded();
  }

  showPhoneme() {
    this.callUI.showPhoneme();
  }

  updatePhonemeFrame(frameIndex, uv) {
    this.callUI.updatePhonemeFrame(frameIndex, uv);
  }

  async fadeInCallPanel() {
    // Ensure call panel exists and is on HUD mount (top-right)
    await this.registry.createPanel("call");
    this.registry.reparentPanel("call", ATTACHMENT_MODE.HUD);
    this.mountManager.setMountVisibility(ATTACHMENT_MODE.HUD, true);

    // Track that dialog panel is showing (for mount updates)
    this._dialogCallPanelActive = true;

    this.registry.setPanelVisible("call", true);
    this.registry.fadeInPanel("call", 0.3);
    this.callUI.setState(CALL_STATE.ACTIVE);
    this.logger.log("Call panel fading in for dialog (HUD mount)");
  }

  fadeOutCallPanel() {
    this.registry.fadePanel("call", 0, 0.3);
    this._dialogCallPanelActive = false;

    // After fade completes, hide the panel completely
    setTimeout(() => {
      if (!this._dialogCallPanelActive) {
        this.registry.setPanelVisible("call", false);
        // Only hide HUD mount if no other panels need it
        const visiblePanels = this._getPanelsForState(this.currentState);
        const needsHUD = visiblePanels.some(
          (p) => this._getMountModeForPanel(p) === ATTACHMENT_MODE.HUD
        );
        if (!needsHUD) {
          this.mountManager.setMountVisibility(ATTACHMENT_MODE.HUD, false);
        }
      }
    }, 350); // Slightly longer than fade duration

    this.logger.log("Call panel fading out after dialog");
  }

  // Public API - Voice Panel
  setVoiceRecordingState(state) {
    this.voiceUI.setRecordingState(state);
  }

  showTranscription(transcription, status = "pending") {
    this.voiceUI.showTranscription(transcription, status);
  }

  showInterpretResult(result, interpretMode = "greeting") {
    this.voiceUI.showInterpretResult(result, interpretMode);
  }

  // Public API - Score Panel
  async showScorePanel() {
    uiAudio.panelOpen();
    await this.scoreUI.show();
  }

  hideScorePanel() {
    uiAudio.panelClose();
    this.scoreUI.hide();
  }

  updateScoreDisplay(current, total) {
    uiAudio.scoreUp();
    hapticManager.pulseBoth(0.6, 50);
    this.scoreUI.updateDisplay(current, total);
  }

  // Public API - World Targeting (fades HUD panel out, shows world panel)
  async setCallPanelWorldTarget(
    position,
    surfaceNormal = new Vector3(0, 1, 0),
    options = {}
  ) {
    if (this._callPanelWorldMode) return;
    this._callPanelWorldMode = true;

    // Setup world mount position
    this.mountManager.setWorldTarget(position, surfaceNormal, options);

    // Create callWorld panel if not exists
    await this.registry.createPanel("callWorld");

    // Create world viseme
    this.callUI.createWorldViseme();

    // Fade IN the world panel from 0 to 1
    this.registry.fadeInPanel("callWorld", this._worldFadeDuration);

    this.logger.log(
      `World panel shown at (${position.x.toFixed(2)}, ${position.y.toFixed(
        2
      )}, ${position.z.toFixed(2)})`
    );
  }

  clearCallPanelWorldTarget() {
    if (!this._callPanelWorldMode) return;
    this._callPanelWorldMode = false;

    // Hide world viseme and fade out world panel
    this.callUI.hideWorldViseme();
    this.registry.fadePanel("callWorld", 0, this._worldFadeDuration);

    this.mountManager.clearWorldTarget();

    this.logger.log(`World panel hidden`);
  }

  /**
   * Switch from world call panel to HUD call panel
   * Used when minigame starts and we need to show the smaller corner panel
   */
  async switchToHUDCallPanel() {
    // Fade out world panel if active
    if (this._callPanelWorldMode) {
      this._callPanelWorldMode = false;
      this.callUI.hideWorldViseme();
      this.registry.fadePanel("callWorld", 0, this._worldFadeDuration);
      this.mountManager.clearWorldTarget();
      this.logger.log("World call panel faded out for minigame");
    }

    // Ensure call panel is on HUD mount and visible
    const panel = await this.registry.createPanel("call");
    this.registry.reparentPanel("call", ATTACHMENT_MODE.HUD);
    this.mountManager.setMountVisibility(ATTACHMENT_MODE.HUD, true);

    // Force panel visible and start fade from 0
    if (panel?.group) {
      panel.group.visible = true;
      this.logger.log(
        `HUD call panel group visible=${panel.group.visible}, parent=${panel.group.parent?.name}`
      );
    }

    // Fade in HUD call panel - use setPanelVisible first to ensure visibility
    this.registry.setPanelVisible("call", true);
    this.registry.fadeInPanel("call", this._worldFadeDuration);
    this.callUI.setState(CALL_STATE.ACTIVE);

    this.logger.log("Switched to HUD call panel");
  }

  // Public API - Button Handling
  handleButtonPress(button) {
    if (this.currentState === WRIST_UI_STATE.INCOMING_CALL && button === "a") {
      this.answerCall();
      return true;
    }

    if (this.currentState === WRIST_UI_STATE.ACTIVE_CALL && button === "b") {
      this.endCall();
      return true;
    }

    return false;
  }

  // Frame update - called every frame
  updateAttachment(xrInput, isXRActive) {
    this.registry.pollPendingDocuments((panelKey, doc) => {
      this._setupInteractionsWhenReady();
    });

    const visiblePanels = this._getPanelsForState(this.currentState);
    const activeMounts = new Set(
      visiblePanels.map((p) => this._getMountModeForPanel(p)).filter(Boolean)
    );

    // Add world mount if world panel is active or fading
    if (this._callPanelWorldMode || this.registry.isFading("callWorld")) {
      activeMounts.add(ATTACHMENT_MODE.WORLD);
    }

    // Add wrist mount if voice panel is active
    if (this._voicePanelActive || this.registry.isFading("voice")) {
      activeMounts.add(ATTACHMENT_MODE.WRIST);
    }

    // Add HUD mount if dialog call panel is active or fading
    if (this._dialogCallPanelActive || this.registry.isFading("call")) {
      activeMounts.add(ATTACHMENT_MODE.HUD);
    }

    const result = this.mountManager.updateMounts(
      xrInput,
      isXRActive,
      activeMounts
    );

    this.registry.updatePanelTransitions();

    // Update score panel animation and CALMED expiration check
    this.scoreUI.update();

    return result;
  }

  update(dt) {
    this.callUI.update(dt);
    this.voiceUI.update();
    this.registry.updateFadeAnimations(dt);

    this._renderSettingsCounter++;
    if (this._renderSettingsCounter >= this._renderSettingsInterval) {
      this._renderSettingsCounter = 0;
      this.registry.enforceRenderSettingsForVisiblePanels();
    }
  }

  // Legacy compatibility
  setAttachmentMode(mode) {
    // No-op for backward compatibility
  }

  get mountGroup() {
    return this.mountManager.wristMountGroup;
  }

  get documents() {
    return this.registry.documents;
  }

  get panels() {
    return this.registry.panels;
  }

  getMountGroup(mode) {
    return this.mountManager.getMountGroup(mode);
  }

  destroy() {
    this.callUI.destroy();
    this.voiceUI.destroy();
    this.scoreUI.destroy();
    this.registry.destroy();
    this.mountManager.destroy();
  }
}
