/**
 * RoomCaptureUI.js - 3D SPATIAL UI FOR ROOM CAPTURE PROMPT
 * =============================================================================
 *
 * ROLE: Displays a 3D panel prompting the user to confirm room capture for
 * Meta Quest spatial anchoring. Floats in front of user and smoothly follows
 * head position.
 *
 * KEY RESPONSIBILITIES:
 * - Create 3D panel using IWSDK PanelUI
 * - Position panel centered in front of user's view
 * - Smooth position/rotation interpolation to follow head
 * - Handle confirm button press via A button
 * - Show/hide based on RobotSystem room capture state
 *
 * PANEL BEHAVIOR:
 * - Spawns at centerOffset (0, -0.1, -0.6) from head
 * - Lerps position/rotation to track head movement
 * - Uses PanelDocument for DOM-in-3D rendering
 *
 * BUTTON HANDLING:
 * A button press triggers onConfirm callback when panel visible.
 * RobotSystem intercepts A button and routes to this UI first.
 *
 * USAGE: Created by RobotSystem, shown when room capture needed.
 * Registered with UIStateManager for visibility coordination.
 * =============================================================================
 */

import { PanelUI, PanelDocument } from "@iwsdk/core";
import { Group, Vector3, Quaternion } from "three";
import { Logger } from "../utils/Logger.js";
import { uiAudio } from "../audio/UIAudio.js";
import { hapticManager } from "../utils/HapticManager.js";
import { ThumbTapRenderer } from "./ThumbTapRenderer.js";
import { gameState } from "../gameState.js";

export class RoomCaptureUI {
  constructor(world, options = {}) {
    this.world = world;
    this.logger = new Logger("RoomCaptureUI", false);

    this.isVisible = false;
    this.panelEntity = null;
    this.panelDocument = null;
    this.mountGroup = null;

    this.onConfirm = options.onConfirm || null;

    this.panelMaxWidth = 0.35;
    this.panelMaxHeight = 0.35;

    this._targetPosition = new Vector3();
    this._targetQuaternion = new Quaternion();
    this._currentPosition = new Vector3();
    this._currentQuaternion = new Quaternion();
    this._positionInitialized = false;

    this._positionLerpFactor = 0.06;
    this._rotationLerpFactor = 0.05;
    this._centerOffset = new Vector3(0, -0.1, -0.6);
    this._tempGroup = new Group(); // Reusable for lookAt calculation

    this._pendingDocument = false;
    this._documentAttempts = 0;
    this._maxDocumentAttempts = 300;

    this.inputMode = "controllers";
    this.thumbTap = new ThumbTapRenderer({
      size: 0.038,
      position: { x: 0.115, y: -0.08, z: 0.01 },
    });
    this._thumbTapCreated = false;
    this._boundOnStateChange = null;
  }

  async initialize() {
    this._createMountGroup();
    await this._createPanel();

    // Listen for input mode changes
    this._boundOnStateChange = (newState, prevState) => {
      if (newState.inputMode !== prevState.inputMode) {
        this.updateInputModeUI(newState.inputMode);
      }
    };
    gameState.on("state:changed", this._boundOnStateChange);

    const state = gameState.getState();
    this.updateInputModeUI(state.inputMode);

    this.logger.log("RoomCaptureUI initialized");
  }

  _createMountGroup() {
    this.mountGroup = new Group();
    this.mountGroup.name = "roomCapture-mount";
    this.world.scene.add(this.mountGroup);
    this.mountGroup.visible = false;
    this.mountGroup.frustumCulled = false;
  }

  async _createPanel() {
    const entity = this.world.createEntity();
    const group = new Group();
    group.name = "roomCapture-panel";
    entity.object3D = group;

    this.mountGroup.add(group);

    entity.addComponent(PanelUI, {
      config: "./ui/roomCapture.json",
      maxWidth: this.panelMaxWidth,
      maxHeight: this.panelMaxHeight,
    });

    group.frustumCulled = false;
    group.visible = true;

    this.panelEntity = entity;
    this.panelGroup = group;

    this._pendingDocument = true;
    this._documentAttempts = 0;
  }

  _pollDocument() {
    if (!this._pendingDocument) {
      // Check for pending failure update after document is ready
      if (this._pendingFailureUpdate && this.panelDocument) {
        this._updateToFailureState();
      }
      return;
    }

    this._documentAttempts++;
    const doc = PanelDocument?.data?.document?.[this.panelEntity.index];

    if (doc) {
      this.panelDocument = doc;
      this._setupInteractions(doc);
      this._pendingDocument = false;
      this.logger.log(
        `Panel document ready after ${this._documentAttempts} frames`
      );

      // If failure state was requested before doc was ready, apply it now
      if (this._pendingFailureUpdate) {
        this._updateToFailureState();
      }
    } else if (this._documentAttempts >= this._maxDocumentAttempts) {
      this._pendingDocument = false;
      this.logger.warn("Panel document timeout");
    }
  }

