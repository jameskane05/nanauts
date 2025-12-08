/**
 * SpatialMountManager.js - MOUNT GROUP POSITIONING FOR SPATIAL UI
 * =============================================================================
 *
 * Pure positioning module for spatial UI panels. Handles mount group creation,
 * position/rotation tracking, smooth lerping, and world-space billboarding.
 * Updated every frame regardless of which panels are active.
 *
 * MOUNT TYPES:
 * - WRIST: Follows controller grip with offset, billboards to camera
 * - HUD: Top-right camera follow
 * - CENTER: Centered in front of camera
 * - SCORE: Top-left camera follow (opposite HUD)
 * - WORLD: Fixed world position with billboarding + floating animation
 * =============================================================================
 */

import { Group } from "@iwsdk/core";
import { Vector3, Quaternion } from "three";
import { Logger } from "../utils/Logger.js";

export const ATTACHMENT_MODE = {
  WRIST: "wrist",
  HUD: "hud",
  CENTER: "center",
  SCORE: "score",
  WORLD: "world",
};

export class SpatialMountManager {
  constructor(world, options = {}) {
    this.world = world;
    this.logger = new Logger("SpatialMount", options.debug ?? false);
    this.preferHand = options.preferHand || "right";

    // Mount groups
    this.wristMountGroup = null;
    this.hudMountGroup = null;
    this.centerMountGroup = null;
    this.scoreMountGroup = null;
    this.worldMountGroup = null;

    this.isAttached = false;
    this._xrInput = null;

    // Reusable temp vectors (avoid per-frame allocations)
    this._tempPos = new Vector3();
    this._tempQuat = new Quaternion();
    this._tempOffset = new Vector3();
    this._tempCamPos = new Vector3();
    this._tempCamQuat = new Quaternion();
    this._tempLookAtGroup = new Group();

    // Smooth follow parameters
    this._positionLerpFactor = 0.08;
    this._rotationLerpFactor = 0.06;

    // Panel offset from wrist - different for hand tracking vs controllers
    this.panelOffsetController = new Vector3(0.05, 0.12, -0.12);
    this.panelOffsetHand = new Vector3(0.05, 0.2, -0.12); // No Y offset for hand tracking
    this.panelOffset = new Vector3(0.05, 0.12, -0.12); // Current active offset
    this._lastInputMode = null; // Track input mode changes

    // Mount offsets from camera
    this._hudOffset = new Vector3(0.2, 0.1, -0.5);
    this._centerOffset = new Vector3(0, 0, -0.6);
    this._scoreOffset = new Vector3(-0.18, 0.1, -0.5);

    // Wrist mount tracking
    this._wristTargetPosition = new Vector3();
    this._wristTargetQuaternion = new Quaternion();
    this._wristCurrentPosition = new Vector3();
    this._wristCurrentQuaternion = new Quaternion();
    this._wristPositionInitialized = false;

    // HUD mount tracking
    this._hudTargetPosition = new Vector3();
    this._hudTargetQuaternion = new Quaternion();
    this._hudCurrentPosition = new Vector3();
    this._hudCurrentQuaternion = new Quaternion();
    this._hudPositionInitialized = false;

    // Center mount tracking
    this._centerTargetPosition = new Vector3();
    this._centerTargetQuaternion = new Quaternion();
    this._centerCurrentPosition = new Vector3();
    this._centerCurrentQuaternion = new Quaternion();
    this._centerPositionInitialized = false;

    // Score mount tracking
    this._scoreTargetPosition = new Vector3();
    this._scoreTargetQuaternion = new Quaternion();
    this._scoreCurrentPosition = new Vector3();
    this._scoreCurrentQuaternion = new Quaternion();
    this._scorePositionInitialized = false;

    // World mount tracking
    this._worldBasePosition = new Vector3();
    this._worldSurfaceNormal = new Vector3(0, 1, 0);
    this._worldTargetPosition = new Vector3();
    this._worldTargetQuaternion = new Quaternion();
    this._worldCurrentPosition = new Vector3();
    this._worldCurrentQuaternion = new Quaternion();
    this._worldPositionInitialized = false;
    this._worldFloatTime = 0;
    this._worldFloatAmplitude = 0.02;
    this._worldFloatSpeed = 1.5;
    this._worldHeightOffset = 1.5;
    this._worldModeActive = false;
  }

