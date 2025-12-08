/**
 * ObjectTracker.js - MULTI-VIEW OBJECT TRACKING WITH TRIANGULATION
 * =============================================================================
 *
 * ROLE: Tracks detected objects across multiple camera views/frames, fusing
 * positions using triangulation and uncertainty-weighted averaging. Maintains
 * object identity, confidence scores, and position history.
 *
 * KEY RESPONSIBILITIES:
 * - Match new detections to existing tracked objects by label + proximity
 * - Create new tracked objects with position history and metadata
 * - Update tracked positions using ray triangulation (2+ views) or weighted avg
 * - Decay confidence for undetected objects and cleanup stale entries
 * - Trigger callbacks for label/wireframe creation and updates
 *
 * TRACKING ALGORITHM:
 * 1. For each detection, find closest existing object with same label
 * 2. If match found (within maxTrackingDistance), update with new observation
 * 3. If no match, create new tracked object
 * 4. Position fusion: triangulate rays if 2+ views, else weighted average
 * 5. Apply trajectory smoothing for stable output
 *
 * POSITION HISTORY: Each tracked object stores up to 10 observations with:
 *   - position: World space Vector3
 *   - ray: Camera ray for triangulation
 *   - uncertainty: Depth uncertainty for weighting
 *   - timestamp: For recency weighting
 *
 * USAGE: Instantiated by AIManager, called during detection processing
 * =============================================================================
 */

import { Vector3 as THREEVector3, Quaternion } from "three";
import { createCameraRay, triangulateRays } from "./Triangulation.js";
import {
  combineSAM3Confidence,
  combineUncertainties,
  uncertaintyToWeight,
} from "./uncertainty.js";
import { smoothTrajectory } from "../utils/Trajectory.js";
import { TRACKING_CONFIG } from "./config.js";
import { Logger } from "../utils/Logger.js";

export class ObjectTracker {
  constructor(config = {}) {
    this.maxTrackingDistance =
      config.maxTrackingDistance || TRACKING_CONFIG.maxTrackingDistance;
    this.confidenceDecayRate =
      config.confidenceDecayRate || TRACKING_CONFIG.confidenceDecayRate;
    this.minConfidence = config.minConfidence || TRACKING_CONFIG.minConfidence;
    this.maxConfidence = config.maxConfidence || TRACKING_CONFIG.maxConfidence;
    this.positionSmoothing =
      config.positionSmoothing || TRACKING_CONFIG.positionSmoothing;

    this.trackedObjects = new Map();
    this.nextObjectId = 0;

    this.onCreateLabel = null;
    this.onUpdateLabel = null;
    this.onCreateWireframe = null;
    this.onUpdateWireframe = null;
    this.onRemoveLabel = null;
    this.onRemoveWireframe = null;

    this.logger = new Logger("ObjectTracker", false);
  }

  setCallbacks(callbacks) {
    this.onCreateLabel = callbacks.onCreateLabel;
    this.onUpdateLabel = callbacks.onUpdateLabel;
    this.onCreateWireframe = callbacks.onCreateWireframe;
    this.onUpdateWireframe = callbacks.onUpdateWireframe;
    this.onRemoveLabel = callbacks.onRemoveLabel;
    this.onRemoveWireframe = callbacks.onRemoveWireframe;
  }

  matchToTrackedObject(
    label,
    worldPos,
    detectionScore,
    trackedObjectsMap,
    alreadyMatchedIds = null
  ) {
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const [objectId, tracked] of trackedObjectsMap.entries()) {
      if (tracked.label !== label) continue;

      if (alreadyMatchedIds && alreadyMatchedIds.has(objectId)) {
        continue;
      }

      const distance = worldPos.distanceTo(tracked.fusedPosition);

      if (distance < this.maxTrackingDistance && distance < bestDistance) {
        bestMatch = objectId;
        bestDistance = distance;
      }
    }

    if (bestMatch) {
      this.logger.log(
        `Match found: ${label} -> ${bestMatch} (distance: ${bestDistance.toFixed(
          2
        )}m)`
      );
    }

