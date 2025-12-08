/**
 * KeyboardManager.js - KEYBOARD INPUT FOR XR EMULATION
 * =============================================================================
 *
 * ROLE: Provides keyboard fallback for XR controller buttons during emulator
 * development. Maps spacebar to A button for press-and-hold voice recording.
 *
 * KEY RESPONSIBILITIES:
 * - Listen for keydown/keyup on document and window
 * - Track space key state for press-and-hold detection
 * - Fire callbacks for A button down/up and B button
 * - Coordinate with UI keyboard listeners (start screen, options)
 * - Detect when keyboard should control XR vs UI navigation
 *
 * KEY MAPPINGS:
 * - Space: A button (press-and-hold for voice recording)
 * - (B button keyboard mapping not currently implemented)
 *
 * STATE MANAGEMENT:
 * - _xrKeyboardActive: Whether XR keyboard control is enabled
 * - _spacePressed: Current space key state
 * - Event deduplication via timestamp tracking
 *
 * EXPORTS:
 * - KeyboardManager singleton instance
 *
 * USAGE: Imported by InputHandler for emulator keyboard support
 * =============================================================================
 */

import { Logger } from "./Logger.js";

class KeyboardManagerClass {
  constructor() {
    this.logger = new Logger("KeyboardManager", false);

    // Keyboard state
    this._spacePressed = false;
    this._enabled = false;

    // Prevent duplicate event handling (from document + window listeners)
    this._handledEvents = new Set();

    // Callbacks for XR button emulation
    this._onAButtonDown = null;
    this._onAButtonUp = null;
    this._onBButton = null;

    // Track if we're in a state where keyboard should control XR
    this._xrKeyboardActive = false;

    this._setupListeners();
  }

  _setupListeners() {
    // Use document instead of window for broader browser compatibility
    // Use capture phase (true) to see events before other handlers
    document.addEventListener("keydown", (e) => this._handleKeyDown(e), true);
    document.addEventListener("keyup", (e) => this._handleKeyUp(e), true);

    // Also listen on window as fallback
    window.addEventListener("keydown", (e) => this._handleKeyDown(e), true);
    window.addEventListener("keyup", (e) => this._handleKeyUp(e), true);

    // Ensure document has focus when clicked (helps with embedded browsers like Cursor)
    document.addEventListener("click", () => {
      if (document.body) {
        document.body.focus();
      }
    });

    this.logger.log("Keyboard listeners registered on document and window");
  }

  _handleKeyDown(e) {
    // Only handle space for XR emulation when enabled and active
    if (e.code !== "Space") return;
    if (e.repeat) return;

    // Prevent double-handling (we listen on both document and window)
    const eventId = `down-${e.code}-${e.timeStamp}`;
    if (this._handledEvents.has(eventId)) return;
    this._handledEvents.add(eventId);
    setTimeout(() => this._handledEvents.delete(eventId), 50);

    if (this._spacePressed) return; // Already handling

    // Debug: always log space press
    this.logger.log(
      `SPACE keydown detected, enabled=${this._enabled}, active=${
        this._xrKeyboardActive
      }, hasCallback=${!!this._onAButtonDown}`
    );

    // Check if we should handle this
    if (!this._shouldHandleXRKeyboard()) {
      this.logger.log("Not handling - shouldHandleXRKeyboard returned false");
      return;
    }

    // Don't capture in text fields
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    this._spacePressed = true;
    e.preventDefault();

    this.logger.log("SPACE down → A button callback");
    this._onAButtonDown?.();
  }

  _handleKeyUp(e) {
    if (e.code !== "Space") return;

    // Prevent double-handling (we listen on both document and window)
    const eventId = `up-${e.code}-${e.timeStamp}`;
    if (this._handledEvents.has(eventId)) return;
    this._handledEvents.add(eventId);
    setTimeout(() => this._handledEvents.delete(eventId), 50);

    // Only handle if we pressed it
    if (!this._spacePressed) return;

    this._spacePressed = false;

    if (this._shouldHandleXRKeyboard()) {
      e.preventDefault();
      this.logger.log("SPACE up → A button release");
      this._onAButtonUp?.();
    }
  }

  _shouldHandleXRKeyboard() {
    // Must be enabled and have callbacks
    if (!this._enabled || !this._xrKeyboardActive) return false;
    if (!this._onAButtonDown) return false;

    // Check for overlays that should handle keyboard instead
    const startScreen = document.getElementById("start-screen-overlay");
    if (startScreen) {
      const style = window.getComputedStyle(startScreen);
      if (style.display !== "none" && style.visibility !== "hidden") {
        return false;
      }
    }

    const optionsMenu = document.getElementById("options-menu");
    if (optionsMenu) {
      const style = window.getComputedStyle(optionsMenu);
      if (style.display !== "none" && style.visibility !== "hidden") {
        return false;
      }
    }

    return true;
  }

  /**
   * Enable keyboard XR emulation
   * Call this when entering XR mode in emulator
   */
  enableXRKeyboard() {
    this._enabled = true;
    this.logger.log("XR keyboard emulation enabled");
  }

  /**
   * Disable keyboard XR emulation
   */
  disableXRKeyboard() {
    this._enabled = false;
    this._spacePressed = false;
    this.logger.log("XR keyboard emulation disabled");
  }

  /**
   * Set XR keyboard active state (called each frame when polling)
   */
  setXRKeyboardActive(active) {
    this._xrKeyboardActive = active;
  }

  /**
   * Register callbacks for XR button emulation
   * @param {Object} callbacks
   * @param {Function} callbacks.onAButtonDown - Called when Space is pressed
   * @param {Function} callbacks.onAButtonUp - Called when Space is released
   * @param {Function} callbacks.onBButton - Called when B is pressed (future: use another key)
   */
  setXRButtonCallbacks(callbacks) {
    this._onAButtonDown = callbacks?.onAButtonDown || null;
    this._onAButtonUp = callbacks?.onAButtonUp || null;
    this._onBButton = callbacks?.onBButton || null;
  }

  /**
   * Clear XR button callbacks
   */
  clearXRButtonCallbacks() {
    this._onAButtonDown = null;
    this._onAButtonUp = null;
    this._onBButton = null;
  }
}

// Export singleton
export const KeyboardManager = new KeyboardManagerClass();
