/**
 * StartScreen.js - PRE-XR START MENU OVERLAY
 * =============================================================================
 *
 * ROLE: HTML overlay displayed before entering XR. Shows start button and options button.
 * Keyboard navigation supported for accessibility.
 *
 * KEY RESPONSIBILITIES:
 * - Create and manage DOM overlay with start/options buttons
 * - Handle keyboard navigation (arrow keys, enter, escape)
 * - Visual selection state with CSS classes
 * - Trigger callbacks on button activation
 *
 * START BUTTON:
 * Enabled immediately on initialization (no server health check required).
 *
 * UI STRUCTURE:
 * - Decorative meter bars (animated CSS)
 * - START button (enabled by default)
 * - OPTIONS button (opens OptionsMenu)
 *
 * USAGE: Instantiated by index.js, shown by default after initialize()
 * =============================================================================
 */

import { gameState, GAME_STATES } from "../gameState.js";
import { Logger } from "../utils/Logger.js";
import "../styles/startScreen.css";

export class StartScreen {
  constructor(options = {}) {
    this.logger = new Logger("StartScreen", false);
    this.onStart = options.onStart || null;
    this.onOptions = options.onOptions || null;
    this.isVisible = false;
    this.selectedIndex = 0;
    this.buttons = ["start-button", "options-button"];
    this.overlay = null;
    this.keydownHandler = null;
    this.serverReady = false;
  }

  async initialize() {
    this.createOverlay();
    this.setupInteractions();
    this.setupKeyboardNavigation();
    this.updateSelectionVisual();
    this.serverReady = true; // Enable immediately - no server health check needed
    this.setStartButtonEnabled(true);
    this.logger.log("Initialized");
    this.show(); // Show by default after initialization
  }

  createOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.id = "start-screen-overlay";
    this.overlay.innerHTML = `
      <div class="start-panel">
        <div class="decorative-row">
          <div class="meter-group">
            <span class="meter m1"></span>
            <span class="meter m2"></span>
            <span class="meter m3"></span>
            <span class="meter m4"></span>
            <span class="meter m5"></span>
          </div>
          <div class="divider-line"></div>
          <div class="divider-dot"></div>
          <div class="divider-line"></div>
          <div class="meter-group right">
            <span class="meter m1"></span>
            <span class="meter m2"></span>
            <span class="meter m3"></span>
            <span class="meter m4"></span>
            <span class="meter m5"></span>
          </div>
        </div>

        <h1 class="title">NANAUTS</h1>
        <p class="subtitle">A STORY OF CULTURAL EXPLORATION</p>

        <div class="decorative-row">
          <div class="meter-group">
            <span class="meter m1"></span>
            <span class="meter m2"></span>
            <span class="meter m3"></span>
            <span class="meter m4"></span>
            <span class="meter m5"></span>
          </div>
          <div class="divider-line"></div>
          <div class="divider-dot"></div>
          <div class="divider-line"></div>
          <div class="meter-group right">
            <span class="meter m1"></span>
            <span class="meter m2"></span>
            <span class="meter m3"></span>
            <span class="meter m4"></span>
            <span class="meter m5"></span>
          </div>
        </div>

        <div class="button-container">
          <button id="start-button" class="menu-button start-button">START</button>
          <button id="options-button" class="menu-button">OPTIONS</button>
        </div>

        <div class="footer">
          <p class="credits">Made for WebXR with IWSDK, Llama 3.3, SAM 3 & SAM 3D Objects</p>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    // Make overlay focusable and add focus on click (helps with embedded browsers)
    this.overlay.setAttribute("tabindex", "-1");
    this.overlay.addEventListener("click", () => {
      this.overlay.focus();
      this.logger.log("Overlay focused");
    });
  }

  setupInteractions() {
    const startBtn = document.getElementById("start-button");
    const optionsBtn = document.getElementById("options-button");

    if (startBtn) {
      startBtn.addEventListener("click", () => this.handleStart());
    }
    if (optionsBtn) {
      optionsBtn.addEventListener("click", () => this.handleOptions());
    }
  }

  setupKeyboardNavigation() {
    this._handledKeys = new Set();

    this.keydownHandler = (e) => {
      if (!this.isVisible) return;

      // Prevent double-handling (we listen on both document and window)
      const keyId = `${e.code}-${e.timeStamp}`;
      if (this._handledKeys.has(keyId)) return;
      this._handledKeys.add(keyId);
      setTimeout(() => this._handledKeys.delete(keyId), 50);

      this.logger.log(
        `keydown: key=${e.key}, selectedIndex=${this.selectedIndex}`
      );

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          this.selectedIndex =
            (this.selectedIndex - 1 + this.buttons.length) %
            this.buttons.length;
          this.updateSelectionVisual();
          break;
        case "ArrowDown":
          e.preventDefault();
          this.selectedIndex = (this.selectedIndex + 1) % this.buttons.length;
          this.updateSelectionVisual();
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          this.logger.log("Confirming selection via keyboard");
          this.confirmSelection();
          break;
      }
    };
    // Use both document and window for broader browser compatibility
    document.addEventListener("keydown", this.keydownHandler, true);
    window.addEventListener("keydown", this.keydownHandler, true);
    this.logger.log("Keyboard navigation listeners registered");
  }

  updateSelectionVisual() {
    this.logger.log(
      `updateSelectionVisual: selectedIndex=${this.selectedIndex}`
    );
    this.buttons.forEach((id, index) => {
      const btn = document.getElementById(id);
      if (btn) {
        const isSelected = index === this.selectedIndex;
        btn.classList.toggle("selected", isSelected);
        this.logger.log(
          `Button ${id}: isSelected=${isSelected}, classList=${btn.className}`
        );
      } else {
        this.logger.warn(`Button ${id} not found!`);
      }
    });
  }

  confirmSelection() {
    const buttonId = this.buttons[this.selectedIndex];
    if (buttonId === "start-button") {
      this.handleStart();
    } else if (buttonId === "options-button") {
      this.handleOptions();
    }
  }

  handleStart() {
    this.logger.log("START clicked");
    gameState.setState({ currentState: GAME_STATES.ENTERING_XR });
    this.hide();
    if (this.onStart) {
      this.onStart();
    }
  }

  handleOptions() {
    this.logger.log("OPTIONS clicked");
    this.hide();
    if (this.onOptions) {
      this.onOptions();
    }
  }

  setStartButtonEnabled(enabled) {
    const startBtn = document.getElementById("start-button");
    if (startBtn) {
      startBtn.disabled = !enabled;
      startBtn.classList.toggle("disabled", !enabled);
    }
  }

  show() {
    if (this.overlay) {
      this.overlay.style.display = "flex";
      this.isVisible = true;
      // Focus overlay to enable keyboard navigation (important for embedded browsers)
      setTimeout(() => {
        this.overlay.focus();
        this.logger.log("Shown and focused");
      }, 100);
    }
  }

  hide() {
    if (this.overlay) {
      this.overlay.style.display = "none";
      this.isVisible = false;
      this.logger.log("Hidden");
    }
  }

  destroy() {
    if (this.keydownHandler) {
      document.removeEventListener("keydown", this.keydownHandler, true);
      window.removeEventListener("keydown", this.keydownHandler, true);
    }
    if (this.overlay) {
      this.overlay.remove();
    }
  }
}
