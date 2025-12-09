/**
 * UIStateManager.js - CENTRALIZED UI VISIBILITY CONTROLLER
 * =============================================================================
 *
 * ROLE: Evaluates UIStateConfig rules each frame and applies visibility changes
 * to registered UI components. Single source of truth for which UI is visible.
 *
 * KEY RESPONSIBILITIES:
 * - Subscribe to game state changes
 * - Evaluate UIStateConfig rules to determine active panel
 * - Apply visibility changes to SpatialUIManager, RoomCaptureUI, etc.
 * - Track panel transitions for debugging
 * - Support runtime panel registration
 *
 * EVALUATION FLOW:
 * 1. Game state changes
 * 2. getActiveUIPanel() evaluates all panel criteria
 * 3. Highest priority matching panel becomes active
 * 4. _applyPanelState() shows/hides registered UIs accordingly
 *
 * REGISTERED UIs:
 * - wristUI: SpatialUIManager instance
 * - roomCaptureUI: RoomCaptureUI instance
 * - customPanels: Map for runtime-added panels
 *
 * USAGE: Created by AIManager, UIs register themselves after creation
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import { gameState, GAME_STATES } from "../gameState.js";
import { getActiveUIPanel, UI_PANELS } from "./UIStateConfig.js";
import { WRIST_UI_STATE } from "./SpatialUIManager.js";

export class UIStateManager {
  constructor(world, options = {}) {
    this.world = world;
    this.logger = new Logger("UIStateManager", options.debug ?? false);

    // References to managed UIs (set via register methods)
    this.wristUI = null;
    this.roomCaptureUI = null;
    this.customPanels = {}; // For runtime-added panels

    // Current active panel tracking
    this.activePanel = null;
    this.previousPanel = null;

    // Bind and subscribe to game state changes
    this._boundOnStateChange = this._onGameStateChange.bind(this);
    gameState.on("state:changed", this._boundOnStateChange);

    this.logger.log("UIStateManager initialized");
  }

  /**
   * Register the SpatialUIManager instance
   */
  registerWristUI(wristUI) {
    this.wristUI = wristUI;
    this.logger.log("WristUI registered");
    this._evaluateAndApply();
  }

  /**
   * Register the RoomCaptureUI instance
   */
  registerRoomCaptureUI(roomCaptureUI) {
    this.roomCaptureUI = roomCaptureUI;
    this.logger.log("RoomCaptureUI registered");
    this._evaluateAndApply();
  }

  /**
   * Register a custom panel with its own criteria
   */
  registerCustomPanel(panelId, config, showFn, hideFn) {
    this.customPanels[panelId] = {
      ...config,
      show: showFn,
      hide: hideFn,
    };
    this.logger.log(`Custom panel registered: ${panelId}`);
    this._evaluateAndApply();
  }

  /**
   * Unregister a custom panel
   */
  unregisterCustomPanel(panelId) {
    delete this.customPanels[panelId];
    this._evaluateAndApply();
  }

  /**
   * Called when game state changes - re-evaluate UI visibility
   */
  _onGameStateChange(newState, oldState) {
    this._evaluateAndApply();
  }

  /**
   * Evaluate current game state and apply appropriate UI visibility
   */
  _evaluateAndApply() {
    const state = gameState.getState();
    const result = getActiveUIPanel(state, this.customPanels);

    const newPanelId = result.panelId;
    const oldPanelId = this.activePanel;

    // Debug: log what we're evaluating
    if (state.interpretMode === "modem_stay" || state.voiceInputEnabled) {
      this.logger.log(
        `Evaluating: interpretMode=${state.interpretMode}, voiceInputEnabled=${state.voiceInputEnabled}, callAnswered=${state.callAnswered}, introPlayed=${state.introPlayed}`
      );
      this.logger.log(
        `Result: panelId=${result.panelId}, wristUIState=${result.wristUIState}`
      );
    }

    // Debug: log room capture state
    if (state.roomSetupRequired === true) {
      this.logger.log(
        "roomSetupRequired=true, evaluatedPanel:",
        newPanelId,
        "roomCaptureUI:",
        !!this.roomCaptureUI
      );
    }

    // Log panel changes
    if (newPanelId !== oldPanelId) {
      this.logger.log(
        `UI Panel: ${oldPanelId || "none"} -> ${newPanelId || "none"}`
      );
    }

    this.previousPanel = oldPanelId;
    this.activePanel = newPanelId;

    // Always apply state to ensure correct visibility
    // SpatialUIManager.setState handles deduplication internally
    this._applyPanelState(result);
  }

  /**
   * Apply the determined panel state to all UIs
   */
  _applyPanelState(result) {
    const { panelId, config, wristUIState, exclusive } = result;

    // Handle RoomCaptureUI
    if (
      panelId === UI_PANELS.ROOM_CAPTURE ||
      panelId === UI_PANELS.ROOM_CAPTURE_FAILED
    ) {
      this._showRoomCapture();
    } else {
      this._hideRoomCapture();
    }

    // Handle WristUI state - ALWAYS set state to ensure correct visibility
    if (this.wristUI) {
      const targetState =
        exclusive && panelId !== null
          ? WRIST_UI_STATE.HIDDEN
          : wristUIState || WRIST_UI_STATE.HIDDEN;

      // setState handles deduplication internally
      this.wristUI.setState(targetState);

      // Handle world vs HUD call panel preference
      if (config?.useHUDCallPanel && this.wristUI.switchToHUDCallPanel) {
        this.wristUI.switchToHUDCallPanel();
      }
    }

    // Handle custom panels
    for (const [customId, customConfig] of Object.entries(this.customPanels)) {
      if (customId === panelId) {
        customConfig.show?.();
      } else {
        customConfig.hide?.();
      }
    }
  }

  _showRoomCapture() {
    if (!this.roomCaptureUI) {
      this.logger.log("_showRoomCapture: roomCaptureUI not registered yet");
      return;
    }
    if (!this.roomCaptureUI.isVisible) {
      this.logger.log("_showRoomCapture: showing room capture UI");
      this.roomCaptureUI.show();
      this.logger.log("RoomCaptureUI shown");
    }
  }

  _hideRoomCapture() {
    if (this.roomCaptureUI && this.roomCaptureUI.isVisible) {
      this.roomCaptureUI.hide();
      this.logger.log("RoomCaptureUI hidden");
    }
  }

  /**
   * Force a re-evaluation (useful after async operations complete)
   */
  refresh() {
    this._evaluateAndApply();
  }

  /**
   * Get the current active panel ID
   */
  getActivePanel() {
    return this.activePanel;
  }

  /**
   * Check if a specific panel is currently active
   */
  isPanelActive(panelId) {
    return this.activePanel === panelId;
  }

  destroy() {
    gameState.off("state:changed", this._boundOnStateChange);
    this.wristUI = null;
    this.roomCaptureUI = null;
    this.customPanels = {};
  }
}
