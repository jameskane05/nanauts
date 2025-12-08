/**
 * LabelManager.js - BILLBOARD LABELS FOR TRACKED OBJECTS
 * =============================================================================
 *
 * ROLE: Creates and updates floating text labels that display detection info
 * above tracked objects. Labels show object name, confidence, world position,
 * view count, and uncertainty indicator.
 *
 * KEY RESPONSIBILITIES:
 * - Create canvas-textured plane meshes for each tracked object
 * - Update label content when tracking data changes
 * - Billboard labels to always face the player's head
 * - Color-code by mode: green (image), cyan (video)
 * - Show uncertainty with color indicator: green (<5cm), yellow (<10cm), red (>10cm)
 * - Add Interactable component for click-to-generate-3D
 *
 * LABEL CONTENT:
 * - Line 1: [VIDEO] OBJECT_NAME (bold, white)
 * - Line 2: Confidence % (green/cyan)
 * - Line 3: World position (x, y, z) [N views] (gray)
 * - Line 4: ±Ncm uncertainty (color-coded)
 *
 * USAGE: Instantiated by AIManager, callbacks registered with ObjectTracker.
 * Creates labels via onCreateLabel, updates via onUpdateLabel.
 * =============================================================================
 */

import {
  Vector3,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  SRGBColorSpace,
  CanvasTexture,
  LinearFilter,
  Interactable,
} from "@iwsdk/core";
import { Vector3 as THREEVector3 } from "three";
import { TRACKING_CONFIG } from "./config.js";
import { Logger } from "../utils/Logger.js";

export class LabelManager {
  constructor(world, player, config = {}) {
    this.world = world;
    this.player = player;
    this.positionSmoothing =
      config.positionSmoothing || TRACKING_CONFIG.positionSmoothing;
    this.offset = new Vector3(0, 0.3, 0);
    this.labelEntities = new Map();
    this.logger = new Logger("LabelManager", false);
  }

  _renderLabelCanvas(tracked, worldPosition, isVideoMode, isCloned = false) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const modePrefix = isVideoMode ? "[VIDEO] " : "";
    const clonedIndicator = isCloned ? " ✓" : "";
    ctx.fillText(
      `${modePrefix}${tracked.label.toUpperCase()}${clonedIndicator}`,
      canvas.width / 2,
      canvas.height / 2 - 15
    );

    ctx.fillStyle = isVideoMode ? "#88ffff" : "#88ff88";
    ctx.font = "32px Arial";
    ctx.fillText(
      `${(tracked.confidence * 100).toFixed(0)}%`,
      canvas.width / 2,
      canvas.height / 2 + 20
    );

    ctx.fillStyle = "#aaaaaa";
    ctx.font = "20px Arial";
    const posText = `(${worldPosition.x.toFixed(1)}, ${worldPosition.y.toFixed(
      1
    )}, ${worldPosition.z.toFixed(1)}) [${tracked.viewCount} views]`;
    ctx.fillText(posText, canvas.width / 2, canvas.height / 2 + 45);

    const avgUncertainty =
      tracked.positionHistory.length > 0
        ? tracked.positionHistory.reduce(
            (sum, entry) => sum + (entry.uncertainty || 0.1),
            0
          ) / tracked.positionHistory.length
        : 0.1;
    const uncertaintyCm = (avgUncertainty * 100).toFixed(1);

    let uncertaintyColor = "#00ff00";
    if (avgUncertainty > 0.1) uncertaintyColor = "#ff0000";
    else if (avgUncertainty > 0.05) uncertaintyColor = "#ffff00";

    ctx.fillStyle = uncertaintyColor;
    ctx.font = "18px Arial";
    ctx.fillText(
      `±${uncertaintyCm}cm`,
      canvas.width / 2,
      canvas.height / 2 + 70
    );

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;

