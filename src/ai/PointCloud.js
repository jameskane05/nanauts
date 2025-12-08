/**
 * PointCloud.js - DEPTH MAP TO 3D POINT CLOUD CONVERSION
 * =============================================================================
 *
 * ROLE: Converts 2D depth maps and segmentation masks into 3D point clouds
 * using camera intrinsics for unprojection. Core of the 3D reconstruction.
 *
 * KEY RESPONSIBILITIES:
 * - Unproject depth pixels to 3D camera-space points
 * - Sample points within segmentation mask regions
 * - Apply depth range filtering (Quest 3: 0.25m - 2.5m)
 * - Support subsampling for performance (sampleStep)
 *
 * UNPROJECTION FORMULA:
 * p = D(u,v) · K^-1 · [u, v, 1]^T
 * Where K is the camera intrinsic matrix.
 *
 * DEPTH ENCODING:
 * Quest 3 depth maps use normalized values (0-255) mapped to:
 * - Near plane: 0.25 meters
 * - Far plane: 2.5 meters
 * - Depth = near + (1 - normalized) * (far - near)
 *
 * EXPORTS:
 * - constructPointCloudFromMask(maskData, depthMap, intrinsics, width, height, threshold, sampleStep)
 * - sampleDepthAtPixel(depthMap, u, v, nearMeters, farMeters): Single depth value
 *
 * USAGE: Used by DepthProcessor to create point clouds for PCA/centroid
 * =============================================================================
 */

import { Vector3 as THREEVector3 } from "three";

/**
 * Constructs a point cloud from a segmentation mask and depth map.
 * Implements the unprojection formula from OVMONO 3D-GEO paper:
 * p = D(u,v) · K^-1 [u, v, 1]^T
 *
 * @param {ImageData} maskData - Mask image data (alpha channel indicates mask region)
 * @param {ImageData} depthMap - Depth map (RGBA format, depth in R channel, normalized 0-255)
 * @param {Object} intrinsics - Camera intrinsics {fx, fy, cx, cy}
 * @param {number} imageWidth - Original image width
 * @param {number} imageHeight - Original image height
 * @param {number} maskThreshold - Alpha threshold for mask pixels (default: 128)
 * @param {number} sampleStep - Sample every Nth pixel for performance (default: 1 = all pixels)
 * @returns {Array<THREEVector3>} Array of 3D points in camera space
 */
export function constructPointCloudFromMask(
  maskData,
  depthMap,
  intrinsics,
  imageWidth,
  imageHeight,
  maskThreshold = 128,
  sampleStep = 1
) {
  const { fx, fy, cx, cy } = intrinsics;
  const points = [];

  // Precompute inverse intrinsics matrix for efficiency
  // K^-1 = [[1/fx, 0, -cx/fx], [0, 1/fy, -cy/fy], [0, 0, 1]]
  const invFx = 1.0 / fx;
  const invFy = 1.0 / fy;
  const invCx = -cx / fx;
  const invCy = -cy / fy;

  // Depth conversion constants (Quest 3: near=0.25m, far=2.5m)
  const nearMeters = 0.25;
  const farMeters = 2.5;
  const depthRange = farMeters - nearMeters;

  // Scale factors for depth map sampling
  const depthScaleX = depthMap.width / imageWidth;
  const depthScaleY = depthMap.height / imageHeight;

  // Iterate through mask pixels
  for (let v = 0; v < maskData.height; v += sampleStep) {
    for (let u = 0; u < maskData.width; u += sampleStep) {
      const maskIndex = (v * maskData.width + u) * 4;
      const alpha = maskData.data[maskIndex + 3];

      // Check if pixel is in mask
      if (alpha < maskThreshold) continue;

      // Sample depth at corresponding location in depth map
      const depthU = Math.floor(u * depthScaleX);
      const depthV = Math.floor(v * depthScaleY);

      // Bounds check
      if (
        depthU < 0 ||
        depthU >= depthMap.width ||
        depthV < 0 ||
        depthV >= depthMap.height
      ) {
        continue;
      }

      const depthIndex = (depthV * depthMap.width + depthU) * 4;
      const depthNormalized = depthMap.data[depthIndex] / 255.0;

      // Convert normalized depth to meters
      const depthMeters = nearMeters + (1.0 - depthNormalized) * depthRange;

      // Skip invalid depth values
      if (
        !isFinite(depthMeters) ||
        depthMeters <= 0 ||
        depthMeters > farMeters
      ) {
        continue;
      }

      // Unproject: p = D(u,v) · K^-1 [u, v, 1]^T
      // Using precomputed inverse intrinsics:
      // x = (u - cx) / fx * depth
      // y = (v - cy) / fy * depth
      // z = depth
      const x = (u * invFx + invCx) * depthMeters;
      const y = (v * invFy + invCy) * depthMeters;
      const z = depthMeters;

      points.push(new THREEVector3(x, y, z));
    }
  }

  return points;
}

/**
 * Filters out invalid points (NaN, Inf, out of range).
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @param {number} minDepth - Minimum valid depth in meters (default: 0.1)
 * @param {number} maxDepth - Maximum valid depth in meters (default: 2.5)
 * @returns {Array<THREEVector3>} Filtered point cloud
 */
export function filterValidPoints(points, minDepth = 0.1, maxDepth = 2.5) {
  return points.filter((p) => {
    return (
      isFinite(p.x) &&
      isFinite(p.y) &&
      isFinite(p.z) &&
      p.z >= minDepth &&
      p.z <= maxDepth
    );
  });
}
