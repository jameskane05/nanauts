/**
 * DepthProcessor.js - DEPTH MAP TO 3D WORLD POSITION CONVERSION
 * =============================================================================
 *
 * ROLE: Converts 2D detections + depth maps into 3D world positions. Uses point
 * cloud analysis with PCA for robust centroid estimation, and supports both
 * server-generated (MiDaS) and native (XR hit test) depth sources.
 *
 * KEY RESPONSIBILITIES:
 * - Load and decode depth maps from base64 PNG (server depth)
 * - Load segmentation masks and find points within masks
 * - Construct point clouds from mask + depth data
 * - Calculate world positions via camera intrinsics/extrinsics transforms
 * - Native depth calculation using captured XR hit test data
 * - Depth uncertainty estimation for tracking weights
 *
 * DEPTH ENCODING:
 * Server depth (MiDaS DPT-Hybrid): 255 = near (0.25m), 0 = far (2.5m)
 * Configurable via setDepthEncoding() or DEPTH_CONFIG in config.js
 *
 * COORDINATE TRANSFORMS:
 * Camera (OpenCV): X right, Y down, Z forward
 * Headset (Three.js): X right, Y up, Z backward
 * Applies flip: Y inverted, Z inverted, then camera extrinsics, then head pose
 *
 * USAGE: Instantiated by AIManager, called during detection processing
 * =============================================================================
 */

import { Vector3 as THREEVector3, Quaternion, Matrix4 } from "three";
import {
  constructPointCloudFromMask,
  filterValidPoints,
} from "./PointCloud.js";
import { removeOutliers } from "../utils/DBSCAN.js";
import { performPCA, createBoundingBoxFromPCA } from "./PCA.js";
import { createCameraRay } from "./Triangulation.js";
import {
  estimateDepthUncertainty,
  combineSAM3Confidence,
  combineUncertainties,
} from "./uncertainty.js";
import { checkOcclusion } from "./Occlusion.js";
import {
  assessDepthQuality,
  isDepthQualitySufficient,
} from "./DepthQuality.js";
import { Logger } from "../utils/Logger.js";
import { DEPTH_CONFIG } from "./config.js";

export class DepthProcessor {
  constructor() {
    this.capturedDepthData = null;
    this.logger = new Logger("DepthProcessor", false);

    // Depth map encoding parameters from config
    this.depthNearMeters = DEPTH_CONFIG?.serverDepthNear || 0.25;
    this.depthFarMeters = DEPTH_CONFIG?.serverDepthFar || 2.5;
    this.depthInverted = DEPTH_CONFIG?.serverDepthInverted ?? true;
    this._depthEncodingLogged = false;
  }

  setDepthEncoding(nearMeters, farMeters, inverted = true) {
    this.depthNearMeters = nearMeters;
    this.depthFarMeters = farMeters;
    this.depthInverted = inverted;
    this.logger.log(
      `Depth encoding set: near=${nearMeters}m, far=${farMeters}m, inverted=${inverted}`
    );
  }

  decodeDepthValue(normalizedValue) {
    // normalizedValue is 0-1 (from depthMap.data[i] / 255.0)
    if (this.depthInverted) {
      // 255 (normalized=1) = near, 0 (normalized=0) = far
      return (
        this.depthNearMeters +
        (1.0 - normalizedValue) * (this.depthFarMeters - this.depthNearMeters)
      );
    } else {
      // 0 (normalized=0) = near, 255 (normalized=1) = far
      return (
        this.depthNearMeters +
        normalizedValue * (this.depthFarMeters - this.depthNearMeters)
      );
    }
  }

  setCapturedDepthData(depthData) {
    this.capturedDepthData = depthData;
  }