    return texture;
  }

  createLabel(objectId, tracked, isVideoMode = false) {
    const labelText = tracked.label;
    const worldPosition = tracked.captureTimePosition || tracked.fusedPosition;

    if (this.labelEntities.has(objectId)) {
      this.updateLabel(objectId, tracked, isVideoMode);
      return;
    }

    const texture = this._renderLabelCanvas(tracked, worldPosition, isVideoMode, false);

    const geometry = new PlaneGeometry(1.0, 0.3);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.9,
      side: 2,
      depthWrite: false,
    });

    const labelMesh = new Mesh(geometry, material);
    labelMesh.position.copy(worldPosition);
    labelMesh.position.add(this.offset);

    const headPos = this.player.head.position;
    labelMesh.lookAt(headPos.x, headPos.y, headPos.z);

    labelMesh.matrixAutoUpdate = true;
    labelMesh.visible = true;

    const labelEntity = this.world.createTransformEntity(labelMesh);
    if (!labelEntity) {
      this.logger.error(
        `ERROR: createTransformEntity returned null for ${objectId}`
      );
      return;
    }

    try {
      labelEntity.addComponent(Interactable);
      labelEntity.object3D.userData.objectId = objectId;
      labelEntity.object3D.userData.label = labelText;
      labelEntity.object3D.userData.isVideoMode = isVideoMode;
    } catch (error) {
      this.logger.warn(
        `Could not add Interactable to label ${objectId}:`,
        error
      );
    }

    this.labelEntities.set(objectId, labelEntity);

    this.logger.log(
      `Created ${
        isVideoMode ? "cyan" : "green"
      } label for ${objectId} (${labelText})`
    );

    if (labelEntity.object3D) {
      if (labelEntity.object3D.parent === null) {
        this.logger.warn(
          `WARNING: Label mesh for ${objectId} not in scene, adding manually`
        );
        this.world.scene.add(labelEntity.object3D);
      }
      labelEntity.object3D.visible = true;
    }

    const distance = labelMesh.position.distanceTo(headPos);
    if (distance > 10) {
      this.logger.warn(
        `Label for ${objectId} is very far away (${distance.toFixed(
          2
        )}m) - may be hard to see`
      );
    }
  }

  updateLabel(objectId, tracked, isVideoMode = false) {
    const labelEntity = this.labelEntities.get(objectId);

    if (!labelEntity || !labelEntity.object3D) {
      this.createLabel(objectId, tracked, isVideoMode);
      return;
    }

    const labelMesh = labelEntity.object3D;
    const worldPosition = tracked.captureTimePosition || tracked.fusedPosition;

    labelMesh.position.lerp(
      new THREEVector3(
        worldPosition.x + this.offset.x,
        worldPosition.y + this.offset.y,
        worldPosition.z + this.offset.z
      ),
      1.0 - this.positionSmoothing
    );

    const isCloned = labelMesh.userData.clonedTo3D || false;
    const texture = this._renderLabelCanvas(tracked, worldPosition, isVideoMode, isCloned);

    labelMesh.material.map = texture;
    labelMesh.material.needsUpdate = true;

    const headPos = this.player.head.position;
    labelMesh.lookAt(headPos.x, headPos.y, headPos.z);
  }

  removeLabel(objectId) {
    const labelEntity = this.labelEntities.get(objectId);
    if (labelEntity) {
      // Properly destroy the entity (not just remove from scene)
      if (typeof labelEntity.destroy === "function") {
        labelEntity.destroy();
      } else if (labelEntity.object3D) {
        // Fallback: remove from scene if destroy() not available
        this.world.scene.remove(labelEntity.object3D);
        // Dispose of material and texture to free memory
        if (labelEntity.object3D.material) {
          if (labelEntity.object3D.material.map) {
            labelEntity.object3D.material.map.dispose();
          }
          labelEntity.object3D.material.dispose();
        }
        if (labelEntity.object3D.geometry) {
          labelEntity.object3D.geometry.dispose();
        }
      }
    }
    this.labelEntities.delete(objectId);
  }

  markLabelAsCloned(objectId) {
    const labelEntity = this.labelEntities.get(objectId);
    if (labelEntity && labelEntity.object3D) {
      labelEntity.object3D.userData.clonedTo3D = true;
      const tracked = this.getTrackedObject?.(objectId);
      if (tracked) {
        this.updateLabel(objectId, tracked);
      }
    }
  }

  getLabel(objectId) {
    return this.labelEntities.get(objectId);
  }

  getAllLabels() {
    return Array.from(this.labelEntities.values());
  }

  resetAll() {
    const count = this.labelEntities.size;
    this.logger.log(`Resetting ${count} labels...`);

    for (const [objectId, labelEntity] of this.labelEntities.entries()) {
      if (labelEntity) {
        // Properly destroy the entity (not just remove from scene)
        if (typeof labelEntity.destroy === "function") {
          this.logger.log(`Destroying label entity ${objectId} via destroy()`);
          labelEntity.destroy();
        } else if (labelEntity.object3D) {
          // Fallback: remove from scene if destroy() not available
          this.logger.log(
            `Removing label entity ${objectId} from scene (no destroy method)`
          );
          this.world.scene.remove(labelEntity.object3D);
          // Dispose of material and texture to free memory
          if (labelEntity.object3D.material) {
            if (labelEntity.object3D.material.map) {
              labelEntity.object3D.material.map.dispose();
            }
            labelEntity.object3D.material.dispose();
          }
          if (labelEntity.object3D.geometry) {
            labelEntity.object3D.geometry.dispose();
          }
        } else {
          this.logger.warn(`Label entity ${objectId} has no object3D`);
        }
      } else {
        this.logger.warn(`Label entity ${objectId} is null/undefined`);
      }
    }
    this.labelEntities.clear();
    this.logger.log(`Reset all labels (cleared ${count} labels)`);
  }
}
