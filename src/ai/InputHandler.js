/**
 * InputHandler.js - XR GAMEPAD BUTTON POLLING WITH KEYBOARD FALLBACK
 * =============================================================================
 *
 * ROLE: Polls XR gamepad buttons each frame with edge detection for press/release
 * events. Supports press-and-hold for voice recording (A button) and single-press
 * for reset (B button). Falls back to keyboard input in emulator mode.
 *
 * KEY RESPONSIBILITIES:
 * - Poll A button with press-and-hold detection (onAButtonDown/onAButtonUp)
 * - Poll B button with edge-triggered press detection
 * - Support both left and right controllers
 * - Register keyboard fallback via KeyboardManager for emulator
 * - Track input source changes (hands vs controllers)
 * - Find best available input target (controller grip, ray space)
 *
 * BUTTON MAPPING:
 * - A button (hold): Start/stop voice recording
 * - B button (press): Reset all tracked objects
 *
 * KEYBOARD FALLBACK:
 * In emulator mode, SPACE key emulates A button via KeyboardManager.
 *
 * USAGE: Instantiated by AIManager, pollGamepadButtons() called each XR frame
 * =============================================================================
 */

import { VisibilityState } from "@iwsdk/core";
import { Vector3 as THREEVector3 } from "three";
import { Logger } from "../utils/Logger.js";
import { KeyboardManager } from "../utils/KeyboardManager.js";

export class InputHandler {
  constructor(world, xrInput, player) {
    this.world = world;
    this.xrInput = xrInput;
    this.player = player;
    this.currentInputTarget = null;
    this.currentInputTargetType = null;
    this.handsDetected = false;
    this.controllersDetected = false;
    this.pinchRecordingActive = { left: false, right: false };
    this.bButtonWasPressed = false;
    this._inputSourceChangeHandler = null;
    this.logger = new Logger("InputHandler", false);

    // Button state tracking for edge detection
    this._aButtonWasPressed = false;
    this._leftAButtonWasPressed = false;
    this._aButtonDownPressed = false;
    this._leftAButtonDownPressed = false;
    this._bButtonDownPressed = false;
    this._leftBButtonDownPressed = false;

    // Debug logging flags (log once)
    this._buttonHandlerDebugLogged = false;
    this._xrNotActiveLogged = false;
    this._noXrInputLogged = false;
    this._noGamepadsLogged = false;
    this._padAvailabilityLogged = false;
  }

  setXRInput(xrInput) {
    this.xrInput = xrInput;
  }

  setupInputSourceListeners(xrManager) {
    if (!xrManager || !xrManager.getSession) {
      this.logger.warn(
        "XR manager doesn't support getSession, cannot listen for input source changes"
      );
      return;
    }

    const session = xrManager.getSession();
    if (!session) {
      setTimeout(() => {
        this.setupInputSourceListeners(xrManager);
      }, 1000);
      return;
    }

    if (this._inputSourceChangeHandler) {
      session.removeEventListener(
        "inputsourceschange",
        this._inputSourceChangeHandler
      );
    }

    this._inputSourceChangeHandler = (event) => {
      this.logger.log(
        `Input sources changed: added=${event.added.length}, removed=${event.removed.length}`
      );
      this.handleInputSourceChange(
        event.added.some((s) => s.hand),
        event.added.some((s) => s.targetRayMode === "tracked-pointer")
      );
    };

    session.addEventListener(
      "inputsourceschange",
      this._inputSourceChangeHandler
    );
    this.logger.log("Listening for XR input source changes");
  }

  handleInputSourceChange(hasHands, hasControllers) {
    this.handsDetected = hasHands;
    this.controllersDetected = hasControllers;
  }

  isXRActive() {
    return this.world.visibilityState?.value !== VisibilityState.NonImmersive;
  }

