/**
 * CameraCapture.js - XR CAMERA FRAME AND TRANSFORM EXTRACTION
 * =============================================================================
 *
 * ROLE: Captures frames from the XR passthrough camera and extracts camera
 * intrinsics, extrinsics, and head transform for 3D position calculation.
 *
 * KEY RESPONSIBILITIES:
 * - Capture video frames from CameraSource (passthrough camera)
 * - Extract head transform (position, rotation, matrix) from player.head
 * - Query MediaTrackSettings for camera intrinsics (fx, fy, cx, cy)
 * - Query MediaTrackSettings for camera extrinsics (lens pose)
 * - Provide fallback values when native calibration unavailable
 * - Load test images in emulator mode
 *
 * CAMERA INTRINSICS:
 * Attempts to read lensIntrinsicCalibration from MediaTrackSettings.
 * Falls back to approximated values from assumed FOV if unavailable.
 *
 * CAMERA EXTRINSICS:
 * Attempts to read lensPoseTranslation/Rotation from MediaTrackSettings.
 * Falls back to estimated offset [0, -0.02, -0.06] (2cm down, 6cm forward).
 *
 * HEAD TRANSFORM:
 * Extracts world position and rotation from player.head Object3D.
 * Tries matrixWorld, getWorldQuaternion, quaternion, then rotation as fallbacks.
 *
 * USAGE: Instantiated by AIManager, called to capture frames for detection
 * =============================================================================
 */

import { CameraSource, CameraUtils, Vector3 } from "@iwsdk/core";
import { Quaternion } from "three";
import { USE_TEST_IMAGE_IN_EMULATOR, IS_EMULATOR } from "./config.js";
import { Logger } from "../utils/Logger.js";