  createMountGroups() {
    this.wristMountGroup = new Group();
    this.wristMountGroup.name = "spatialUI-wrist-mount";
    this.world.scene.add(this.wristMountGroup);
    this.wristMountGroup.visible = false;
    this.wristMountGroup.frustumCulled = false;

    this.hudMountGroup = new Group();
    this.hudMountGroup.name = "spatialUI-hud-mount";
    this.world.scene.add(this.hudMountGroup);
    this.hudMountGroup.visible = false;
    this.hudMountGroup.frustumCulled = false;

    this.centerMountGroup = new Group();
    this.centerMountGroup.name = "spatialUI-center-mount";
    this.world.scene.add(this.centerMountGroup);
    this.centerMountGroup.visible = false;
    this.centerMountGroup.frustumCulled = false;

    this.scoreMountGroup = new Group();
    this.scoreMountGroup.name = "spatialUI-score-mount";
    this.world.scene.add(this.scoreMountGroup);
    this.scoreMountGroup.visible = false;
    this.scoreMountGroup.frustumCulled = false;

    this.worldMountGroup = new Group();
    this.worldMountGroup.name = "spatialUI-world-mount";
    this.world.scene.add(this.worldMountGroup);
    this.worldMountGroup.visible = false;
    this.worldMountGroup.frustumCulled = false;

    this.logger.log("Mount groups created");
  }

  getMountGroup(mode) {
    switch (mode) {
      case ATTACHMENT_MODE.HUD:
        return this.hudMountGroup;
      case ATTACHMENT_MODE.CENTER:
        return this.centerMountGroup;
      case ATTACHMENT_MODE.SCORE:
        return this.scoreMountGroup;
      case ATTACHMENT_MODE.WORLD:
        return this.worldMountGroup;
      case ATTACHMENT_MODE.WRIST:
      default:
        return this.wristMountGroup;
    }
  }

  setMountVisibility(mode, visible) {
    const group = this.getMountGroup(mode);
    if (group) group.visible = visible;
  }

  updateMounts(xrInput, isXRActive, activeMounts = new Set()) {
    if (!this.wristMountGroup || !xrInput || !isXRActive) {
      return false;
    }

    this._xrInput = xrInput;

    // Detect input mode and update offset if changed
    this._updateInputMode(xrInput);

    // Update visibility based on active mounts
    this.wristMountGroup.visible = activeMounts.has(ATTACHMENT_MODE.WRIST);
    this.hudMountGroup.visible = activeMounts.has(ATTACHMENT_MODE.HUD);
    this.centerMountGroup.visible = activeMounts.has(ATTACHMENT_MODE.CENTER);
    this.worldMountGroup.visible = activeMounts.has(ATTACHMENT_MODE.WORLD);

    // Wrist mount follows controller (skip if invisible)
    if (this.wristMountGroup.visible) {
      const controller = this._findController(xrInput);
      if (controller) {
        this._calculateWristTarget(controller);
        this._applyWristSmoothFollow();
      } else if (!this._wristPositionInitialized) {
        this._placeAtDefaultPosition();
        this._wristCurrentPosition.copy(this.wristMountGroup.position);
        this._wristCurrentQuaternion.copy(this.wristMountGroup.quaternion);
        this._wristPositionInitialized = true;
      }
    }

    // HUD mount follows camera (skip if invisible)
    if (this.hudMountGroup.visible) {
      this._calculateHUDTarget();
      this._applyHUDSmoothFollow();
    }

    // Center mount follows camera (skip if invisible)
    if (this.centerMountGroup.visible) {
      this._calculateCenterTarget();
      this._applyCenterSmoothFollow();
    }

    // Score mount follows camera (skip if invisible)
    if (this.scoreMountGroup?.visible) {
      this._calculateScoreTarget();
      this._applyScoreSmoothFollow();
    }

    // World mount - fixed position with float + billboard (skip if invisible)
    if (this.worldMountGroup?.visible || this._worldModeActive) {
      this._calculateWorldTarget();
      this._applyWorldSmoothFollow();
    }

    if (!this.isAttached) {
      this.isAttached = true;
      this.logger.log("Mount groups attached");
    }

    return true;
  }