  async loadDepthMap(base64) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(imageData);
      };
      img.onerror = () => {
        this.logger.error("Failed to load depth map");
        resolve(null);
      };
      img.src = `data:image/png;base64,${base64}`;
    });
  }

  async loadMask(base64) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(imageData);
      };
      img.onerror = () => {
        this.logger.warn("Failed to load mask");
        resolve(null);
      };
      img.src = `data:image/png;base64,${base64}`;
    });
  }

  findPointInMask(maskData, bbox, imageWidth, imageHeight) {
    const centerX = (bbox[0] + bbox[2]) / 2;
    const centerY = (bbox[1] + bbox[3]) / 2;

    const maskX = Math.floor((centerX / imageWidth) * maskData.width);
    const maskY = Math.floor((centerY / imageHeight) * maskData.height);
    const maskIndex = (maskY * maskData.width + maskX) * 4;

    // Check R channel (grayscale value) - grayscale PNGs have value in RGB, alpha=255
    if (
      maskIndex >= 0 &&
      maskIndex < maskData.data.length &&
      maskData.data[maskIndex] > 128 // R channel
    ) {
      return { x: centerX, y: centerY };
    }

    for (let y = bbox[1]; y <= bbox[3]; y += 5) {
      for (let x = bbox[0]; x <= bbox[2]; x += 5) {
        const mX = Math.floor((x / imageWidth) * maskData.width);
        const mY = Math.floor((y / imageHeight) * maskData.height);
        const mIdx = (mY * maskData.width + mX) * 4;
        if (
          mIdx >= 0 &&
          mIdx < maskData.data.length &&
          maskData.data[mIdx] > 128 // R channel
        ) {
          return { x, y };
        }
      }
    }

    return { x: centerX, y: centerY };
  }

  findExtremePointsInMask(maskData, bbox, imageWidth, imageHeight) {
    let topmost = { x: bbox[0], y: bbox[3] };
    let bottommost = { x: bbox[0], y: bbox[1] };
    let leftmost = { x: bbox[2], y: bbox[1] };
    let rightmost = { x: bbox[0], y: bbox[1] };

    for (let y = bbox[1]; y <= bbox[3]; y++) {
      for (let x = bbox[0]; x <= bbox[2]; x++) {
        const maskX = Math.floor((x / imageWidth) * maskData.width);
        const maskY = Math.floor((y / imageHeight) * maskData.height);
        const maskIndex = (maskY * maskData.width + maskX) * 4;

        // Check R channel (grayscale value) - grayscale PNGs have value in RGB, alpha=255
        if (
          maskIndex >= 0 &&
          maskIndex < maskData.data.length &&
          maskData.data[maskIndex] > 128 // R channel
        ) {
          if (y < topmost.y) topmost = { x, y };
          if (y > bottommost.y) bottommost = { x, y };
          if (x < leftmost.x) leftmost = { x, y };
          if (x > rightmost.x) rightmost = { x, y };
        }
      }
    }

    return { topmost, bottommost, leftmost, rightmost };
  }

  calculateWorldPosition(
    detection,
    depthMap,
    imageWidth,
    imageHeight,
    headTransform,
    cameraIntrinsics = null,
    cameraExtrinsics = null,
    maskData = null
  ) {
    if (!depthMap) {
      this.logger.warn("No depth map for position calculation");
      return null;
    }

    const bbox = detection.bbox;
    let extremePoints;
    let sampleX, sampleY;

    if (maskData) {
      extremePoints = this.findExtremePointsInMask(
        maskData,
        bbox,
        imageWidth,
        imageHeight
      );
      const centerX =
        (extremePoints.leftmost.x + extremePoints.rightmost.x) / 2;
      const centerY =
        (extremePoints.topmost.y + extremePoints.bottommost.y) / 2;
      sampleX = centerX;
      sampleY = centerY;
    } else {
      sampleX = (bbox[0] + bbox[2]) / 2;
      sampleY = (bbox[1] + bbox[3]) / 2;
      extremePoints = {
        topmost: { x: sampleX, y: bbox[1] },
        bottommost: { x: sampleX, y: bbox[3] },
        leftmost: { x: bbox[0], y: sampleY },
        rightmost: { x: bbox[2], y: sampleY },
      };
    }

    let fx, fy, cx, cy;
    if (cameraIntrinsics) {
      fx = cameraIntrinsics.fx;
      fy = cameraIntrinsics.fy;
      cx = cameraIntrinsics.cx;
      cy = cameraIntrinsics.cy;
    } else {
      const horizontalFOV = (90 * Math.PI) / 180;
      const verticalFOV = (70 * Math.PI) / 180;
      fx = imageWidth / (2 * Math.tan(horizontalFOV / 2));
      fy = imageHeight / (2 * Math.tan(verticalFOV / 2));
      cx = imageWidth / 2;
      cy = imageHeight / 2;
    }

    const intrinsics = { fx, fy, cx, cy };
    let depthMeters = 1.0;
    let cameraSpace = new THREEVector3(0, 0, 1.0);

    if (maskData) {
      const depthQuality = assessDepthQuality(depthMap, maskData);
      const useRGBFallback = !isDepthQualitySufficient(depthQuality);

      const isOccluded = checkOcclusion(maskData, depthMap, {
        minRegionArea: 25,
        borderThickness: 5,
        zThresh: 0.3,
        minHoleArea: 100,
      });

      if (isOccluded || useRGBFallback) {
        const depthX = Math.floor((sampleX / imageWidth) * depthMap.width);
        const depthY = Math.floor((sampleY / imageHeight) * depthMap.height);
        if (
          depthX >= 0 &&
          depthX < depthMap.width &&
          depthY >= 0 &&
          depthY < depthMap.height
        ) {
          const depthIndex = (depthY * depthMap.width + depthX) * 4;
          const depthNormalized = depthMap.data[depthIndex] / 255.0;
          depthMeters = this.decodeDepthValue(depthNormalized);

          cameraSpace = new THREEVector3(
            ((sampleX - cx) / fx) * depthMeters,
            ((sampleY - cy) / fy) * depthMeters,
            depthMeters
          );
        }
      } else {
        const pointCloud = constructPointCloudFromMask(
          maskData,
          depthMap,
          intrinsics,
          imageWidth,
          imageHeight,
          128,
          2
        );

        const validPoints = filterValidPoints(pointCloud, 0.1, 2.5);

        if (validPoints.length >= 10) {
          const cleanedPoints = removeOutliers(validPoints, 0.02, 3);

          if (cleanedPoints.length >= 3) {
            const pcaResult = performPCA(cleanedPoints);
            cameraSpace = pcaResult.centroid;
            depthMeters = pcaResult.centroid.z;
          } else {
            const centroid = cleanedPoints.reduce(
              (sum, p) => sum.add(p),
              new THREEVector3(0, 0, 0)
            );
            centroid.multiplyScalar(1.0 / cleanedPoints.length);
            cameraSpace = centroid;
            depthMeters = centroid.z;
          }
        } else {
          const depthX = Math.floor((sampleX / imageWidth) * depthMap.width);
          const depthY = Math.floor((sampleY / imageHeight) * depthMap.height);
          if (
            depthX >= 0 &&
            depthX < depthMap.width &&
            depthY >= 0 &&
            depthY < depthMap.height
          ) {
            const depthIndex = (depthY * depthMap.width + depthX) * 4;
            const depthNormalized = depthMap.data[depthIndex] / 255.0;
            depthMeters = this.decodeDepthValue(depthNormalized);

            cameraSpace = new THREEVector3(
              ((sampleX - cx) / fx) * depthMeters,
              ((sampleY - cy) / fy) * depthMeters,
              depthMeters
            );
          }
        }
      }
    } else {
      const depthX = Math.floor((sampleX / imageWidth) * depthMap.width);
      const depthY = Math.floor((sampleY / imageHeight) * depthMap.height);
      if (
        depthX >= 0 &&
        depthX < depthMap.width &&
        depthY >= 0 &&
        depthY < depthMap.height
      ) {
        const depthIndex = (depthY * depthMap.width + depthX) * 4;
        const depthNormalized = depthMap.data[depthIndex] / 255.0;
        depthMeters = this.decodeDepthValue(depthNormalized);

        // Log depth encoding on first use for debugging
        if (!this._depthEncodingLogged) {
          this.logger.log(
            `Depth encoding: normalized=${depthNormalized.toFixed(
              3
            )} -> ${depthMeters.toFixed(2)}m (near=${
              this.depthNearMeters
            }m, far=${this.depthFarMeters}m, inverted=${this.depthInverted})`
          );
          this._depthEncodingLogged = true;
        }

        cameraSpace = new THREEVector3(
          ((sampleX - cx) / fx) * depthMeters,
          ((sampleY - cy) / fy) * depthMeters,
          depthMeters
        );
      }
    }

    // Step 1: Convert camera coordinate system to headset coordinate system
    // Camera (OpenCV): X right, Y down, Z forward (camera looks along +Z)
    // IWSDK/Three.js: X right, Y up, Z forward (toward viewer)
    // If box appears behind user, camera Z forward might map to headset Z backward
    // Flip Y (down -> up) and flip Z (camera forward -> headset backward)
    const headsetSpace = new THREEVector3(
      cameraSpace.x, // X stays the same (right)
      -cameraSpace.y, // Flip Y: down -> up
      -cameraSpace.z // Flip Z: camera forward -> headset backward
    );

    // Step 2: Apply camera extrinsics (camera position relative to headset)
    // Camera extrinsics are in headset coordinate system
    // Translation: [x, y, z] where x=right, y=up, z=forward (in headset space)
    if (cameraExtrinsics && cameraExtrinsics.translation) {
      const camOffset = new THREEVector3(
        cameraExtrinsics.translation[0] || 0, // X: right
        cameraExtrinsics.translation[1] || 0, // Y: up
        cameraExtrinsics.translation[2] || 0 // Z: forward
      );

      // Apply camera rotation if available (in headset space)
      if (
        cameraExtrinsics.rotation &&
        Array.isArray(cameraExtrinsics.rotation)
      ) {
        const q = cameraExtrinsics.rotation;
        if (q.length === 4) {
          const quat = new Quaternion(q[0], q[1], q[2], q[3]);
          headsetSpace.applyQuaternion(quat);
        }
      }

      // Add camera offset (camera is slightly forward and down from headset center)
      headsetSpace.add(camOffset);
    }

    // Step 3: Transform from headset local space to world space
    // CRITICAL: Use the matrix from capture time, not the current head position!
    const cameraPosition = new THREEVector3(
      headTransform.position[0],
      headTransform.position[1],
      headTransform.position[2]
    );

    let worldPosition;
    let cameraRotation = null;

    if (headTransform.matrix) {
      // Extract rotation from matrix (DO NOT use applyMatrix4 - it double-adds translation)
      const headMatrix = headTransform.matrix;
      cameraRotation = new Quaternion();
      cameraRotation.setFromRotationMatrix(headMatrix);

      // Apply rotation to the offset, then add head position
      const headsetSpaceCopy = headsetSpace.clone();
      headsetSpaceCopy.applyQuaternion(cameraRotation);
      worldPosition = cameraPosition.clone().add(headsetSpaceCopy);
    } else if (headTransform.quaternion) {
      // Fallback: use quaternion rotation
      cameraRotation = new Quaternion().copy(headTransform.quaternion);
      const headsetSpaceCopy = headsetSpace.clone();
      headsetSpaceCopy.applyQuaternion(cameraRotation);
      worldPosition = cameraPosition.clone().add(headsetSpaceCopy);
    } else {
      // Last resort: just add position (no rotation - will be wrong!)
      worldPosition = cameraPosition.clone().add(headsetSpace);
      cameraRotation = new Quaternion(); // Identity quaternion
    }

    const centerU = (bbox[0] + bbox[2]) / 2;
    const centerV = (bbox[1] + bbox[3]) / 2;
    const ray = createCameraRay(
      centerU,
      centerV,
      cameraIntrinsics || intrinsics,
      cameraPosition,
      cameraRotation,
      depthMeters
    );

    const sam3Confidence = detection.score || 0.5;

    // Calculate depth uncertainty - use point cloud if available, otherwise use default
    let depthUncertainty = 0.1; // Default uncertainty
    if (maskData) {
      // Try to get point cloud for uncertainty calculation
      try {
        const pointCloud = constructPointCloudFromMask(
          maskData,
          depthMap,
          intrinsics,
          imageWidth,
          imageHeight,
          64, // Smaller sample for uncertainty
          1
        );
        const validPoints = filterValidPoints(pointCloud, 0.1, 2.5);
        if (Array.isArray(validPoints) && validPoints.length >= 3) {
          depthUncertainty = estimateDepthUncertainty(validPoints, depthMeters);
        }
      } catch (error) {
        // Fall back to default uncertainty if point cloud construction fails
        this.logger.warn(
          "Failed to construct point cloud for uncertainty:",
          error
        );
      }
    }

    const uncertainty = combineSAM3Confidence(sam3Confidence, depthUncertainty);

    return {
      position: worldPosition,
      depth: depthMeters,
      ray: ray,
      uncertainty: uncertainty,
    };
  }

  async calculateNativeDepthPosition(
    detection,
    imageWidth,
    imageHeight,
    headTransform,
    cameraIntrinsics = null,
    cameraExtrinsics = null,
    maskData = null
  ) {
    if (!this.capturedDepthData || !this.capturedDepthData.depthMap) {
      this.logger.warn(
        "No captured depth data available for native depth calculation"
      );
      return null;
    }

    const bbox = detection.bbox;
    if (!bbox) {
      this.logger.warn("No bbox in detection for native depth calculation");
      return null;
    }

    const depthMap = this.capturedDepthData.depthMap;
    const sampleStep = this.capturedDepthData.sampleStep || 40;

    this.logger.log(
      `Calculating native depth for detection: bbox=[${bbox[0].toFixed(
        0
      )}, ${bbox[1].toFixed(0)}, ${bbox[2].toFixed(0)}, ${bbox[3].toFixed(
        0
      )}], depthMap size=${depthMap.size}, sampleStep=${sampleStep}`
    );

    const bboxX1 = Math.max(0, Math.floor(bbox[0]));
    const bboxY1 = Math.max(0, Math.floor(bbox[1]));
    const bboxX2 = Math.min(imageWidth - 1, Math.ceil(bbox[2]));
    const bboxY2 = Math.min(imageHeight - 1, Math.ceil(bbox[3]));

    // First, collect all depth samples that are within the bbox region
    const samplesInBbox = [];
    let samplesInBboxNoMask = 0;
    let samplesRejectedByMask = 0;

    for (const [pixelKey, sample] of depthMap.entries()) {
      const [sampleX, sampleY] = pixelKey.split(",").map(Number);
      if (
        sampleX >= bboxX1 &&
        sampleX <= bboxX2 &&
        sampleY >= bboxY1 &&
        sampleY <= bboxY2
      ) {
        samplesInBboxNoMask++;

        // If mask is available, ONLY include samples within the segmentation mask
        if (maskData && maskData.data && maskData.width && maskData.height) {
          // Scale sample coordinates to mask dimensions
          const maskX = Math.floor((sampleX / imageWidth) * maskData.width);
          const maskY = Math.floor((sampleY / imageHeight) * maskData.height);
          const maskIndex = (maskY * maskData.width + maskX) * 4;

          // Check R channel (grayscale value) - NOT alpha channel
          // Grayscale PNGs loaded into canvas have the value in R,G,B and alpha=255
          if (
            maskIndex >= 0 &&
            maskIndex < maskData.data.length &&
            maskData.data[maskIndex] > 128 // R channel, not +3 (alpha)
          ) {
            samplesInBbox.push(sample);
          } else {
            samplesRejectedByMask++;
          }
        } else {
          // No mask - include all samples in bbox (fallback)
          samplesInBbox.push(sample);
        }
      }
    }

    this.logger.log(
      `Native depth filtering: ${samplesInBboxNoMask} in bbox, ${samplesRejectedByMask} rejected by mask, ${samplesInBbox.length} accepted`
    );

    // Use all samples found in the bbox (they're already sparse from hit testing)
    const depthSamples = samplesInBbox;
    const sampleCount = depthSamples.length;

    if (depthSamples.length === 0) {
      this.logger.warn(
        `No depth samples found in bbox [${bboxX1},${bboxY1},${bboxX2},${bboxY2}]. Total depthMap entries: ${depthMap.size}`
      );
      // Debug: log some sample keys from the depth map
      const sampleKeys = Array.from(depthMap.keys()).slice(0, 5);
      this.logger.log(`Sample depth map keys: ${sampleKeys.join(", ")}`);
      return null;
    }

    this.logger.log(`Found ${depthSamples.length} depth samples within bbox`);

    let avgDepth = 0;
    let avgPosition = new THREEVector3(0, 0, 0);

    for (const sample of depthSamples) {
      avgDepth += sample.depth;
      avgPosition.add(sample.position);
    }

    avgDepth /= depthSamples.length;
    avgPosition.divideScalar(depthSamples.length);

    // Apply Y flip if configured (helps when native positions seem upside down)
    // But add sanity check - if Y is extreme, the hit tests likely hit floor/ceiling behind object
    const rawY = avgPosition.y;
    if (DEPTH_CONFIG?.nativeFlipY) {
      avgPosition.y = -avgPosition.y;
    }

    // Sanity check: Y should be between floor (-0.3m) and reasonable height (2.5m)
    // If outside this range, hit tests likely hit wrong surfaces
    const MIN_REASONABLE_Y = -0.3;
    const MAX_REASONABLE_Y = 2.5;
    if (avgPosition.y < MIN_REASONABLE_Y || avgPosition.y > MAX_REASONABLE_Y) {
      this.logger.warn(
        `Native Y=${avgPosition.y.toFixed(
          2
        )} out of bounds [${MIN_REASONABLE_Y}, ${MAX_REASONABLE_Y}], clamping (raw was ${rawY.toFixed(
          2
        )})`
      );
      avgPosition.y = Math.max(
        MIN_REASONABLE_Y,
        Math.min(MAX_REASONABLE_Y, avgPosition.y)
      );
    } else {
      this.logger.log(
        `Applied Y flip: new Y=${avgPosition.y.toFixed(
          2
        )} (raw was ${rawY.toFixed(2)})`
      );
    }

    // Apply Z flip if configured (helps when native positions seem front/back inverted)
    if (DEPTH_CONFIG?.nativeFlipZ) {
      avgPosition.z = -avgPosition.z;
      this.logger.log(`Applied Z flip: new Z=${avgPosition.z.toFixed(2)}`);
    }

    this.logger.log(
      `Native depth calculated: position=(${avgPosition.x.toFixed(
        2
      )}, ${avgPosition.y.toFixed(2)}, ${avgPosition.z.toFixed(
        2
      )}), depth=${avgDepth.toFixed(2)}m`
    );

    return {
      position: avgPosition,
      depth: avgDepth,
    };
  }
}