  /**
   * Poll gamepad buttons with press-and-hold support for A button
   * @param {Object} callbacks - Callback functions
   * @param {Function} callbacks.onAButtonDown - Called when A button is pressed down
   * @param {Function} callbacks.onAButtonUp - Called when A button is released
   * @param {Function} callbacks.onBButton - Called when B button is pressed
   */
  pollGamepadButtons(callbacks) {
    // Support legacy signature: pollGamepadButtons(onRecordToggle, onResetAll)
    if (typeof callbacks === "function") {
      const onRecordToggle = callbacks;
      const onResetAll = arguments[1];
      callbacks = {
        onAButtonDown: onRecordToggle,
        onAButtonUp: null,
        onBButton: onResetAll,
      };
    }

    const { onAButtonDown, onAButtonUp, onBButton } = callbacks || {};

    // Register callbacks with centralized KeyboardManager for emulator support
    KeyboardManager.setXRButtonCallbacks({
      onAButtonDown,
      onAButtonUp,
      onBButton,
    });
    KeyboardManager.setXRKeyboardActive(true);

    const isXRActive = this.isXRActive();

    if (!this._buttonHandlerDebugLogged) {
      this.logger.log(
        `pollGamepadButtons called: isXRActive=${isXRActive}, xrInput=${!!this
          .xrInput}, gamepads=${!!this.xrInput?.gamepads}`
      );
      this._buttonHandlerDebugLogged = true;
    }

    // In emulator without proper gamepads, keyboard fallback handles input
    if (!isXRActive || !this.xrInput || !this.xrInput.gamepads) {
      if (!isXRActive && !this._xrNotActiveLogged) {
        this.logger.warn(
          `Button handler: XR not active. visibilityState=${this.world.visibilityState?.value}`
        );
        this._xrNotActiveLogged = true;
      }
      if (!this.xrInput && !this._noXrInputLogged) {
        this.logger.warn(`Button handler: No xrInput`);
        this._noXrInputLogged = true;
      }
      if (!this.xrInput?.gamepads && !this._noGamepadsLogged) {
        this.logger.warn(
          `Button handler: No gamepads (use SPACE key for A button in emulator). xrInput=${!!this
            .xrInput}, gamepads=${!!this.xrInput?.gamepads}`
        );
        this._noGamepadsLogged = true;
      }
      return; // KeyboardManager will handle input
    }

    try {
      const rightPad = this.xrInput.gamepads.right;
      const leftPad = this.xrInput.gamepads.left;

      if (!this._padAvailabilityLogged) {
        this.logger.log(
          `Pads available: right=${!!rightPad}, left=${!!leftPad}`
        );
        if (rightPad) {
          this.logger.log(
            `Right pad methods: getButtonDown=${typeof rightPad.getButtonDown}, getButtonPressed=${typeof rightPad.getButtonPressed}, getSelectStart=${typeof rightPad.getSelectStart}`
          );
        }
        this._padAvailabilityLogged = true;
      }

      // A button - press-and-hold detection (right controller)
      if (rightPad && typeof rightPad.getButtonPressed === "function") {
        try {
          const aButtonPressed = rightPad.getButtonPressed("a-button") || false;
          const wasPressedLastFrame = this._aButtonWasPressed || false;

          // Button just pressed down
          if (aButtonPressed && !wasPressedLastFrame) {
            this.logger.log("A button DOWN (right)");
            if (onAButtonDown) onAButtonDown();
          }
          // Button just released
          else if (!aButtonPressed && wasPressedLastFrame) {
            this.logger.log("A button UP (right)");
            if (onAButtonUp) onAButtonUp();
          }

          this._aButtonWasPressed = aButtonPressed;
        } catch (e) {
          this.logger.warn(`getButtonPressed("a-button") error:`, e);
        }
      }

      // A button - press-and-hold detection (left controller)
      if (leftPad && typeof leftPad.getButtonPressed === "function") {
        try {
          const aButtonPressed = leftPad.getButtonPressed("a-button") || false;
          const wasPressedLastFrame = this._leftAButtonWasPressed || false;

          // Button just pressed down
          if (aButtonPressed && !wasPressedLastFrame) {
            this.logger.log("A button DOWN (left)");
            if (onAButtonDown) onAButtonDown();
          }
          // Button just released
          else if (!aButtonPressed && wasPressedLastFrame) {
            this.logger.log("A button UP (left)");
            if (onAButtonUp) onAButtonUp();
          }

          this._leftAButtonWasPressed = aButtonPressed;
        } catch (e) {
          // Ignore
        }
      }

      // B button: Reset all (edge-triggered on press)
      if (rightPad && typeof rightPad.getButtonDown === "function") {
        try {
          if (rightPad.getButtonDown("b-button")) {
            if (!this._bButtonDownPressed) {
              this.logger.log("B button pressed - resetting all objects");
              if (onBButton) onBButton();
              this._bButtonDownPressed = true;
            }
          } else {
            this._bButtonDownPressed = false;
          }
        } catch (e) {
          this.logger.warn(`getButtonDown("b-button") error:`, e);
        }
      }

      if (leftPad && typeof leftPad.getButtonDown === "function") {
        try {
          if (leftPad.getButtonDown("b-button")) {
            if (!this._leftBButtonDownPressed) {
              this.logger.log(
                "B button pressed (left) - resetting all objects"
              );
              if (onBButton) onBButton();
              this._leftBButtonDownPressed = true;
            }
          } else {
            this._leftBButtonDownPressed = false;
          }
        } catch (e) {
          // Ignore
        }
      }
    } catch (error) {
      this.logger.error("Error in button handling:", error);
    }
  }

