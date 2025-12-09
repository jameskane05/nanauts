/**
 * UIStateConfig.js - DECLARATIVE UI VISIBILITY RULES
 * =============================================================================
 *
 * ROLE: Centralized configuration defining when each UI panel should be visible
 * based on game state. Uses criteria matching (like MongoDB queries) to
 * declaratively specify visibility rules.
 *
 * KEY RESPONSIBILITIES:
 * - Define UI_PANELS enum for all managed panels
 * - Specify showWhen criteria for each panel
 * - Set priority levels for conflict resolution
 * - Define exclusive flag to suppress lower-priority panels
 * - Map panel states to WRIST_UI_STATE for SpatialUIManager
 *
 * CRITERIA MATCHING:
 * Uses checkCriteria() helper supporting operators: $gte, $lte, $eq, etc.
 * Example: { currentState: { $gte: GAME_STATES.XR_ACTIVE } }
 *
 * PRIORITY SYSTEM:
 * Higher priority panels take precedence. When exclusive=true, lower
 * priority panels are hidden. Used for room capture blocking other UI.
 *
 * PANEL DEFINITIONS:
 * - ROOM_CAPTURE_FAILED: Priority 200, blocks everything
 * - ROOM_CAPTURE: Priority 100, blocks normal UI
 * - INCOMING_CALL: Priority 50
 * - ACTIVE_CALL: Priority 40
 * - VOICE_INPUT: Priority 30
 *
 * USAGE: Imported by UIStateManager to evaluate active panel each frame
 * =============================================================================
 */

import { GAME_STATES } from "../gameState.js";
import { WRIST_UI_STATE } from "./SpatialUIManager.js";
import { checkCriteria } from "../utils/CriteriaHelper.js";

export const UI_PANELS = {
  XR_PAUSED: "xrPaused",
  ROOM_CAPTURE_FAILED: "roomCaptureFailed",
  ROOM_CAPTURE: "roomCapture",
  INCOMING_CALL: "incomingCall",
  ACTIVE_CALL: "activeCall",
  PORTAL_PLACEMENT: "portalPlacement",
  VOICE_INPUT: "voiceInput",
};

export const UI_STATE_CONFIG = {
  // XR Paused (system UI showing or headset removed) - highest priority
  // Hides all spatial UI while 2D start screen overlay is shown
  [UI_PANELS.XR_PAUSED]: {
    showWhen: {
      currentState: GAME_STATES.XR_PAUSED,
    },
    priority: 300,
    exclusive: true,
    wristUIState: WRIST_UI_STATE.HIDDEN,
  },

  // Room capture FAILED - highest priority, blocks everything permanently
  // Overrides ALL other states including debug spawn states
  [UI_PANELS.ROOM_CAPTURE_FAILED]: {
    showWhen: {
      currentState: { $gte: GAME_STATES.XR_ACTIVE }, // Any XR state
      roomCaptureFailed: true,
    },
    priority: 200, // Higher than everything else
    exclusive: true,
    wristUIState: WRIST_UI_STATE.HIDDEN,
  },

  // Room capture prompt - high priority, blocks other UI
  // Overrides ALL other states including debug spawn states
  [UI_PANELS.ROOM_CAPTURE]: {
    showWhen: {
      currentState: { $gte: GAME_STATES.XR_ACTIVE }, // Any XR state
      roomSetupRequired: true,
      roomCaptureFailed: false,
    },
    priority: 100,
    exclusive: true, // Hides all lower-priority UI when shown
    wristUIState: WRIST_UI_STATE.HIDDEN,
  },

  // Incoming call - shows after room setup, before intro
  [UI_PANELS.INCOMING_CALL]: {
    showWhen: {
      currentState: GAME_STATES.XR_ACTIVE,
      roomSetupRequired: false,
      introPlayed: false,
      callAnswered: false,
    },
    priority: 50,
    wristUIState: WRIST_UI_STATE.INCOMING_CALL,
  },

  // Active call - shows after answering (includes XR_ACTIVE for resume after XR re-entry)
  [UI_PANELS.ACTIVE_CALL]: {
    showWhen: {
      currentState: {
        $gte: GAME_STATES.XR_ACTIVE,
        $lte: GAME_STATES.PORTAL_PLACEMENT,
      },
      roomSetupRequired: false,
      callAnswered: true,
      voiceInputEnabled: false,
      robotsActive: false,
    },
    priority: 45, // Lower than PORTAL_PLACEMENT so hands mode takes precedence
    wristUIState: WRIST_UI_STATE.ACTIVE_CALL,
  },

  // Portal placement (hands) - shows portal placement panel on wrist
  [UI_PANELS.PORTAL_PLACEMENT]: {
    showWhen: {
      currentState: GAME_STATES.PORTAL_PLACEMENT,
      roomSetupRequired: false,
      robotsActive: false,
      inputMode: "hands",
    },
    priority: 50,
    wristUIState: WRIST_UI_STATE.PORTAL_PLACEMENT,
  },

  // Portal placement (controllers) - no wrist panel, just call panel in HUD
  [UI_PANELS.ACTIVE_CALL + "_placement"]: {
    showWhen: {
      currentState: GAME_STATES.PORTAL_PLACEMENT,
      roomSetupRequired: false,
      robotsActive: false,
      inputMode: "controllers",
    },
    priority: 50,
    wristUIState: WRIST_UI_STATE.ACTIVE_CALL,
  },

  // Voice input - only before robots spawn (world panel handles it after)
  [UI_PANELS.VOICE_INPUT]: {
    showWhen: {
      currentState: { $gte: GAME_STATES.XR_ACTIVE },
      roomSetupRequired: false,
      voiceInputEnabled: true,
      robotsActive: false, // HUD hidden once robots spawn (world panel takes over)
    },
    priority: 50,
    wristUIState: WRIST_UI_STATE.VOICE_INPUT,
  },

  // Voice input for Modem stay question (works with robots active)
  [UI_PANELS.VOICE_INPUT + "_modem"]: {
    showWhen: {
      currentState: { $gte: GAME_STATES.XR_ACTIVE },
      roomSetupRequired: false,
      voiceInputEnabled: true,
      interpretMode: "modem_stay",
    },
    priority: 55, // Higher than normal voice input
    wristUIState: WRIST_UI_STATE.VOICE_INPUT,
    useHUDCallPanel: true, // Force HUD call panel, hide world panel
  },
};

/**
 * Maps game state to which wrist UI state should be active.
 * Evaluated in priority order - first match wins.
 */
export function getActiveUIPanel(gameStateSnapshot, customPanels = {}) {
  const allConfigs = { ...UI_STATE_CONFIG, ...customPanels };

  // Sort by priority (highest first)
  const sortedPanels = Object.entries(allConfigs).sort(
    ([, a], [, b]) => (b.priority || 0) - (a.priority || 0)
  );

  for (const [panelId, config] of sortedPanels) {
    if (checkCriteria(gameStateSnapshot, config.showWhen)) {
      return {
        panelId,
        config,
        wristUIState: config.wristUIState || WRIST_UI_STATE.HIDDEN,
        exclusive: config.exclusive || false,
      };
    }
  }

  return {
    panelId: null,
    config: null,
    wristUIState: WRIST_UI_STATE.HIDDEN,
    exclusive: false,
  };
}
