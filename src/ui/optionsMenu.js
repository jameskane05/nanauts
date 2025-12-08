/**
 * OptionsMenu.js - SETTINGS MENU OVERLAY
 * =============================================================================
 *
 * ROLE: HTML overlay for adjusting game settings. Provides sliders for volume
 * control and toggles for captions. Settings persist to localStorage.
 *
 * KEY RESPONSIBILITIES:
 * - Create DOM overlay with sliders and toggles
 * - Load/save settings to localStorage
 * - Apply settings in real-time (volume, captions)
 * - Handle keyboard navigation
 * - Close button returns to StartScreen
 *
 * SETTINGS:
 * - musicVolume: 0-100 (affects background music)
 * - sfxVolume: 0-100 (affects SFX and dialog)
 * - captionsEnabled: boolean
 *
 * PERSISTENCE:
 * Settings stored in localStorage under "gameSettings" key.
 * Loaded on construction, saved on any change.
 *
 * USAGE: Instantiated by index.js, shown when options button clicked
 * =============================================================================
 */

import { gameState } from "../gameState.js";
import { Logger } from "../utils/Logger.js";
import "../styles/optionsMenu.css";

export class OptionsMenu {
  constructor(options = {}) {
    this.logger = new Logger("OptionsMenu", false);
    this.onBack = options.onBack || null;
    this.isVisible = false;
    this.overlay = null;
    this.keydownHandler = null;

    this.settings = {
      musicVolume: 80,
      sfxVolume: 80,
      captionsEnabled: true,
    };

    this.loadSettings();
  }

  async initialize() {
    this.createOverlay();
    this.setupInteractions();
    this.setupKeyboardNavigation();
    this.applySettings();
    this.updateUI();
    this.logger.log("Initialized");
  }

  createOverlay() {
    this.overlay = document.createElement("div");
    this.overlay.id = "options-menu-overlay";
    this.overlay.innerHTML = `
      <div class="options-panel">
        <div class="header-row">
          <h2 class="title">OPTIONS</h2>
          <button id="close-button" class="close-button">✕</button>
        </div>

        <div class="settings-container">
          <div class="setting-row">
            <label class="setting-label">MUSIC VOLUME</label>
            <div class="slider-row">
              <input type="range" id="music-slider" class="slider" min="0" max="100" value="80">
              <span id="music-value" class="slider-value">80%</span>
            </div>
          </div>

          <div class="setting-row">
            <label class="setting-label">SFX & DIALOG VOLUME</label>
            <div class="slider-row">
              <input type="range" id="sfx-slider" class="slider" min="0" max="100" value="80">
              <span id="sfx-value" class="slider-value">80%</span>
            </div>
          </div>

          <div class="setting-row checkbox-row">
            <label class="setting-label">CAPTIONS</label>
            <label class="checkbox-container">
              <input type="checkbox" id="captions-checkbox" checked>
              <span class="checkmark"></span>
            </label>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);
  }

  setupInteractions() {
    const closeBtn = document.getElementById("close-button");
    const musicSlider = document.getElementById("music-slider");
    const sfxSlider = document.getElementById("sfx-slider");
    const captionsCheckbox = document.getElementById("captions-checkbox");

    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.handleBack());
    }

    if (musicSlider) {
      musicSlider.addEventListener("input", (e) => {
        this.settings.musicVolume = parseInt(e.target.value);
        this.updateUI();
        this.applySettings();
        this.saveSettings();
      });
    }

    if (sfxSlider) {
      sfxSlider.addEventListener("input", (e) => {
        this.settings.sfxVolume = parseInt(e.target.value);
        this.updateUI();
        this.applySettings();
        this.saveSettings();
      });
    }

    if (captionsCheckbox) {
      captionsCheckbox.addEventListener("change", (e) => {
        this.settings.captionsEnabled = e.target.checked;
        this.applySettings();
        this.saveSettings();
      });
    }
  }

  setupKeyboardNavigation() {
    this.keydownHandler = (e) => {
      if (!this.isVisible) return;

      if (e.key === "Escape") {
        e.preventDefault();
        this.handleBack();
      }
    };
    window.addEventListener("keydown", this.keydownHandler);
  }

  updateUI() {
    const musicSlider = document.getElementById("music-slider");
    const musicValue = document.getElementById("music-value");
    const sfxSlider = document.getElementById("sfx-slider");
    const sfxValue = document.getElementById("sfx-value");
    const captionsCheckbox = document.getElementById("captions-checkbox");

    if (musicSlider) musicSlider.value = this.settings.musicVolume;
    if (musicValue) musicValue.textContent = `${this.settings.musicVolume}%`;
    if (sfxSlider) sfxSlider.value = this.settings.sfxVolume;
    if (sfxValue) sfxValue.textContent = `${this.settings.sfxVolume}%`;
    if (captionsCheckbox)
      captionsCheckbox.checked = this.settings.captionsEnabled;
  }

  applySettings() {
    gameState.setState({
      musicVolume: this.settings.musicVolume / 100,
      sfxVolume: this.settings.sfxVolume / 100,
      captionsEnabled: this.settings.captionsEnabled,
    });
  }

  saveSettings() {
    try {
      localStorage.setItem("gameSettings", JSON.stringify(this.settings));
    } catch (e) {
      console.warn("[OptionsMenu] Could not save settings:", e);
    }
  }

  loadSettings() {
    try {
      const stored = localStorage.getItem("gameSettings");
      if (stored) {
        const parsed = JSON.parse(stored);
        this.settings = { ...this.settings, ...parsed };
      }
    } catch (e) {
      this.logger.warn("Could not load settings:", e);
    }
    this.logger.log("Settings loaded:", this.settings);
  }

  handleBack() {
    this.hide();
    if (this.onBack) {
      this.onBack();
    }
  }

  show() {
    if (this.overlay) {
      this.overlay.style.display = "flex";
      this.isVisible = true;
      this.updateUI();
      this.logger.log("Shown");
    }
  }

  hide() {
    if (this.overlay) {
      this.overlay.style.display = "none";
      this.isVisible = false;
      this.logger.log("Hidden");
    }
  }

  getSettings() {
    return { ...this.settings };
  }

  destroy() {
    if (this.keydownHandler) {
      window.removeEventListener("keydown", this.keydownHandler);
    }
    if (this.overlay) {
      this.overlay.remove();
    }
  }
}