  _setupInteractions(doc) {
    const confirmBtn = doc.getElementById("confirm-btn");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => {
        this.logger.log("Confirm button clicked");
        uiAudio.confirm();
        hapticManager.pulseBoth(0.7, 60);
        if (this.onConfirm) {
          this.onConfirm();
        }
      });
    }
  }

  show() {
    if (this.isVisible) return;
    this.isVisible = true;
    this.isFailureState = false;
    this.mountGroup.visible = true;

    uiAudio.notification();
    hapticManager.pulseBoth(0.5, 50);

    this.mountGroup.traverse((child) => {
      child.frustumCulled = false;
      if (child.layers) child.layers.enableAll();
    });

    if (this.inputMode === "hands") {
      this._ensureThumbTapCreated();
      this.thumbTap.show();
    }

    this.logger.log("RoomCaptureUI shown");
  }

  showFailure() {
    this.isVisible = true;
    this.isFailureState = true;
    this.mountGroup.visible = true;

    uiAudio.error();
    hapticManager.pulseBoth(0.8, 100);

    this.mountGroup.traverse((child) => {
      child.frustumCulled = false;
      if (child.layers) child.layers.enableAll();
    });

    this.thumbTap.hide();
    this._updateToFailureState();

    this.logger.log("RoomCaptureUI showing FAILURE state");
  }

  _updateToFailureState() {
    if (!this.panelDocument) {
      // Document not ready yet, retry on next poll
      this._pendingFailureUpdate = true;
      return;
    }

    const title = this.panelDocument.getElementById("title-text");
    const messageText = this.panelDocument.getElementById("message-text");
    const messageHighlight =
      this.panelDocument.getElementById("message-highlight");
    const confirmRow = this.panelDocument.getElementById("confirm-btn");

    // Update title to error
    if (title && title.setProperties) {
      title.setProperties({ text: "❌ ROOM SETUP FAILED" });
    }

    // Update message
    if (messageText && messageText.setProperties) {
      messageText.setProperties({
        text: "Room capture failed. Meta Quest only allows one room capture attempt per browser session.",
      });
    }

    if (messageHighlight && messageHighlight.setProperties) {
      messageHighlight.setProperties({
        text: "Refresh the browser to try again, or set up your Space in Quest Settings > Physical Space > Space Setup.",
      });
    }

    // Hide the confirm button (no action possible)
    if (confirmRow && confirmRow.setProperties) {
      confirmRow.setProperties({ display: "none" });
    }

    this._pendingFailureUpdate = false;
    this.logger.log("Updated panel to failure state");
  }

  hide() {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.mountGroup.visible = false;
    this.thumbTap.hide();
    this.logger.log("RoomCaptureUI hidden");
  }

  handleButtonPress(button) {
    if (this.isFailureState) return false;
    if (!this.isVisible) return false;

    if (button === "a" || button === "trigger") {
      this.logger.log("A/trigger pressed - confirming");
      uiAudio.confirm();
      hapticManager.pulseBoth(0.7, 60);
      if (this.onConfirm) {
        this.onConfirm();
      }
      return true;
    }
    return false;
  }

  updateInputModeUI(inputMode) {
    this.inputMode = inputMode;
    if (!this.panelDocument) return;

    const buttonHint = this.panelDocument.getElementById("button-hint");
    const confirmText = this.panelDocument.getElementById("confirm-text");

    this._ensureThumbTapCreated();

    if (inputMode === "hands") {
      if (buttonHint) buttonHint.setProperties({ display: "none" });
      if (this.isVisible && !this.isFailureState) {
        this.thumbTap.show();
      }
      if (confirmText) confirmText.setProperties({ text: "THUMBTAP TO START" });
    } else {
      if (buttonHint) buttonHint.setProperties({ display: "flex" });
      this.thumbTap.hide();
      if (confirmText) confirmText.setProperties({ text: "PRESS TO START" });
    }
  }

  _ensureThumbTapCreated() {
    if (this._thumbTapCreated) return;
    if (this.panelGroup) {
      this.thumbTap.create(this.panelGroup);
      this._thumbTapCreated = true;
    }
  }

  update() {
    // Only poll document when pending (needed even when hidden)
    if (this._pendingDocument || this._pendingFailureUpdate) {
      this._pollDocument();
    }

    // Skip all other updates when not visible
    if (!this.isVisible || !this.mountGroup) return;

    if (!this._thumbTapCreated && this.inputMode === "hands") {
      this._ensureThumbTapCreated();
    }
    if (
      this.inputMode === "hands" &&
      !this.isFailureState &&
      this.thumbTap.ready &&
      this.thumbTap.mesh &&
      !this.thumbTap.mesh.visible
    ) {
      this.thumbTap.show();
    }
    this.thumbTap.update();

    this._calculateTarget();
    this._applySmoothFollow();
  }

  _calculateTarget() {
    const camera = this.world.camera;
    if (!camera) return;

    const camPos = new Vector3();
    const camQuat = new Quaternion();
    camera.getWorldPosition(camPos);
    camera.getWorldQuaternion(camQuat);

    const offset = this._centerOffset.clone();
    offset.applyQuaternion(camQuat);

    this._targetPosition.copy(camPos).add(offset);

    this._tempGroup.position.copy(this._targetPosition);
    this._tempGroup.lookAt(camPos);
    this._targetQuaternion.copy(this._tempGroup.quaternion);
  }

  _applySmoothFollow() {
    if (!this._positionInitialized) {
      this._currentPosition.copy(this._targetPosition);
      this._currentQuaternion.copy(this._targetQuaternion);
      this._positionInitialized = true;
    } else {
      this._currentPosition.lerp(
        this._targetPosition,
        this._positionLerpFactor
      );
      this._currentQuaternion.slerp(
        this._targetQuaternion,
        this._rotationLerpFactor
      );
    }

    this.mountGroup.position.copy(this._currentPosition);
    this.mountGroup.quaternion.copy(this._currentQuaternion);
  }

  destroy() {
    if (this._boundOnStateChange) {
      gameState.off("state:changed", this._boundOnStateChange);
      this._boundOnStateChange = null;
    }

    if (this.panelGroup && this.panelGroup.parent) {
      this.panelGroup.parent.remove(this.panelGroup);
    }
    if (this.panelEntity && this.world) {
      this.world.removeEntity(this.panelEntity);
    }
    if (this.mountGroup) {
      this.world.scene.remove(this.mountGroup);
    }

    this.thumbTap.dispose();

    this.panelEntity = null;
    this.panelDocument = null;
    this.mountGroup = null;
  }
}