  // Force-update a specific mount's position (for smooth transitions)
  forceUpdateMountPosition(mode) {
    switch (mode) {
      case ATTACHMENT_MODE.WRIST:
        const controller = this._findController(this._xrInput);
        if (controller) {
          this._calculateWristTarget(controller);
          // Snap to target immediately
          this._wristCurrentPosition.copy(this._wristTargetPosition);
          this._wristCurrentQuaternion.copy(this._wristTargetQuaternion);
          this._applyWristSmoothFollow();
        }
        break;
      case ATTACHMENT_MODE.HUD:
        this._calculateHUDTarget();
        this._hudCurrentPosition.copy(this._hudTargetPosition);
        this._hudCurrentQuaternion.copy(this._hudTargetQuaternion);
        this._applyHUDSmoothFollow();
        break;
      case ATTACHMENT_MODE.CENTER:
        this._calculateCenterTarget();
        this._centerCurrentPosition.copy(this._centerTargetPosition);
        this._centerCurrentQuaternion.copy(this._centerTargetQuaternion);
        this._applyCenterSmoothFollow();
        break;
      case ATTACHMENT_MODE.WORLD:
        if (this._worldModeActive) {
          this._calculateWorldTarget();
          this._worldCurrentPosition.copy(this._worldTargetPosition);
          this._worldCurrentQuaternion.copy(this._worldTargetQuaternion);
          this._applyWorldSmoothFollow();
        }
        break;
    }
  }

  setWorldTarget(position, surfaceNormal = new Vector3(0, 1, 0), options = {}) {
    this._worldBasePosition.copy(position);
    this._worldSurfaceNormal.copy(surfaceNormal).normalize();
    this._worldFloatTime = 0;
    this._worldPositionInitialized = false;

    if (options.heightOffset !== undefined) {
      this._worldHeightOffset = options.heightOffset;
    }
    if (options.floatAmplitude !== undefined) {
      this._worldFloatAmplitude = options.floatAmplitude;
    }
    if (options.floatSpeed !== undefined) {
      this._worldFloatSpeed = options.floatSpeed;
    }

    this._worldModeActive = true;

    this.logger.log(
      `World target set at (${position.x.toFixed(2)}, ${position.y.toFixed(
        2
      )}, ${position.z.toFixed(2)})`
    );
  }

  clearWorldTarget() {
    this._worldModeActive = false;
    this._worldPositionInitialized = false;
    this.logger.log("World target cleared");
  }

  isWorldModeActive() {
    return this._worldModeActive;
  }

  _updateInputMode(xrInput) {
    // Detect if we're using hand tracking vs controllers
    let isHandTracking = false;

    // Check gamepads - controllers have grip, hands don't
    const gamepads = xrInput.gamepads;
    const prefer = this.preferHand;
    const other = prefer === "left" ? "right" : "left";

    let hasControllerGrip = false;
    for (const hand of [prefer, other]) {
      const pad = gamepads?.[hand];
      if (pad?.grip) {
        hasControllerGrip = true;
        break;
      }
    }

    // If no controller grip found, likely hand tracking
    if (!hasControllerGrip) {
      // Check if we have raySpaces but no grip - indicates hand tracking
      const raySpaces = xrInput.xrOrigin?.raySpaces;
      if (raySpaces?.[prefer] || raySpaces?.[other]) {
        isHandTracking = true;
      }
    }

    const currentInputMode = isHandTracking ? "hands" : "controllers";

    // Update offset if input mode changed
    if (this._lastInputMode !== currentInputMode) {
      this._lastInputMode = currentInputMode;
      this.panelOffset.copy(
        isHandTracking ? this.panelOffsetHand : this.panelOffsetController
      );

      // Reset position initialization so it snaps to new offset
      this._wristPositionInitialized = false;

      this.logger.log(
        `Input mode changed to ${currentInputMode}, offset: (${this.panelOffset.x.toFixed(
          3
        )}, ${this.panelOffset.y.toFixed(3)}, ${this.panelOffset.z.toFixed(3)})`
      );
    }
  }

  _findController(xrInput) {
    const gamepads = xrInput.gamepads;
    const prefer = this.preferHand;
    const other = prefer === "left" ? "right" : "left";

    for (const hand of [prefer, other]) {
      const pad = gamepads?.[hand];
      if (pad?.grip) return pad.grip;
      if (pad?.object3D) return pad.object3D;
    }

    const raySpaces = xrInput.xrOrigin?.raySpaces;
    if (raySpaces?.[prefer]) return raySpaces[prefer];
    if (raySpaces?.[other]) return raySpaces[other];

    return null;
  }

