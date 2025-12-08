/**
 * uncertainty.js - DEPTH UNCERTAINTY ESTIMATION AND WEIGHTING
 * =============================================================================
 *
 * ROLE: Math utilities for estimating and combining uncertainty values used in
 * multi-view tracking. Uncertainty affects how much weight each observation
 * contributes to the fused position estimate.
 *
 * KEY FUNCTIONS:
 * - estimateDepthUncertainty(): Point cloud variance -> depth uncertainty
 * - combineUncertainties(): Root-sum-squares of multiple uncertainty sources
 * - uncertaintyToWeight(): Convert uncertainty to fusion weight (1/uncertainty)
 * - combineSAM3Confidence(): Scale uncertainty by SAM3 detection confidence
 * - propagateUncertainty(): Account for coordinate transform uncertainty
 *
 * UNCERTAINTY MODEL:
 * Total uncertainty combines: depth measurement + pose uncertainty + intrinsics
 * Higher uncertainty = lower weight in position fusion
 * Default values tuned for Quest 3 passthrough camera + MiDaS depth
 *
 * TYPICAL VALUES:
 * - Minimum uncertainty: 2cm (sensor noise floor)
 * - Pose uncertainty: 1cm (headset tracking)
 * - Intrinsics uncertainty: 0.5cm (calibration error)
 * - High confidence SAM3: 0.5x multiplier, low confidence: 2x multiplier
 *
 * USAGE: Imported by DepthProcessor and ObjectTracker for uncertainty calculations
 * =============================================================================
 */

import { Vector3 as THREEVector3 } from "three";

/**
 * Estimates depth uncertainty from local depth variance in a point cloud.
 *
 * @param {Array<THREEVector3>} points - Point cloud around the depth estimate
 * @param {number} depth - Estimated depth value
 * @returns {number} Depth uncertainty in meters
 */
export function estimateDepthUncertainty(points, depth) {
  if (points.length < 3) {
    return 0.1; // Default uncertainty for small point sets
  }

  // Calculate depth variance
  const depths = points.map((p) => p.z);
  const mean = depths.reduce((sum, d) => sum + d, 0) / depths.length;
  const variance =
    depths.reduce((sum, d) => sum + (d - mean) ** 2, 0) / depths.length;
  const stdDev = Math.sqrt(variance);

  // Uncertainty is proportional to standard deviation
  // Add minimum uncertainty to account for sensor noise
  const minUncertainty = 0.02; // 2cm minimum
  return Math.max(stdDev * 0.5, minUncertainty);
}

/**
 * Combines multiple uncertainty sources using root sum of squares.
 * total_uncertainty = sqrt(depth_uncertainty^2 + pose_uncertainty^2 + intrinsics_uncertainty^2)
 *
 * @param {number} depthUncertainty - Depth measurement uncertainty
 * @param {number} poseUncertainty - Camera pose uncertainty (default: 0.01m)
 * @param {number} intrinsicsUncertainty - Camera intrinsics uncertainty (default: 0.005)
 * @returns {number} Combined uncertainty
 */
export function combineUncertainties(
  depthUncertainty,
  poseUncertainty = 0.01,
  intrinsicsUncertainty = 0.005
) {
  return Math.sqrt(
    depthUncertainty ** 2 +
      poseUncertainty ** 2 +
      intrinsicsUncertainty ** 2
  );
}

/**
 * Calculates weight from uncertainty.
 * weight = 1 / (uncertainty + epsilon)
 *
 * @param {number} uncertainty - Uncertainty value
 * @param {number} epsilon - Small value to prevent division by zero (default: 0.001)
 * @returns {number} Weight value
 */
export function uncertaintyToWeight(uncertainty, epsilon = 0.001) {
  return 1.0 / (uncertainty + epsilon);
}

/**
 * Combines SAM 3 confidence score with depth uncertainty.
 * Higher confidence = lower uncertainty.
 *
 * @param {number} sam3Confidence - SAM 3 detection confidence (0.0-1.0)
 * @param {number} depthUncertainty - Depth measurement uncertainty
 * @returns {number} Combined uncertainty
 */
export function combineSAM3Confidence(sam3Confidence, depthUncertainty) {
  // Convert confidence (0-1) to uncertainty multiplier
  // High confidence (1.0) -> multiplier 0.5 (reduce uncertainty)
  // Low confidence (0.0) -> multiplier 2.0 (increase uncertainty)
  const confidenceMultiplier = 2.0 - sam3Confidence * 1.5;
  return depthUncertainty * confidenceMultiplier;
}

/**
 * Propagates uncertainty through coordinate transformation.
 * Accounts for rotation and translation uncertainties.
 *
 * @param {number} localUncertainty - Uncertainty in local coordinate system
 * @param {THREE.Quaternion} rotation - Rotation quaternion
 * @param {number} rotationUncertainty - Rotation uncertainty in radians (default: 0.01)
 * @returns {number} Uncertainty in transformed coordinate system
 */
export function propagateUncertainty(
  localUncertainty,
  rotation,
  rotationUncertainty = 0.01
) {
  // Simple approximation: rotation adds uncertainty proportional to distance
  // More accurate would use Jacobian of transformation
  const rotationContribution = rotationUncertainty * 0.1; // Scale factor
  return Math.sqrt(localUncertainty ** 2 + rotationContribution ** 2);
}

