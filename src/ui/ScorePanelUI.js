/**
 * ScorePanelUI.js - SCORE PANEL UI LOGIC
 * =============================================================================
 *
 * Handles score panel functionality for minigame scoring display.
 *
 * RESPONSIBILITIES:
 * - Show/hide score panel with scale animation
 * - Update score display
 * - Scale-in animation
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import { ATTACHMENT_MODE } from "./SpatialMountManager.js";

export class ScorePanelUI {
  constructor(registry, mountManager, options = {}) {
    this.registry = registry;
    this.mountManager = mountManager;
    this.logger = new Logger("ScorePanelUI", options.debug ?? false);

    this._animationScale = 0;
    this._animating = false;

    // Status state tracking
    this._statusState = "scanning"; // "scanning" | "panicking" | "calmed"
    this._calmedFlashUntil = 0; // Timestamp when "CALMED" flash should end

    // Mode configuration (panic vs entropy)
    this._mode = "panic"; // "panic" | "entropy"
    this._labels = {
      panic: { alert: "PANICKING", success: "CALMED", score: "CALMED" },
      entropy: { alert: "ENTROPY", success: "CAPTURED", score: "CAPTURED" },
    };
  }

  getDocument() {
    return this.registry.getDocument("score");
  }

  async show() {
    if (!this.registry.getPanel("score")) {
      await this.registry.createPanel("score", ATTACHMENT_MODE.SCORE);
    }

    const panel = this.registry.getPanel("score");
    if (!panel) {
      this.logger.warn("Score panel not available");
      return;
    }

    this._animationScale = 0;
    this._animating = true;

    // Initialize to "SCANNING" state
    this._statusState = "scanning";
    this._calmedFlashUntil = 0;

    this.mountManager.setMountVisibility(ATTACHMENT_MODE.SCORE, true);
    panel.group.visible = true;
    panel.group.scale.setScalar(0);

    // Set initial status display
    const doc = this.getDocument();
    if (doc) {
      this._updateStatusDisplay(doc, 0, 5);
    }

    this.logger.log("Score panel shown");
  }

  hide() {
    this._animating = false;
    this.mountManager.setMountVisibility(ATTACHMENT_MODE.SCORE, false);

    const panel = this.registry.getPanel("score");
    if (panel) {
      panel.group.visible = false;
    }

    this.logger.log("Score panel hidden");
  }

  setMode(mode) {
    this._mode = mode === "entropy" ? "entropy" : "panic";
    const doc = this.getDocument();
    if (doc) {
      const scoreLabel = doc.querySelector(".score-label");
      if (scoreLabel) {
        scoreLabel.setProperties({ text: this._labels[this._mode].score });
      }
    }
  }

  updateDisplay(current, total) {
    const doc = this.getDocument();
    if (!doc) {
      this.logger.warn("Score document not available");
      return;
    }

    const scoreText = doc.getElementById("score-text");
    if (scoreText) {
      scoreText.setProperties({ text: `${current} / ${total}` });
    }

    // Update score label based on current mode
    const scoreLabel = doc.querySelector(".score-label");
    if (scoreLabel) {
      scoreLabel.setProperties({ text: this._labels[this._mode].score });
    }

    // Check if "CALMED" flash should expire (this is called regularly)
    const now = performance.now();
    if (
      this._statusState === "calmed" &&
      this._calmedFlashUntil > 0 &&
      now >= this._calmedFlashUntil
    ) {
      // Check if any robot is still panicking
      const anyPanicking = this._checkAnyPanicking
        ? this._checkAnyPanicking()
        : false;
      this._statusState = anyPanicking ? "panicking" : "scanning";
      this._calmedFlashUntil = 0; // Clear the timer
      // Update display immediately when switching back to SCANNING
      this._updateStatusDisplay(doc, current, total);
      return; // Skip the update call at the end since we just did it
    }

    // Update status text and colors based on state
    this._updateStatusDisplay(doc, current, total);
  }

  /**
   * Set status to "PANICKING" when a robot starts panicking
   * @param {Function} checkAnyPanicking - Optional callback to check if any robot is still panicking
   */
  setPanicking(checkAnyPanicking = null) {
    if (this._statusState !== "panicking") {
      this._statusState = "panicking";
      this._checkAnyPanicking = checkAnyPanicking; // Store callback for later use
      this._updateStatusDisplay(this.getDocument(), null, null);
    }
  }

  /**
   * Flash "CALMED" for 2 seconds when a robot is calmed
   * @param {Function} checkAnyPanicking - Optional callback to check if any robot is still panicking
   */
  flashCalmed(checkAnyPanicking = null) {
    this._statusState = "calmed";
    this._calmedFlashUntil = performance.now() + 2000; // 2 seconds
    this._checkAnyPanicking = checkAnyPanicking; // Store callback for later use
    this._updateStatusDisplay(this.getDocument(), null, null);
  }

  /**
   * Update status text and colors based on current state
   */
  _updateStatusDisplay(doc, current, total) {
    if (!doc) return;

    const appTitle = doc.querySelector(".app-title");
    const statusDot = doc.getElementById("status-dot");

    let statusText, textColor, dotColor;
    const labels = this._labels[this._mode];

    if (this._statusState === "panicking") {
      statusText = labels.alert; // "PANICKING" or "ENTROPY"
      textColor = "#ff6666"; // Red/orange
      dotColor = "#ff6666";
    } else if (this._statusState === "calmed") {
      statusText = labels.success; // "CALMED" or "CAPTURED"
      textColor = "#66ff66"; // Green
      dotColor = "#66ff66";
    } else {
      // scanning (default)
      statusText = "SCANNING";
      textColor = "#66ccff"; // Light blue
      dotColor = "#66ccff";
    }

    if (appTitle) {
      appTitle.setProperties({
        text: statusText,
        color: textColor,
      });
    }

    if (statusDot) {
      statusDot.setProperties({
        backgroundColor: dotColor,
      });
    }

    // Update "CALMED" label color (white/grey instead of reddish)
    const scoreLabel = doc.querySelector(".score-label");
    if (scoreLabel) {
      scoreLabel.setProperties({
        color: "#cccccc", // Light grey
      });
    }

    // Update background colors based on state (not score)
    const panel = doc.querySelector(".score-panel");
    const scoreContainer = doc.querySelector(".score-container");

    if (this._statusState === "panicking") {
      // Red theme during PANICKING
      if (panel) {
        panel.setProperties({
          backgroundColor: "rgba(36, 8, 8, 0.95)",
          borderColor: "rgba(255, 100, 100, 0.6)",
        });
      }
      if (scoreContainer) {
        scoreContainer.setProperties({
          backgroundColor: "rgba(60, 20, 20, 0.6)",
          borderColor: "rgba(255, 100, 100, 0.3)",
        });
      }
    } else {
      // Scanning state or "CALMED" flash - use blue theme
      if (panel) {
        panel.setProperties({
          backgroundColor: "rgba(8, 24, 36, 0.95)",
          borderColor: "rgba(100, 200, 255, 0.6)",
        });
      }
      if (scoreContainer) {
        scoreContainer.setProperties({
          backgroundColor: "rgba(20, 40, 60, 0.6)",
          borderColor: "rgba(100, 200, 255, 0.3)",
        });
      }
    }
  }

  /**
   * Lerp from red to green through yellow/orange
   * Returns color strings for various UI elements
   */
  _lerpRedToGreen(progress) {
    // Clamp progress to 0-1
    const t = Math.max(0, Math.min(1, progress));

    // Red: rgb(255, 100, 100) -> Yellow: rgb(255, 255, 100) -> Green: rgb(100, 255, 100)
    // For backgrounds, use darker variants
    let r, g, b;

    if (t < 0.5) {
      // Red to Yellow (0 to 0.5)
      const localT = t * 2; // 0 to 1 within this half
      r = Math.round(255 - (255 - 255) * localT); // 255
      g = Math.round(100 + (255 - 100) * localT); // 100 -> 255
      b = Math.round(100 - (100 - 100) * localT); // 100
    } else {
      // Yellow to Green (0.5 to 1.0)
      const localT = (t - 0.5) * 2; // 0 to 1 within this half
      r = Math.round(255 - (255 - 100) * localT); // 255 -> 100
      g = Math.round(255 - (255 - 255) * localT); // 255
      b = Math.round(100 - (100 - 100) * localT); // 100
    }

    // Darker variants for backgrounds
    const bgR = Math.round(r * 0.15);
    const bgG = Math.round(g * 0.15);
    const bgB = Math.round(b * 0.15);

    const containerR = Math.round(r * 0.25);
    const containerG = Math.round(g * 0.25);
    const containerB = Math.round(b * 0.25);

    return {
      // Main panel background (dark)
      background: `rgba(${bgR}, ${bgG}, ${bgB}, 0.95)`,
      // Main panel border
      border: `rgba(${r}, ${g}, ${b}, 0.6)`,
      // Score container background
      containerBg: `rgba(${containerR}, ${containerG}, ${containerB}, 0.6)`,
      // Score container border
      containerBorder: `rgba(${r}, ${g}, ${b}, 0.3)`,
      // Status dot
      dot: `rgb(${r}, ${g}, ${b})`,
      // Text color
      text: `rgb(${r}, ${g}, ${b})`,
    };
  }

  update() {
    // Always check if "CALMED" flash should expire (even if not animating)
    const now = performance.now();
    if (
      this._statusState === "calmed" &&
      this._calmedFlashUntil > 0 &&
      now >= this._calmedFlashUntil
    ) {
      // Check if any robot is still panicking
      const anyPanicking = this._checkAnyPanicking
        ? this._checkAnyPanicking()
        : false;
      this._statusState = anyPanicking ? "panicking" : "scanning";
      this._calmedFlashUntil = 0; // Clear the timer
      const doc = this.getDocument();
      if (doc) {
        this._updateStatusDisplay(doc, null, null);
      }
    }

    if (!this._animating || this._animationScale >= 1) return;

    this._animationScale = Math.min(1, this._animationScale + 0.08);
    const eased = 1 - Math.pow(1 - this._animationScale, 3);

    const panel = this.registry.getPanel("score");
    if (panel) {
      panel.group.scale.setScalar(eased);
    }
  }

  isAnimating() {
    return this._animating && this._animationScale < 1;
  }

  destroy() {
    this._animating = false;
    this._animationScale = 0;
  }
}