    return bestMatch;
  }

  createTrackedObject(
    label,
    worldPos,
    depthMeters,
    detectionScore,
    headTransform,
    cameraIntrinsics,
    bbox,
    maskIndex,
    isVideoMode = false,
    trackedObjectsMap,
    nativeWorldPos = null,
    nativeDepthMeters = null,
    ray = null,
    uncertainty = 0.1
  ) {
    const objectId = isVideoMode
      ? `video_obj_${this.nextObjectId++}`
      : `obj_${this.nextObjectId++}`;

    const tracked = {
      objectId,
      label,
      fusedPosition: worldPos.clone(),
      captureTimePosition: worldPos.clone(),
      positionHistory: [],
      nativePositionHistory: [],
      nativeFusedPosition: nativeWorldPos ? nativeWorldPos.clone() : null,
      viewCount: 1,
      confidence: Math.min(detectionScore, this.maxConfidence),
      lastSeen: Date.now(),
      lastHeadTransform: headTransform,
      depthMeters: depthMeters,
      nativeDepthMeters: nativeDepthMeters,
      nativeWorldPosition: nativeWorldPos ? nativeWorldPos.clone() : null,
      cameraIntrinsics: cameraIntrinsics,
      bbox: bbox ? [...bbox] : null,
      maskIndex: maskIndex || null,
      isVideoMode: isVideoMode,
    };

    if (nativeWorldPos) {
      tracked.nativePositionHistory.push({
        position: nativeWorldPos.clone(),
        depth: nativeDepthMeters || 1.0,
        timestamp: Date.now(),
      });
    }

    tracked.positionHistory.push({
      position: worldPos.clone(),
      ray: ray,
      uncertainty: uncertainty,
      timestamp: Date.now(),
    });

    trackedObjectsMap.set(objectId, tracked);

    const modeLabel = isVideoMode ? "[VIDEO]" : "[IMAGE]";
    this.logger.log(`${modeLabel} New: ${label} (${objectId})`);

    if (this.onCreateLabel) {
      this.onCreateLabel(objectId, tracked, isVideoMode);
    }
    if (this.onCreateWireframe) {
      this.onCreateWireframe(objectId, tracked, isVideoMode);
    }

    return objectId;
  }

  updateTrackedObject(
    objectId,
    newWorldPos,
    depthMeters,
    detectionScore,
    headTransform,
    cameraIntrinsics,
    bbox,
    trackedObjectsMap,
    nativeWorldPos = null,
    nativeDepthMeters = null,
    ray = null,
    uncertainty = 0.1
  ) {
    const tracked = trackedObjectsMap.get(objectId);
    if (!tracked) return;

    if (headTransform && cameraIntrinsics && bbox) {
      const cameraPosition = new THREEVector3(
        headTransform.position[0],
        headTransform.position[1],
        headTransform.position[2]
      );
      let cameraRotation = new Quaternion();
      if (headTransform.quaternion) {
        cameraRotation.copy(headTransform.quaternion);
      } else if (headTransform.matrix) {
        cameraRotation.setFromRotationMatrix(headTransform.matrix);
      }

      const centerU = (bbox[0] + bbox[2]) / 2;
      const centerV = (bbox[1] + bbox[3]) / 2;
      ray = createCameraRay(
        centerU,
        centerV,
        cameraIntrinsics,
        cameraPosition,
        cameraRotation,
        depthMeters || 1.0
      );

      const sam3Confidence = detectionScore || 0.5;
      const depthUncertainty = 0.05;
      uncertainty = combineSAM3Confidence(sam3Confidence, depthUncertainty);
      uncertainty = combineUncertainties(uncertainty);
    }

    tracked.positionHistory.push({
      position: newWorldPos.clone(),
      ray: ray,
      uncertainty: uncertainty,
      timestamp: Date.now(),
    });

    if (tracked.positionHistory.length > 10) {
      tracked.positionHistory.shift();
    }

    const raysWithData = tracked.positionHistory.filter((entry) => entry.ray);
    if (raysWithData.length >= 2) {
      const rays = raysWithData.map((entry) => ({
        ...entry.ray,
        uncertainty: entry.uncertainty,
      }));
      const weights = raysWithData.map((entry) =>
        uncertaintyToWeight(entry.uncertainty)
      );

      const triangResult = triangulateRays(rays, weights);
      const newFusedPos = new THREEVector3(
        triangResult.position.x,
        triangResult.position.y,
        triangResult.position.z
      );

      const smoothedPos = smoothTrajectory(tracked.positionHistory, 0.7);
      const finalPos = new THREEVector3().lerpVectors(
        newFusedPos,
        smoothedPos,
        0.3
      );

      tracked.fusedPosition.lerp(finalPos, 1.0 - this.positionSmoothing);
    } else if (tracked.positionHistory.length > 0) {
      let fusedX = 0;
      let fusedY = 0;
      let fusedZ = 0;
      let totalWeight = 0;

      for (let i = 0; i < tracked.positionHistory.length; i++) {
        const entry = tracked.positionHistory[i];
        const pos = entry.position;
        const recencyWeight = (i + 1) / tracked.positionHistory.length;
        const uncertaintyWeight = uncertaintyToWeight(entry.uncertainty);
        const weight = tracked.confidence * recencyWeight * uncertaintyWeight;

        fusedX += pos.x * weight;
        fusedY += pos.y * weight;
        fusedZ += pos.z * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        const newFusedPos = new THREEVector3(
          fusedX / totalWeight,
          fusedY / totalWeight,
          fusedZ / totalWeight
        );
        tracked.fusedPosition.lerp(newFusedPos, 1.0 - this.positionSmoothing);
      } else {
        tracked.fusedPosition.lerp(newWorldPos, 1.0 - this.positionSmoothing);
      }
    } else {
      tracked.fusedPosition.lerp(newWorldPos, 1.0 - this.positionSmoothing);
    }

    tracked.confidence = Math.min(
      tracked.confidence + detectionScore * 0.1,
      this.maxConfidence
    );

    tracked.viewCount++;
    tracked.lastSeen = Date.now();
    tracked.lastHeadTransform = headTransform;
    if (depthMeters !== null) {
      tracked.depthMeters = depthMeters;
    }
    if (nativeDepthMeters !== null) {
      tracked.nativeDepthMeters = nativeDepthMeters;
    }

    if (nativeWorldPos) {
      tracked.nativePositionHistory.push({
        position: nativeWorldPos.clone(),
        depth: nativeDepthMeters || 1.0,
        timestamp: Date.now(),
      });

      if (tracked.nativePositionHistory.length > 10) {
        tracked.nativePositionHistory.shift();
      }

      if (tracked.nativePositionHistory.length > 0) {
        let fusedX = 0;
        let fusedY = 0;
        let fusedZ = 0;
        let totalWeight = 0;

        for (let i = 0; i < tracked.nativePositionHistory.length; i++) {
          const entry = tracked.nativePositionHistory[i];
          const pos = entry.position;
          const recencyWeight = (i + 1) / tracked.nativePositionHistory.length;
          const depthWeight = 1.0 / (entry.depth || 1.0);
          const weight = tracked.confidence * recencyWeight * depthWeight;

          fusedX += pos.x * weight;
          fusedY += pos.y * weight;
          fusedZ += pos.z * weight;
          totalWeight += weight;
        }

        if (totalWeight > 0) {
          const newFusedNativePos = new THREEVector3(
            fusedX / totalWeight,
            fusedY / totalWeight,
            fusedZ / totalWeight
          );

          if (!tracked.nativeFusedPosition) {
            tracked.nativeFusedPosition = newFusedNativePos.clone();
          } else {
            const smoothedPos = smoothTrajectory(
              tracked.nativePositionHistory.map((e) => ({
                position: e.position,
                timestamp: e.timestamp,
                uncertainty: 0.05,
              })),
              0.7
            );
            const finalPos = new THREEVector3().lerpVectors(
              newFusedNativePos,
              smoothedPos,
              0.3
            );
            tracked.nativeFusedPosition.lerp(
              finalPos,
              1.0 - this.positionSmoothing
            );
          }
        } else {
          if (!tracked.nativeFusedPosition) {
            tracked.nativeFusedPosition = nativeWorldPos.clone();
          } else {
            tracked.nativeFusedPosition.lerp(
              nativeWorldPos,
              1.0 - this.positionSmoothing
            );
          }
        }
      }

      if (!tracked.nativeWorldPosition) {
        tracked.nativeWorldPosition = nativeWorldPos.clone();
      } else {
        tracked.nativeWorldPosition.lerp(
          nativeWorldPos,
          1.0 - this.positionSmoothing
        );
      }
    }

    if (cameraIntrinsics) {
      tracked.cameraIntrinsics = cameraIntrinsics;
    }
    if (bbox) {
      if (tracked.bbox) {
        tracked.bbox = [
          (tracked.bbox[0] + bbox[0]) / 2,
          (tracked.bbox[1] + bbox[1]) / 2,
          (tracked.bbox[2] + bbox[2]) / 2,
          (tracked.bbox[3] + bbox[3]) / 2,
        ];
      } else {
        tracked.bbox = [...bbox];
      }
    }

    if (this.onUpdateLabel) {
      this.onUpdateLabel(objectId, tracked);
    }
    if (this.onUpdateWireframe) {
      this.onUpdateWireframe(objectId, tracked);
    }
  }

  decayTrackingConfidence(currentDetections, trackedObjectsMap) {
    const currentDetectionsByLabel = new Map();
    for (const det of currentDetections) {
      const label = det.label || "object";
      if (!currentDetectionsByLabel.has(label)) {
        currentDetectionsByLabel.set(label, []);
      }
      currentDetectionsByLabel.get(label).push(det);
    }

    for (const [objectId, tracked] of trackedObjectsMap.entries()) {
      const label = tracked.label;
      const detectionsWithLabel = currentDetectionsByLabel.get(label) || [];
      const matched = detectionsWithLabel.length > 0;

      if (!matched) {
        tracked.confidence = Math.max(
          0,
          tracked.confidence - this.confidenceDecayRate
        );
      }
    }
  }

  cleanupLowConfidenceObjects(
    trackedObjectsMap,
    minConfidence = null,
    minTimeSinceLastSeen = 3000
  ) {
    const toRemove = [];
    const confidenceThreshold = minConfidence || this.minConfidence;

    for (const [objectId, tracked] of trackedObjectsMap.entries()) {
      const timeSinceLastSeen = Date.now() - tracked.lastSeen;
      const shouldRemove =
        tracked.confidence < confidenceThreshold &&
        timeSinceLastSeen > minTimeSinceLastSeen;

      if (shouldRemove) {
        toRemove.push(objectId);
      }
    }

    for (const objectId of toRemove) {
      const tracked = trackedObjectsMap.get(objectId);
      if (tracked) {
        const timeSinceLastSeen = Date.now() - tracked.lastSeen;
        this.logger.log(
          `Removing low-confidence object ${objectId}: ${
            tracked.label
          } (confidence: ${tracked.confidence.toFixed(2)}, unseen for ${(
            timeSinceLastSeen / 1000
          ).toFixed(1)}s)`
        );

        trackedObjectsMap.delete(objectId);

        if (this.onRemoveLabel) {
          this.onRemoveLabel(objectId);
        }
        if (this.onRemoveWireframe) {
          this.onRemoveWireframe(objectId);
        }
      }
    }

    return toRemove.length;
  }

  removeTrackedObject(objectId, trackedObjectsMap) {
    trackedObjectsMap.delete(objectId);

    if (this.onRemoveLabel) {
      this.onRemoveLabel(objectId);
    }
    if (this.onRemoveWireframe) {
      this.onRemoveWireframe(objectId);
    }
  }

  getTrackedObject(objectId, trackedObjectsMap) {
    return trackedObjectsMap.get(objectId);
  }

  getAllTrackedObjects(trackedObjectsMap) {
    return Array.from(trackedObjectsMap.values());
  }

  resetAll(trackedObjectsMap) {
    // Remove all tracked objects and trigger callbacks
    const objectIds = Array.from(trackedObjectsMap.keys());
    for (const objectId of objectIds) {
      this.removeTrackedObject(objectId, trackedObjectsMap);
    }
    trackedObjectsMap.clear();
    this.nextObjectId = 0;
    this.logger.log("Reset all tracked objects");
  }
}
