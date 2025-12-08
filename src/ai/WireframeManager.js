/**
 * WireframeManager.js - BOUNDING BOX WIREFRAMES FOR TRACKED OBJECTS
 * =============================================================================
 *
 * ROLE: Creates and updates wireframe bounding boxes that visualize the
 * estimated 3D extent of tracked objects. Supports multiple depth sources
 * with color coding.
 *
 * KEY RESPONSIBILITIES:
 * - Create wireframe boxes sized from bbox + depth + camera intrinsics
 * - Update box positions with smoothing as tracking updates
 * - Maintain separate maps for server depth (green/cyan) and native depth (blue)
 * - Remove wireframes when objects are removed from tracking
 *
 * COLOR CODING:
 * - Green (0x00ff00): Image mode, server depth
 * - Cyan (0x00ffff): Video mode, server depth
 * - Light blue (0x88ccff): Native XR hit test depth
 *
 * BOX SIZING:
 * Calculated from 2D bbox dimensions projected through camera intrinsics
 * at the estimated depth. Depth dimension estimated as 30% of max(width, height).
 * Clamped to reasonable bounds (0.1m - 2.0m width/height, 0.1m - 1.0m depth).
 *
 * USAGE: Instantiated by AIManager, callbacks registered with ObjectTracker
 * =============================================================================
 */

import {
  BoxGeometry,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Vector3 as THREEVector3,
} from "three";
import { TRACKING_CONFIG } from "./config.js";
import { Logger } from "../utils/Logger.js";

export class WireframeManager {
  constructor(world, config = {}) {
    this.world = world;
    this.positionSmoothing =
      config.positionSmoothing || TRACKING_CONFIG.positionSmoothing;
    this.wireframeBoxes = new Map();
    this.nativeWireframeBoxes = new Map();
    this.logger = new Logger("WireframeManager", false);
  }

  createWireframeBox(objectId, tracked, isVideoMode = false, isNative = false) {
    const boxMap = isNative ? this.nativeWireframeBoxes : this.wireframeBoxes;

    if (boxMap.has(objectId)) {
      return;
    }

    const worldPosition =
      isNative && tracked.nativeFusedPosition
        ? tracked.nativeFusedPosition.clone()
        : isNative && tracked.nativeWorldPosition
        ? tracked.nativeWorldPosition.clone()
        : tracked.captureTimePosition || tracked.fusedPosition;

    if (isNative) {
      this.logger.log(
        `Creating native wireframe for ${objectId}: nativeFusedPosition=${!!tracked.nativeFusedPosition}, nativeWorldPosition=${!!tracked.nativeWorldPosition}, position=(${worldPosition.x.toFixed(
          2
        )}, ${worldPosition.y.toFixed(2)}, ${worldPosition.z.toFixed(2)})`
      );
    }

    const depthMeters =
      isNative && tracked.nativeDepthMeters !== null
        ? tracked.nativeDepthMeters
        : tracked.depthMeters;

    const cameraIntrinsics = tracked.cameraIntrinsics;
    const bbox = tracked.bbox;
    let boxWidth, boxHeight, boxDepth;

    if (bbox && depthMeters && cameraIntrinsics) {
      const fx = cameraIntrinsics.fx;
      const fy = cameraIntrinsics.fy;

      const pixelWidth = bbox[2] - bbox[0];
      const pixelHeight = bbox[3] - bbox[1];

      boxWidth = (pixelWidth / fx) * depthMeters;
      boxHeight = (pixelHeight / fy) * depthMeters;
      boxDepth = Math.max(boxWidth, boxHeight) * 0.3;
    } else if (bbox && depthMeters) {
      const pixelWidth = bbox[2] - bbox[0];
      const pixelHeight = bbox[3] - bbox[1];
      const scale = depthMeters * 0.001;
      boxWidth = pixelWidth * scale;
      boxHeight = pixelHeight * scale;
      boxDepth = Math.max(boxWidth, boxHeight) * 0.3;
    } else if (depthMeters) {
      const estimatedSize = Math.min(depthMeters * 0.3, 0.5);
      boxWidth = estimatedSize;
      boxHeight = estimatedSize;
      boxDepth = estimatedSize * 0.6;
    } else {
      boxWidth = 0.4;
      boxHeight = 0.4;
      boxDepth = 0.3;
    }

    boxWidth = Math.max(0.1, Math.min(boxWidth, 2.0));
    boxHeight = Math.max(0.1, Math.min(boxHeight, 2.0));
    boxDepth = Math.max(0.1, Math.min(boxDepth, 1.0));

    const boxGeometry = new BoxGeometry(boxWidth, boxHeight, boxDepth);
    const edges = new EdgesGeometry(boxGeometry);
    const boxColor = isNative ? 0x88ccff : isVideoMode ? 0x00ffff : 0x00ff00;
    const wireframe = new LineSegments(
      edges,
      new LineBasicMaterial({ color: boxColor, linewidth: 2 })
    );
    wireframe.position.copy(worldPosition);
    wireframe.visible = true;
    this.world.scene.add(wireframe);
    boxMap.set(objectId, wireframe);

    const colorName = isNative
      ? "light blue (native)"
      : isVideoMode
      ? "cyan"
      : "green";
    this.logger.log(
      `Created ${colorName} wireframe box for ${objectId} (${tracked.label})`
    );
  }

  updateWireframeBox(objectId, tracked, isVideoMode = false) {
    const boxMap = this.wireframeBoxes;
    const wireframe = boxMap.get(objectId);

    if (!wireframe) {
      this.createWireframeBox(objectId, tracked, isVideoMode, false);
      return;
    }

    const nativeBoxMap = this.nativeWireframeBoxes;
    const nativeWireframe = nativeBoxMap.get(objectId);
    const nativePos =
      tracked.nativeFusedPosition || tracked.nativeWorldPosition;

    if (nativeWireframe && nativePos) {
      nativeWireframe.position.lerp(nativePos, 1.0 - this.positionSmoothing);
    } else if (nativePos && !nativeWireframe) {
      this.createWireframeBox(objectId, tracked, isVideoMode, true);
    }
  }

  removeWireframeBox(objectId) {
    const wireframe = this.wireframeBoxes.get(objectId);
    if (wireframe) {
      this.world.scene.remove(wireframe);
      this.wireframeBoxes.delete(objectId);
    }

    const nativeWireframe = this.nativeWireframeBoxes.get(objectId);
    if (nativeWireframe) {
      this.world.scene.remove(nativeWireframe);
      this.nativeWireframeBoxes.delete(objectId);
    }
  }

  getWireframeBox(objectId) {
    return this.wireframeBoxes.get(objectId);
  }

  getNativeWireframeBox(objectId) {
    return this.nativeWireframeBoxes.get(objectId);
  }

  resetAll() {
    for (const [objectId, wireframe] of this.wireframeBoxes.entries()) {
      this.world.scene.remove(wireframe);
    }
    this.wireframeBoxes.clear();

    for (const [objectId, wireframe] of this.nativeWireframeBoxes.entries()) {
      this.world.scene.remove(wireframe);
    }
    this.nativeWireframeBoxes.clear();

    this.logger.log("Reset all wireframes");
  }
}
