/**
 * HitTestManager.js - WebXR hit testing for world placement
 *
 * Manages WebXR hit testing to allow controller-based placement of objects
 * in the real world. Coordinates with HitTestVFX for visual feedback.
 *
 * KEY RESPONSIBILITIES:
 * - Initialize hit test sources for left/right controllers
 * - Update hit test results each frame
 * - Handle trigger input for placement callbacks
 * - Coordinate with HitTestVFX for reticle and placed visuals
 */

import { Matrix4, Vector3, Quaternion } from "three";
import { Logger } from "./Logger.js";
import { HitTestVFX } from "../vfx/HitTestVFX.js";
import { gameState } from "../gameState.js";

export class HitTestManager {
  constructor(world, xrInput = null) {
    this.world = world;
    this.xrInput = xrInput;
    this.logger = new Logger("HitTestManager", false);

    // Hit test sources for left/right controllers
    this.hitTestSources = { left: null, right: null, none: null };
    this.hitTestInitialized = false;
    this.xrSession = null;

    // Current hit poses
    this.lastHitPose = { left: null, right: null };
    this.activeHand = null;

    // Surface validity (too steep = invalid)
    this._surfaceValid = false;
    this._maxSlopeAngle = 15 * (Math.PI / 180); // 15 degrees in radians
    this._upVector = new Vector3(0, 1, 0);
    this._surfaceNormal = new Vector3();

    // VFX handler
    this.vfx = new HitTestVFX(world.scene);

    // Colors for valid/invalid surfaces
    this._validColor = 0x00ff88;
    this._invalidColor = 0x666666;

    // Callback for when trigger is pressed but no UI was hit
    this.onEnvironmentSelect = null;

    // Flag to skip placement when UI was hit
    this._uiWasHitThisFrame = false;

    // Control whether placement is enabled - starts disabled
    this.enabled = false;

    this.logger.log("HitTestManager initialized");
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;

    this.enabled = enabled;
    if (!enabled) {
      this.vfx.setReticleVisible(false);
      this.vfx.disposeAllPlacedVisuals();
      // Cancel hit test sources to stop WebXR hit testing overhead
      this._cancelAllHitTestSources();
    }
    this.logger.log(`HitTestManager enabled: ${enabled}`);
  }

  _cancelAllHitTestSources() {
    for (const hand of ["left", "right", "none"]) {
      if (this.hitTestSources[hand]) {
        try {
          this.hitTestSources[hand].cancel?.();
        } catch (e) {
          // Ignore errors during cancel
        }
        this.hitTestSources[hand] = null;
      }
    }
    this.hitTestInitialized = false;
  }

  setXRInput(xrInput) {
    this.xrInput = xrInput;
  }

  markUIHit() {
    this._uiWasHitThisFrame = true;
  }

  async initializeHitTestSources(xrSession) {
    if (this.hitTestInitialized || !xrSession) return;
    this.xrSession = xrSession;

    xrSession.addEventListener("inputsourceschange", (event) => {
      this._handleInputSourcesChange(event);
    });

    if (xrSession.inputSources?.length > 0) {
      this._setupControllerHitTestSources(xrSession);
    }

    this.hitTestInitialized = true;
    this.logger.log(
      "Hit test manager initialized, waiting for controller input sources"
    );
  }

  _handleInputSourcesChange(event) {
    // Don't setup hit test sources if disabled
    if (!this.enabled) return;

    for (const source of event.added) {
      if (source.targetRayMode === "tracked-pointer") {
        this._setupHitTestForInputSource(source, this.xrSession);
      }
    }
  }

  async _setupControllerHitTestSources(xrSession) {
    if (!this.enabled) return;

    for (const source of xrSession.inputSources) {
      if (source.targetRayMode === "tracked-pointer") {
        await this._setupHitTestForInputSource(source, xrSession);
      }
    }
  }

  async _setupHitTestForInputSource(inputSource, xrSession) {
    // Don't setup if disabled
    if (!this.enabled) return;

    const hand = inputSource.handedness;

    if (this.hitTestSources[hand]) {
      try {
        this.hitTestSources[hand].cancel?.();
      } catch (e) {
        // Ignore - might already be invalid
      }
      this.hitTestSources[hand] = null;
    }

    try {
      const hitTestSource = await xrSession.requestHitTestSource({
        space: inputSource.targetRaySpace,
        entityTypes: ["plane", "point"],
      });

      this.hitTestSources[hand] = hitTestSource;
      this.logger.log(`Controller hit test source created for ${hand} hand`);
    } catch (error) {
      this.logger.warn(`Failed to create hit test source for ${hand}:`, error);
    }
  }

