/**
 * TranslatorUI.js - TRANSLATOR PANEL UI LOGIC
 * =============================================================================
 *
 * Handles translator panel functionality: recording state display,
 * transcription display, and interpret result display.
 *
 * RESPONSIBILITIES:
 * - Recording state UI (idle, recording, processing)
 * - Transcription display
 * - Interpret result display with success/fail styling
 * - Recording state styling
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import { gameState } from "../gameState.js";
import { uiAudio } from "../audio/UIAudio.js";
import { hapticManager } from "../utils/HapticManager.js";
import { ThumbTapRenderer } from "./ThumbTapRenderer.js";

const FADE_DURATION = 0.3; // seconds

export const VOICE_RECORDING_STATE = {
  IDLE: "idle",
  RECORDING: "recording",
  PROCESSING: "processing",
};

export class TranslatorUI {
  constructor(registry, options = {}) {
    this.registry = registry;
    this.logger = new Logger("TranslatorUI", options.debug ?? false);

    this.recordingState = VOICE_RECORDING_STATE.IDLE;
    this.inputMode = "controllers";

    this.thumbTap = new ThumbTapRenderer({
      size: 0.028,
      position: { x: 0.06, y: -0.0885, z: 0.01 },
    });
    this._thumbTapCreated = false;
    this._inputModeSynced = false;

    // Minigame disable state
    this._disabled = false;
    this._fadeProgress = 1; // 1 = fully visible, 0 = fully hidden
    this._targetFade = 1;

    // Listen for game state changes
    this._onStateChanged = this._onStateChanged.bind(this);
    gameState.on("state:changed", this._onStateChanged);
  }

  _onStateChanged(newState, oldState) {
    if (newState.minigameActive !== oldState.minigameActive) {
      if (newState.minigameActive) {
        this._disableForMinigame();
      } else {
        this._enableAfterMinigame();
      }
    }
  }

  _disableForMinigame() {
    this._disabled = true;
    this._targetFade = 0;
    this.logger.log("Disabling translator for minigame");

    // If currently recording, stop immediately
    if (this.recordingState !== VOICE_RECORDING_STATE.IDLE) {
      this.recordingState = VOICE_RECORDING_STATE.IDLE;
    }
  }

  _enableAfterMinigame() {
    this._disabled = false;
    this._targetFade = 1;
    this.logger.log("Re-enabling translator after minigame");
  }

  isDisabled() {
    return this._disabled;
  }

  getDocument() {
    return this.registry.getDocument("voice");
  }

  _clearPreviousResult() {
    const doc = this.getDocument();
    if (!doc) return;

    const transcriptionText = doc.getElementById("transcription-text");
    const resultText = doc.getElementById("result-text");
    const resultRow = doc.getElementById("result-row");

    if (transcriptionText) {
      transcriptionText.setProperties({ text: "", color: "#ffffff" });
    }
    if (resultText) {
      resultText.setProperties({ text: "", color: "#9ca3af" });
    }
    if (resultRow) {
      resultRow.setProperties({
        backgroundColor: "rgba(0, 70, 90, 0.5)",
        borderColor: "rgba(0, 200, 220, 0.3)",
      });
    }
  }

  setRecordingState(state) {
    const prevState = this.recordingState;
    this.recordingState = state;

    if (
      state === VOICE_RECORDING_STATE.RECORDING &&
      prevState !== VOICE_RECORDING_STATE.RECORDING
    ) {
      uiAudio.voiceStart();
      hapticManager.pulseBoth(0.7, 60);
      this._clearPreviousResult();
    } else if (
      state === VOICE_RECORDING_STATE.PROCESSING &&
      prevState === VOICE_RECORDING_STATE.RECORDING
    ) {
      uiAudio.voiceStop();
      hapticManager.pulseBoth(0.5, 40);
    }

    const doc = this.getDocument();
    if (!doc) {
      this.logger.warn("Voice document not ready for recording state update");
      return;
    }

    const statusDot = doc.getElementById("status-dot");
    const statusText = doc.getElementById("status-text");
    const promptRow = doc.getElementById("prompt-row");
    const buttonHint = doc.getElementById("button-hint");
    const promptText = doc.getElementById("prompt-text");

    const buttonLetter = doc.getElementById("button-letter");
    const isHands = this.inputMode === "hands";

    if (state === VOICE_RECORDING_STATE.RECORDING) {
      if (statusDot) statusDot.setProperties({ backgroundColor: "#ef4444" });
      if (statusText) statusText.setProperties({ text: "RECORDING" });
      if (promptRow)
        promptRow.setProperties({
          backgroundColor: "rgba(239, 68, 68, 0.3)",
          borderColor: "rgba(239, 68, 68, 0.7)",
        });
      if (buttonHint) {
        buttonHint.setProperties({
          backgroundColor: "#ef4444",
          display: isHands ? "none" : "flex",
        });
      }
      if (buttonLetter) buttonLetter.setProperties({ text: "A" });
      if (promptText)
        promptText.setProperties({ text: "RELEASE TO SEND", color: "#fca5a5" });
    } else if (state === VOICE_RECORDING_STATE.PROCESSING) {
      if (statusDot) statusDot.setProperties({ backgroundColor: "#f59e0b" });
      if (statusText) statusText.setProperties({ text: "PROCESSING" });
      if (promptRow)
        promptRow.setProperties({
          backgroundColor: "rgba(245, 158, 11, 0.3)",
          borderColor: "rgba(245, 158, 11, 0.7)",
        });
      if (buttonHint) {
        buttonHint.setProperties({
          backgroundColor: "#f59e0b",
          display: isHands ? "none" : "flex",
        });
      }
      if (buttonLetter) buttonLetter.setProperties({ text: "A" });
      if (promptText)
        promptText.setProperties({ text: "INTERPRETING...", color: "#fcd34d" });
    } else {
      // idle
      if (statusDot) statusDot.setProperties({ backgroundColor: "#4ade80" });
      if (statusText) statusText.setProperties({ text: "READY" });
      if (promptRow)
        promptRow.setProperties({
          backgroundColor: "rgba(0, 70, 90, 0.7)",
          borderColor: "rgba(0, 200, 220, 0.5)",
        });
      if (buttonHint) {
        buttonHint.setProperties({
          backgroundColor: "#00d4e6",
          display: isHands ? "none" : "flex",
        });
      }
      if (buttonLetter) buttonLetter.setProperties({ text: "A" });
      if (promptText)
        promptText.setProperties({
          text: this.getIdlePromptText(),
          color: "#00d4e6",
        });
    }
  }

  showTranscription(transcription, status = "pending") {
    const doc = this.getDocument();
    if (!doc) {
      this.logger.warn("Voice document not ready for transcription display");
      return;
    }

    const transcriptionText = doc.getElementById("transcription-text");
    const resultRow = doc.getElementById("result-row");
    const resultText = doc.getElementById("result-text");
    const statusDot = doc.getElementById("status-dot");
    const statusText = doc.getElementById("status-text");

    if (transcriptionText) {
      transcriptionText.setProperties({
        text: `"${transcription}"`,
        color: "#ffffff",
      });
    }

    if (status === "pending") {
      uiAudio.tick();
      if (resultRow)
        resultRow.setProperties({
          backgroundColor: "rgba(96, 165, 250, 0.2)",
          borderColor: "rgba(96, 165, 250, 0.5)",
        });
      if (resultText)
        resultText.setProperties({ text: "Interpreting...", color: "#fcd34d" });
      if (statusDot) statusDot.setProperties({ backgroundColor: "#60a5fa" });
      if (statusText) statusText.setProperties({ text: "INTERPRETING" });
    } else if (status === "error") {
      uiAudio.error();
      hapticManager.pulseBoth(0.6, 60);
      if (resultRow)
        resultRow.setProperties({
          backgroundColor: "rgba(239, 68, 68, 0.2)",
          borderColor: "rgba(239, 68, 68, 0.5)",
        });
      if (resultText)
        resultText.setProperties({ text: transcription, color: "#ef4444" });
      if (statusDot) statusDot.setProperties({ backgroundColor: "#ef4444" });
      if (statusText) statusText.setProperties({ text: "ERROR" });

      // Reset prompt UI back to idle
      const promptRow = doc.getElementById("prompt-row");
      const buttonHint = doc.getElementById("button-hint");
      const buttonLetter = doc.getElementById("button-letter");
      const promptText = doc.getElementById("prompt-text");
      const isHands = this.inputMode === "hands";

      if (promptRow)
        promptRow.setProperties({
          backgroundColor: "rgba(0, 70, 90, 0.7)",
          borderColor: "rgba(0, 200, 220, 0.5)",
        });
      if (buttonHint) {
        buttonHint.setProperties({
          backgroundColor: "#00d4e6",
          display: isHands ? "none" : "flex",
        });
      }
      if (buttonLetter) buttonLetter.setProperties({ text: "A" });
      if (promptText)
        promptText.setProperties({
          text: this.getIdlePromptText(),
          color: "#00d4e6",
        });
    }

    this.recordingState = VOICE_RECORDING_STATE.IDLE;
  }

  showInterpretResult(result, interpretMode = "greeting") {
    const doc = this.getDocument();
    if (!doc) {
      this.logger.warn("Voice document not ready for result display");
      return;
    }

    const transcriptionText = doc.getElementById("transcription-text");
    const resultRow = doc.getElementById("result-row");
    const resultText = doc.getElementById("result-text");
    const statusDot = doc.getElementById("status-dot");
    const statusText = doc.getElementById("status-text");
    const promptRow = doc.getElementById("prompt-row");
    const buttonHint = doc.getElementById("button-hint");
    const promptText = doc.getElementById("prompt-text");

    const displayText =
      result.corrected_transcription || result.transcription || "...";

    if (transcriptionText) {
      transcriptionText.setProperties({
        text: `"${displayText}"`,
        color: "#ffffff",
      });
    }

    const sentiment = result.sentiment || {};
    const isRude = sentiment.is_rude || false;

    if (interpretMode === "reassurance") {
      // Reassurance mode: check for reassuring/comforting speech
      const isReassuring =
        result.intent === "reassuring" ||
        (sentiment.sentiment === "friendly" && sentiment.score > 0.3);

      if (isReassuring) {
        uiAudio.success();
        hapticManager.pulseBoth(0.8, 80);
        setTimeout(() => hapticManager.pulseBoth(0.6, 60), 100);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(34, 197, 94, 0.2)",
            borderColor: "rgba(34, 197, 94, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Baud feels better!",
            color: "#22c55e",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#22c55e" });
        if (statusText) statusText.setProperties({ text: "REASSURING" });
      } else {
        uiAudio.notification();
        hapticManager.pulseBoth(0.3, 30);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(245, 158, 11, 0.2)",
            borderColor: "rgba(245, 158, 11, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Baud still worried...",
            color: "#f59e0b",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#f59e0b" });
        if (statusText) statusText.setProperties({ text: "NON-REASSURING" });
      }
    } else if (interpretMode === "modem_stay") {
      // Modem stay mode: LLM classifies as yes/no/non_answer
      const modemIntent = result.intent; // "yes", "no", or "non_answer"

      this.logger.log(
        `Modem stay UI - LLM intent: "${modemIntent}", confidence: ${result.confidence}`
      );

      if (modemIntent === "yes") {
        uiAudio.success();
        hapticManager.pulseBoth(0.8, 80);
        setTimeout(() => hapticManager.pulseBoth(0.6, 60), 100);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(34, 197, 94, 0.2)",
            borderColor: "rgba(34, 197, 94, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Modem can stay!",
            color: "#22c55e",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#22c55e" });
        if (statusText) statusText.setProperties({ text: "YES" });
      } else if (modemIntent === "no") {
        uiAudio.notification();
        hapticManager.pulseBoth(0.5, 50);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(245, 158, 11, 0.2)",
            borderColor: "rgba(245, 158, 11, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Modem must go...",
            color: "#f59e0b",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#f59e0b" });
        if (statusText) statusText.setProperties({ text: "NO" });
      } else {
        uiAudio.notification();
        hapticManager.pulseBoth(0.3, 30);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(100, 100, 100, 0.2)",
            borderColor: "rgba(150, 150, 150, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Yes or no?",
            color: "#9ca3af",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#9ca3af" });
        if (statusText) statusText.setProperties({ text: "NON-ANSWER" });
      }
    } else {
      // Default greeting mode
      const isGreeting =
        result.is_greeting || result.robot_directive?.stop_navigation;

      if (isGreeting && !isRude) {
        uiAudio.success();
        hapticManager.pulseBoth(0.8, 80);
        setTimeout(() => hapticManager.pulseBoth(0.6, 60), 100);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(34, 197, 94, 0.2)",
            borderColor: "rgba(34, 197, 94, 0.5)",
          });
        if (resultText) {
          resultText.setProperties({
            text: "Friendly Greeting!",
            color: "#22c55e",
          });
        }
        if (statusDot) statusDot.setProperties({ backgroundColor: "#22c55e" });
        if (statusText) statusText.setProperties({ text: "SUCCESS" });

        gameState.setState({
          friendlyGreetingReceived: true,
          robotsMovingToGoal: true,
          robotBehavior: "moving_to_goal",
        });
      } else if (isGreeting && isRude) {
        uiAudio.error();
        hapticManager.pulseBoth(0.5, 50);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(245, 158, 11, 0.2)",
            borderColor: "rgba(245, 158, 11, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Unfriendly Greeting",
            color: "#f59e0b",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#f59e0b" });
        if (statusText) statusText.setProperties({ text: "RUDE" });
      } else if (isRude) {
        uiAudio.error();
        hapticManager.pulseBoth(0.5, 50);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(239, 68, 68, 0.2)",
            borderColor: "rgba(239, 68, 68, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: sentiment.tone_description || "Unfriendly",
            color: "#ef4444",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#ef4444" });
        if (statusText) statusText.setProperties({ text: "RUDE" });
      } else {
        uiAudio.notification();
        hapticManager.pulseBoth(0.3, 30);

        if (resultRow)
          resultRow.setProperties({
            backgroundColor: "rgba(239, 68, 68, 0.2)",
            borderColor: "rgba(239, 68, 68, 0.5)",
          });
        if (resultText)
          resultText.setProperties({
            text: "Non-greeting",
            color: "#ef4444",
          });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#ef4444" });
        if (statusText) statusText.setProperties({ text: "TRY AGAIN" });
      }
    }

    const buttonLetter = doc.getElementById("button-letter");
    const isHands = this.inputMode === "hands";

    if (promptRow)
      promptRow.setProperties({
        backgroundColor: "rgba(0, 70, 90, 0.7)",
        borderColor: "rgba(0, 200, 220, 0.5)",
      });
    if (buttonHint) {
      buttonHint.setProperties({
        backgroundColor: "#00d4e6",
        display: isHands ? "none" : "flex",
      });
    }
    if (buttonLetter) buttonLetter.setProperties({ text: "A" });
    if (promptText)
      promptText.setProperties({
        text: this.getIdlePromptText(),
        color: "#00d4e6",
      });

    this.recordingState = VOICE_RECORDING_STATE.IDLE;
  }

  setupInteractions(onRecordClick) {
    const doc = this.getDocument();
    if (!doc) return;

    const recordBtn = doc.getElementById("record-btn");
    if (recordBtn) {
      recordBtn.addEventListener("click", () => {
        this.logger.log("Record button clicked");
        if (onRecordClick) onRecordClick();
      });
    }
  }

  updateInputModeUI(inputMode) {
    this.inputMode = inputMode;
    this._inputModeSynced = false; // Mark as needing sync
    this._applyInputModeUI();
  }

  _applyInputModeUI() {
    const doc = this.getDocument();
    if (!doc) return; // Will retry in update()

    const buttonHint = doc.getElementById("button-hint");
    const buttonLetter = doc.getElementById("button-letter");
    const promptText = doc.getElementById("prompt-text");

    this._ensureThumbTapCreated();

    if (this.recordingState === VOICE_RECORDING_STATE.IDLE) {
      if (this.inputMode === "hands") {
        if (buttonHint) buttonHint.setProperties({ display: "none" });
        this.thumbTap.show();
        if (promptText) promptText.setProperties({ text: "THUMBTAP TO SPEAK" });
      } else {
        if (buttonHint) buttonHint.setProperties({ display: "flex" });
        this.thumbTap.hide();
        if (buttonLetter) buttonLetter.setProperties({ text: "A" });
        if (promptText) promptText.setProperties({ text: "HOLD TO SPEAK" });
      }
    }

    this._inputModeSynced = true; // Only set after successful application
  }

  _ensureThumbTapCreated() {
    if (this._thumbTapCreated) return;
    const panel = this.registry.getPanel("voice");
    if (panel?.group) {
      this.thumbTap.create(panel.group);
      this._thumbTapCreated = true;
    }
  }

  update(deltaTime = 0.016) {
    // Update fade animation
    if (this._fadeProgress !== this._targetFade) {
      const fadeSpeed = 1 / FADE_DURATION;
      if (this._targetFade < this._fadeProgress) {
        this._fadeProgress = Math.max(
          this._targetFade,
          this._fadeProgress - fadeSpeed * deltaTime
        );
      } else {
        this._fadeProgress = Math.min(
          this._targetFade,
          this._fadeProgress + fadeSpeed * deltaTime
        );
      }

      // Apply fade to panel
      const panel = this.registry.getPanel("voice");
      if (panel?.group) {
        panel.group.visible = this._fadeProgress > 0.01;
        // Apply opacity to all materials in the panel
        panel.group.traverse((child) => {
          if (child.material) {
            child.material.opacity = this._fadeProgress;
          }
        });
      }
    }

    // Retry input mode sync if document wasn't ready before
    if (!this._inputModeSynced) {
      this._applyInputModeUI();
    }

    // Skip thumbtap updates if not in hands mode
    if (this.inputMode !== "hands") return;

    if (!this._thumbTapCreated) {
      this._ensureThumbTapCreated();
    }

    // Show thumbtap once mesh is ready and panel is visible
    const panel = this.registry.getPanel("voice");
    if (
      panel?.group?.visible &&
      this.thumbTap.ready &&
      this.thumbTap.mesh &&
      !this.thumbTap.mesh.visible &&
      !this._disabled
    ) {
      this.thumbTap.show();
    }

    // Hide thumbtap when disabled
    if (this._disabled && this.thumbTap.mesh?.visible) {
      this.thumbTap.hide();
    }

    this.thumbTap.update();
  }

  getIdlePromptText() {
    return this.inputMode === "hands" ? "THUMBTAP TO SPEAK" : "HOLD TO SPEAK";
  }

  destroy() {
    this.recordingState = VOICE_RECORDING_STATE.IDLE;
    this.thumbTap.dispose();
    gameState.off("state:changed", this._onStateChanged);
  }
}