export class CameraCapture {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.logger = new Logger("CameraCapture", false);
    this._quaternionErrorLogged = false;
    this._intrinsicsChecked = false;
    this._intrinsicsNotFoundLogged = false;
    this._intrinsicsLogged = false;
    this._extrinsicsChecked = false;
    this._extrinsicsNotFoundLogged = false;
    this._extrinsicsLogged = false;
    this._cachedIntrinsics = null;
    this._cachedExtrinsics = null;
    this._emulatorCameraWarningLogged = false;
    this._captureErrorLogged = false;
  }

  captureFrame(cameraEntity) {
    // In emulator mode, camera capture typically fails - return null gracefully
    if (IS_EMULATOR) {
      if (!this._emulatorCameraWarningLogged) {
        this.logger.log(
          "Emulator mode: camera capture disabled (no front-facing camera)"
        );
        this._emulatorCameraWarningLogged = true;
      }
      // If USE_TEST_IMAGE_IN_EMULATOR is set, caller should use loadTestImage() instead
      return null;
    }

    try {
      return CameraUtils.captureFrame(cameraEntity);
    } catch (error) {
      if (!this._captureErrorLogged) {
        this.logger.warn("Camera capture failed:", error.message);
        this._captureErrorLogged = true;
      }
      return null;
    }
  }

  getHeadTransform() {
    const head = this.player?.head;
    if (!head) {
      this.logger.warn("getHeadTransform: No player.head available");
      return {
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        matrix: null,
        object3D: null,
        quaternion: null,
      };
    }

    const position = new Vector3();
    head.getWorldPosition(position);

    const object3D = head;

    let quaternion = null;
    let matrix = null;

    if (object3D) {
      object3D.updateMatrixWorld(true);
      matrix = object3D.matrixWorld;

      if (matrix && matrix.elements) {
        const hasValidMatrix = !matrix.elements.every((v) => v === 0);
        if (hasValidMatrix) {
          quaternion = new Quaternion();
          quaternion.setFromRotationMatrix(matrix);
        } else {
          this.logger.warn(
            "getHeadTransform: ✗ matrixWorld exists but all elements are zero"
          );
        }
      }

      if (!quaternion && typeof object3D.getWorldQuaternion === "function") {
        quaternion = new Quaternion();
        object3D.getWorldQuaternion(quaternion);
        if (
          quaternion.w === 1 &&
          quaternion.x === 0 &&
          quaternion.y === 0 &&
          quaternion.z === 0
        ) {
          quaternion = null;
        }
      }

      if (
        !quaternion &&
        object3D.quaternion &&
        object3D.quaternion.w !== undefined
      ) {
        quaternion = object3D.quaternion;
        if (
          quaternion.w === 1 &&
          quaternion.x === 0 &&
          quaternion.y === 0 &&
          quaternion.z === 0
        ) {
          quaternion = null;
        }
      }

      if (!quaternion && object3D.rotation) {
        quaternion = new Quaternion();
        quaternion.setFromEuler(object3D.rotation);
      }

      if (!quaternion) {
        if (!this._quaternionErrorLogged) {
          this.logger.error(
            "getHeadTransform: ✗✗✗ CRITICAL: Could not get quaternion from any method!"
          );
          this._quaternionErrorLogged = true;
        }
      }
    } else {
      this.logger.error(
        "getHeadTransform: ✗✗✗ CRITICAL: head is null/undefined or not an Object3D"
      );
      this.logger.error("getHeadTransform: head:", head);
    }

    return {
      position: [position.x, position.y, position.z],
      rotation: quaternion
        ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
        : [0, 0, 0, 1],
      matrix: matrix,
      object3D: object3D,
      quaternion: quaternion,
    };
  }

  getCameraIntrinsics(cameraEntity) {
    const videoElement = CameraSource.data.videoElement?.[cameraEntity.index];
    if (!videoElement) {
      // Don't log every frame - only log once per session
      if (!this._noVideoElementLogged) {
        console.debug(
          `[CameraSemanticLabels] getCameraIntrinsics: No video element (camera not active yet)`
        );
        this._noVideoElementLogged = true;
      }
      return null;
    }

    // Reset flag when video element becomes available
    if (this._noVideoElementLogged) {
      this._noVideoElementLogged = false;
    }

    const stream = videoElement.srcObject;
    if (!stream) {
      if (!this._noStreamLogged) {
        console.debug(`[CameraSemanticLabels] getCameraIntrinsics: No stream`);
        this._noStreamLogged = true;
      }
      return null;
    }
    if (this._noStreamLogged) {
      this._noStreamLogged = false;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      if (!this._noVideoTrackLogged) {
        console.debug(
          `[CameraSemanticLabels] getCameraIntrinsics: No video track`
        );
        this._noVideoTrackLogged = true;
      }
      return null;
    }
    if (this._noVideoTrackLogged) {
      this._noVideoTrackLogged = false;
    }

    const settings = videoTrack.getSettings();

    if (!this._intrinsicsChecked) {
      this.logger.log(`getCameraIntrinsics: Checking MediaTrackSettings...`);
      this.logger.log(
        `  Available settings keys:`,
        Object.keys(settings).join(", ")
      );
      this._intrinsicsChecked = true;
    }

    if (settings.lensIntrinsicCalibration) {
      const calib = settings.lensIntrinsicCalibration;
      if (!this._intrinsicsLogged) {
        this.logger.log(`  ✓ Found lensIntrinsicCalibration:`, calib);
      }
      return {
        fx: calib[0] || calib.fx,
        fy: calib[1] || calib.fy,
        cx: calib[2] || calib.cx,
        cy: calib[3] || calib.cy,
        source: "MediaTrackSettings",
      };
    }

    if (!this._intrinsicsNotFoundLogged) {
      this.logger.log(
        `  ✗ lensIntrinsicCalibration not found in MediaTrackSettings`
      );
      this.logger.log(`  Will use approximated intrinsics from FOV`);
      this._intrinsicsNotFoundLogged = true;
    }
    return null;
  }

  getCameraExtrinsics(cameraEntity) {
    const videoElement = CameraSource.data.videoElement?.[cameraEntity.index];
    if (!videoElement) {
      this.logger.log(`getCameraExtrinsics: No video element`);
      return null;
    }

    const stream = videoElement.srcObject;
    if (!stream) {
      this.logger.log(`getCameraExtrinsics: No stream`);
      return null;
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.logger.log(`getCameraExtrinsics: No video track`);
      return null;
    }

    const settings = videoTrack.getSettings();

    if (!this._extrinsicsChecked) {
      this.logger.log(`getCameraExtrinsics: Checking MediaTrackSettings...`);
      this._extrinsicsChecked = true;
    }

    if (settings.lensPoseTranslation && settings.lensPoseRotation) {
      if (!this._extrinsicsLogged) {
        this.logger.log(
          `  ✓ Found lensPoseTranslation:`,
          settings.lensPoseTranslation
        );
        this.logger.log(
          `  ✓ Found lensPoseRotation:`,
          settings.lensPoseRotation
        );
        this._extrinsicsLogged = true;
      }
      return {
        translation: settings.lensPoseTranslation,
        rotation: settings.lensPoseRotation,
        source: "MediaTrackSettings",
      };
    }

    if (!this._extrinsicsNotFoundLogged) {
      this.logger.log(
        `  ✗ lensPoseTranslation/rotation not found in MediaTrackSettings`
      );
      this.logger.log(
        `  Using fallback extrinsics: translation=[0.0, -0.02, -0.06]`
      );
      this._extrinsicsNotFoundLogged = true;
    }
    return {
      translation: [0.0, -0.02, -0.06],
      rotation: null,
      source: "fallback",
    };
  }

  async loadTestImage() {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        this.logger.log(`Test image loaded: ${canvas.width}x${canvas.height}`);
        resolve(canvas);
      };
      img.onerror = () => {
        this.logger.warn("Failed to load test image");
        resolve(null);
      };
      img.src = "./test-image.jpg";
    });
  }
}