  _calculateWristTarget(controller) {
    if (controller.getWorldPosition) {
      controller.getWorldPosition(this._wristTargetPosition);
      controller.getWorldQuaternion(this._wristTargetQuaternion);
    } else if (controller.position) {
      this._wristTargetPosition.copy(controller.position);
      this._wristTargetQuaternion.copy(controller.quaternion);
      if (controller.parent) {
        controller.updateMatrixWorld(true);
        controller.getWorldPosition(this._wristTargetPosition);
        controller.getWorldQuaternion(this._wristTargetQuaternion);
      }
    }

    this._tempOffset.copy(this.panelOffset);
    this._tempOffset.applyQuaternion(this._wristTargetQuaternion);
    this._wristTargetPosition.add(this._tempOffset);

    if (this.world.camera) {
      const lookAt = this.world.camera.position.clone();
      const tempGroup = new Group();
      tempGroup.position.copy(this._wristTargetPosition);
      tempGroup.lookAt(lookAt);
      this._wristTargetQuaternion.copy(tempGroup.quaternion);
    }
  }

  _applyWristSmoothFollow() {
    if (!this._wristPositionInitialized) {
      this._wristCurrentPosition.copy(this._wristTargetPosition);
      this._wristCurrentQuaternion.copy(this._wristTargetQuaternion);
      this._wristPositionInitialized = true;
    } else {
      this._wristCurrentPosition.lerp(
        this._wristTargetPosition,
        this._positionLerpFactor
      );
      this._wristCurrentQuaternion.slerp(
        this._wristTargetQuaternion,
        this._rotationLerpFactor
      );
    }

    this.wristMountGroup.position.copy(this._wristCurrentPosition);
    this.wristMountGroup.quaternion.copy(this._wristCurrentQuaternion);
  }

  _calculateHUDTarget() {
    const camera = this.world.camera;
    if (!camera) return;

    camera.getWorldPosition(this._tempCamPos);
    camera.getWorldQuaternion(this._tempCamQuat);

    this._tempOffset.copy(this._hudOffset).applyQuaternion(this._tempCamQuat);
    this._hudTargetPosition.copy(this._tempCamPos).add(this._tempOffset);

    this._tempLookAtGroup.position.copy(this._hudTargetPosition);
    this._tempLookAtGroup.lookAt(this._tempCamPos);
    this._hudTargetQuaternion.copy(this._tempLookAtGroup.quaternion);
  }

  _applyHUDSmoothFollow() {
    if (!this._hudPositionInitialized) {
      this._hudCurrentPosition.copy(this._hudTargetPosition);
      this._hudCurrentQuaternion.copy(this._hudTargetQuaternion);
      this._hudPositionInitialized = true;
    } else {
      this._hudCurrentPosition.lerp(
        this._hudTargetPosition,
        this._positionLerpFactor
      );
      this._hudCurrentQuaternion.slerp(
        this._hudTargetQuaternion,
        this._rotationLerpFactor
      );
    }

    this.hudMountGroup.position.copy(this._hudCurrentPosition);
    this.hudMountGroup.quaternion.copy(this._hudCurrentQuaternion);
  }

  _calculateCenterTarget() {
    const camera = this.world.camera;
    if (!camera) return;

    camera.getWorldPosition(this._tempCamPos);
    camera.getWorldQuaternion(this._tempCamQuat);

    this._tempOffset
      .copy(this._centerOffset)
      .applyQuaternion(this._tempCamQuat);
    this._centerTargetPosition.copy(this._tempCamPos).add(this._tempOffset);

    this._tempLookAtGroup.position.copy(this._centerTargetPosition);
    this._tempLookAtGroup.lookAt(this._tempCamPos);
    this._centerTargetQuaternion.copy(this._tempLookAtGroup.quaternion);
  }

  _applyCenterSmoothFollow() {
    if (!this._centerPositionInitialized) {
      this._centerCurrentPosition.copy(this._centerTargetPosition);
      this._centerCurrentQuaternion.copy(this._centerTargetQuaternion);
      this._centerPositionInitialized = true;
    } else {
      this._centerCurrentPosition.lerp(
        this._centerTargetPosition,
        this._positionLerpFactor
      );
      this._centerCurrentQuaternion.slerp(
        this._centerTargetQuaternion,
        this._rotationLerpFactor
      );
    }

    this.centerMountGroup.position.copy(this._centerCurrentPosition);
    this.centerMountGroup.quaternion.copy(this._centerCurrentQuaternion);
  }