  getBestInputTarget(preferRight = true) {
    if (!this.xrInput) return null;

    const targets = [];

    if (preferRight) {
      if (this.xrInput.gamepads?.right?.grip) {
        targets.push({
          target: this.xrInput.gamepads.right.grip,
          type: "right-controller",
        });
      }
      if (this.xrInput.gamepads?.left?.grip) {
        targets.push({
          target: this.xrInput.gamepads.left.grip,
          type: "left-controller",
        });
      }
    } else {
      if (this.xrInput.gamepads?.left?.grip) {
        targets.push({
          target: this.xrInput.gamepads.left.grip,
          type: "left-controller",
        });
      }
      if (this.xrInput.gamepads?.right?.grip) {
        targets.push({
          target: this.xrInput.gamepads.right.grip,
          type: "right-controller",
        });
      }
    }

    if (targets.length === 0) {
      if (preferRight) {
        if (this.xrInput.gamepads?.right?.object3D) {
          targets.push({
            target: this.xrInput.gamepads.right.object3D,
            type: "right-controller",
          });
        }
        if (this.xrInput.gamepads?.left?.object3D) {
          targets.push({
            target: this.xrInput.gamepads.left.object3D,
            type: "left-controller",
          });
        }
      } else {
        if (this.xrInput.gamepads?.left?.object3D) {
          targets.push({
            target: this.xrInput.gamepads.left.object3D,
            type: "left-controller",
          });
        }
        if (this.xrInput.gamepads?.right?.object3D) {
          targets.push({
            target: this.xrInput.gamepads.right.object3D,
            type: "right-controller",
          });
        }
      }
    }

    if (targets.length === 0 && this.xrInput.xrOrigin?.raySpaces) {
      if (preferRight) {
        if (this.xrInput.xrOrigin.raySpaces.right) {
          targets.push({
            target: this.xrInput.xrOrigin.raySpaces.right,
            type: "right-hand",
          });
        }
        if (this.xrInput.xrOrigin.raySpaces.left) {
          targets.push({
            target: this.xrInput.xrOrigin.raySpaces.left,
            type: "left-hand",
          });
        }
      } else {
        if (this.xrInput.xrOrigin.raySpaces.left) {
          targets.push({
            target: this.xrInput.xrOrigin.raySpaces.left,
            type: "left-hand",
          });
        }
        if (this.xrInput.xrOrigin.raySpaces.right) {
          targets.push({
            target: this.xrInput.xrOrigin.raySpaces.right,
            type: "right-hand",
          });
        }
      }
    }

    return targets.length > 0 ? targets[0] : null;
  }

  handleRightControllerMenuInput(rightPad) {
    if (!rightPad) return;

    const bButton = rightPad.buttons?.find((b) => b.name === "b-button");
    if (bButton && bButton.pressed && !this.bButtonWasPressed) {
      this.bButtonWasPressed = true;
      return { action: "capture" };
    } else if (bButton && !bButton.pressed && this.bButtonWasPressed) {
      this.bButtonWasPressed = false;
    }

    return null;
  }

  handlePinchGesture(side, isPinching, positions) {
    if (isPinching && !this.pinchRecordingActive[side]) {
      this.pinchRecordingActive[side] = true;
      return { action: "startRecording", side };
    } else if (!isPinching && this.pinchRecordingActive[side]) {
      this.pinchRecordingActive[side] = false;
      return { action: "stopRecording", side };
    }

    return null;
  }
}