  update(xrFrame, delta = 0.016) {
    if (!xrFrame) return;

    // Disable during room setup
    const state = gameState.getState();
    if (state.roomSetupRequired === true) {
      this.vfx.setReticleVisible(false);
      this._uiWasHitThisFrame = false;
      return;
    }

    if (!this.enabled) {
      this.vfx.setReticleVisible(false);
      this._uiWasHitThisFrame = false;
      return;
    }

    this._updateHitTest(xrFrame);
    this.vfx.update(delta);
    this._handleTriggerInput();
    this._uiWasHitThisFrame = false;
  }

  _updateHitTest(xrFrame) {
    for (const hand of ["right", "left", "none"]) {
      const hitTestSource = this.hitTestSources[hand];
      if (!hitTestSource) continue;

      try {
        const xrRefSpace = this.world.renderer?.xr?.getReferenceSpace?.();
        if (!xrRefSpace) continue;

        const hitTestResults = xrFrame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
          const pose = hitTestResults[0].getPose(xrRefSpace);
          if (pose) {
            this.lastHitPose.right = pose;
            this.activeHand = hand;

            // Extract surface normal from pose matrix (Y-axis of rotation)
            const m = pose.transform.matrix;
            this._surfaceNormal.set(m[4], m[5], m[6]).normalize();

            // Check angle from vertical - dot product with up vector
            const dot = this._surfaceNormal.dot(this._upVector);
            const angle = Math.acos(Math.min(1, Math.abs(dot)));
            this._surfaceValid = angle <= this._maxSlopeAngle;

            this.vfx.setReticleVisible(true);
            this.vfx.setReticleMatrix(pose.transform.matrix);
            this.vfx.setReticleColor(
              this._surfaceValid ? this._validColor : this._invalidColor
            );
            return;
          }
        }
      } catch (error) {
        this.hitTestSources[hand] = null;
      }
    }

    this.vfx.setReticleVisible(false);
    this.lastHitPose.right = null;
    this._surfaceValid = false;
  }

  _handleTriggerInput() {
    let selectStart = false;

    // Check if hands are active via gameState (set by XrInputSystem)
    const state = gameState.getState();
    const inputModeHands = state.inputMode === "hands";

    // Also check session input sources for 10+ buttons (hand tracking indicator)
    const session = this.world.renderer?.xr?.getSession?.();
    let sessionHasHands = false;
    if (session?.inputSources) {
      for (const inputSource of session.inputSources) {
        if (inputSource.gamepad?.buttons?.length >= 10) {
          sessionHasHands = true;
          break;
        }
      }
    }

    const handsActive = inputModeHands || sessionHasHands;

    if (handsActive) {
      // Hands mode: ONLY use tap-thumb microgesture (button 9)
      // Per oculus-hand.json: https://github.com/immersive-web/webxr-input-profiles/blob/main/packages/registry/profiles/oculus/oculus-hand.json
      if (session?.inputSources) {
        for (const inputSource of session.inputSources) {
          if (!inputSource.gamepad) continue;
          const buttons = inputSource.gamepad.buttons;
          if (buttons.length >= 10) {
            const tapButton = buttons[9];
            const tapPressed = tapButton?.pressed || tapButton?.value > 0.5;
            const wasTapped = this._tapWasPressed || false;
            this._tapWasPressed = tapPressed;
            if (tapPressed && !wasTapped) {
              selectStart = true;
              break;
            }
          }
        }
      }
    } else {
      // Controller mode: use standard trigger
      const rightPad = this.xrInput?.gamepads?.right;
      if (rightPad?.getSelectStart?.()) {
        selectStart = true;
      }
    }

    if (selectStart) {
      if (this._uiWasHitThisFrame) {
        this.logger.log(
          "Select pressed - UI was hit, skipping environment placement"
        );
        return;
      }

      if (!this._surfaceValid) {
        this.logger.log(
          "Select pressed - surface too steep, placement blocked"
        );
        return;
      }

      if (this.vfx.reticle?.visible && this.lastHitPose.right) {
        const matrix = new Matrix4().fromArray(
          this.lastHitPose.right.transform.matrix
        );
        const position = new Vector3();
        const quat = new Quaternion();
        const scale = new Vector3();
        matrix.decompose(position, quat, scale);
        this.vfx.createPlacedVisual(position);

        if (this.onEnvironmentSelect) {
          this.onEnvironmentSelect(this.lastHitPose.right);
        }
      }
    }
  }

  setReticleVisible(visible) {
    this.vfx.setReticleVisible(visible && this.lastHitPose.right !== null);
  }

  setReticleColor(color) {
    this.vfx.setReticleColor(color);
  }

  scaleOutAllPlacedVisuals() {
    this.vfx.scaleOutAllPlacedVisuals();
  }

  get reticle() {
    return this.vfx.reticle;
  }

  dispose() {
    this.vfx.dispose();

    for (const side of ["left", "right", "none"]) {
      if (this.hitTestSources[side]) {
        this.hitTestSources[side].cancel?.();
        this.hitTestSources[side] = null;
      }
    }
    this.xrSession = null;

    this.logger.log("HitTestManager disposed");
  }
}