  _calculateScoreTarget() {
    const camera = this.world.camera;
    if (!camera) return;

    camera.getWorldPosition(this._tempCamPos);
    camera.getWorldQuaternion(this._tempCamQuat);

    this._tempOffset.copy(this._scoreOffset).applyQuaternion(this._tempCamQuat);
    this._scoreTargetPosition.copy(this._tempCamPos).add(this._tempOffset);
    this._scoreTargetQuaternion.copy(this._tempCamQuat);
  }

  _applyScoreSmoothFollow() {
    if (!this._scorePositionInitialized) {
      this._scoreCurrentPosition.copy(this._scoreTargetPosition);
      this._scoreCurrentQuaternion.copy(this._scoreTargetQuaternion);
      this._scorePositionInitialized = true;
    }

    this._scoreCurrentPosition.lerp(
      this._scoreTargetPosition,
      this._positionLerpFactor
    );
    this._scoreCurrentQuaternion.slerp(
      this._scoreTargetQuaternion,
      this._rotationLerpFactor
    );

    this.scoreMountGroup.position.copy(this._scoreCurrentPosition);
    this.scoreMountGroup.quaternion.copy(this._scoreCurrentQuaternion);
  }

  _calculateWorldTarget() {
    const camera = this.world.camera;
    if (!camera) return;

    this._worldFloatTime += 1 / 60;

    const floatOffset =
      Math.sin(this._worldFloatTime * this._worldFloatSpeed * Math.PI * 2) *
      this._worldFloatAmplitude;

    this._tempOffset
      .copy(this._worldSurfaceNormal)
      .multiplyScalar(this._worldHeightOffset + floatOffset);
    this._worldTargetPosition
      .copy(this._worldBasePosition)
      .add(this._tempOffset);

    camera.getWorldPosition(this._tempCamPos);

    this._tempLookAtGroup.position.copy(this._worldTargetPosition);
    this._tempLookAtGroup.lookAt(this._tempCamPos);
    this._worldTargetQuaternion.copy(this._tempLookAtGroup.quaternion);
  }

  _applyWorldSmoothFollow() {
    if (!this._worldPositionInitialized) {
      this._worldCurrentPosition.copy(this._worldTargetPosition);
      this._worldCurrentQuaternion.copy(this._worldTargetQuaternion);
      this._worldPositionInitialized = true;
    }

    this._worldCurrentPosition.lerp(
      this._worldTargetPosition,
      this._positionLerpFactor * 0.7
    );
    this._worldCurrentQuaternion.slerp(
      this._worldTargetQuaternion,
      this._rotationLerpFactor
    );

    this.worldMountGroup.position.copy(this._worldCurrentPosition);
    this.worldMountGroup.quaternion.copy(this._worldCurrentQuaternion);
  }

  _placeAtDefaultPosition() {
    if (!this.wristMountGroup) return;

    let camera = this.world.camera;
    if (!camera) {
      camera = this.world.player?.head?.object3D || this.world.player?.object3D;
    }

    if (camera) {
      const forward = new Vector3(0, 0, -0.5);
      forward.applyQuaternion(camera.quaternion);
      this.wristMountGroup.position.copy(camera.position).add(forward);
      this.wristMountGroup.position.y -= 0.1;
      this.wristMountGroup.lookAt(camera.position);
    } else {
      this.wristMountGroup.position.set(0, 1.5, -0.5);
      this.wristMountGroup.rotation.set(0, 0, 0);
    }

    this.wristMountGroup.visible = true;
    this.wristMountGroup.updateMatrixWorld(true);
  }

  getXRInput() {
    return this._xrInput;
  }

  setPreferHand(hand) {
    if (hand !== "left" && hand !== "right") return;
    if (this.preferHand === hand) return;

    this.preferHand = hand;
    this._wristPositionInitialized = false;
    this.logger.log(`Prefer hand changed to: ${hand}`);
  }

  destroy() {
    if (this.wristMountGroup) this.world.scene.remove(this.wristMountGroup);
    if (this.hudMountGroup) this.world.scene.remove(this.hudMountGroup);
    if (this.centerMountGroup) this.world.scene.remove(this.centerMountGroup);
    if (this.scoreMountGroup) this.world.scene.remove(this.scoreMountGroup);
    if (this.worldMountGroup) this.world.scene.remove(this.worldMountGroup);

    this.wristMountGroup = null;
    this.hudMountGroup = null;
    this.centerMountGroup = null;
    this.scoreMountGroup = null;
    this.worldMountGroup = null;
  }
}
