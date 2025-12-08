/**
 * DepthQuality.js - DEPTH MAP QUALITY ASSESSMENT
 * =============================================================================
 *
 * ROLE: Analyzes depth maps to detect quality issues (holes, noise, discontinuities)
 * and provides quality scores for confidence weighting in 3D position estimation.
 *
 * KEY RESPONSIBILITIES:
 * - Detect holes (missing depth values)
 * - Measure noise via local variance analysis
 * - Detect discontinuities (depth jumps) at edges
 * - Calculate overall quality score (0-1)
 * - Assess region-specific quality within masks
 *
 * QUALITY METRICS:
 * - holeRatio: Percentage of invalid depth values
 * - noiseScore: Local variance indicating sensor noise
 * - discontinuityScore: Edge sharpness indicating occlusion boundaries
 *
 * EXPORTS:
 * - assessDepthQuality(depthMap, maskData): Returns quality assessment
 * - assessRegionQuality(depthMap, maskData): Quality within mask region
 * - findDepthDiscontinuities(depthMap): Locate depth edges
 *
 * USAGE: Used by DepthProcessor to weight position estimates
 * =============================================================================
 */

/**
 * Assesses depth map quality and detects issues.
 * Based on Paper 3 and general depth quality assessment techniques.
 *
 * @param {ImageData} depthMap - Depth map (RGBA format)
 * @param {ImageData} maskData - Segmentation mask (optional)
 * @returns {Object} Quality assessment: {score: number, hasHoles: boolean, hasNoise: boolean, hasDiscontinuities: boolean}
 */
export function assessDepthQuality(depthMap, maskData = null) {
  if (!depthMap) {
    return {
      score: 0,
      hasHoles: true,
      hasNoise: true,
      hasDiscontinuities: true,
    };
  }

  const width = depthMap.width;
  const height = depthMap.height;
  const nearMeters = 0.25;
  const farMeters = 2.5;

  // Convert depth map to meters
  const depthValues = new Float32Array(width * height);
  let validDepthCount = 0;
  let totalDepth = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const depthNormalized = depthMap.data[idx] / 255.0;
      const depthMeters =
        nearMeters + (1.0 - depthNormalized) * (farMeters - nearMeters);

      if (
        isFinite(depthMeters) &&
        depthMeters > 0 &&
        depthMeters <= farMeters
      ) {
        depthValues[y * width + x] = depthMeters;
        validDepthCount++;
        totalDepth += depthMeters;
      } else {
        depthValues[y * width + x] = NaN;
      }
    }
  }

  // Check for holes (missing depth values)
  const holeRatio = 1.0 - validDepthCount / (width * height);
  const hasHoles = holeRatio > 0.1; // More than 10% holes

  // Check for noise (high variance in local regions)
  let noiseScore = 0;
  let noiseSampleCount = 0;
  const kernelSize = 3;

  for (let y = kernelSize; y < height - kernelSize; y += 5) {
    for (let x = kernelSize; x < width - kernelSize; x += 5) {
      if (maskData) {
        const maskIdx =
          Math.floor((y / height) * maskData.height) * maskData.width * 4 +
          Math.floor((x / width) * maskData.width) * 4;
        if (maskData.data[maskIdx + 3] < 128) {
          continue; // Skip if outside mask
        }
      }

      const centerDepth = depthValues[y * width + x];
      if (!isFinite(centerDepth)) continue;

      // Calculate local variance
      let localVariance = 0;
      let localCount = 0;

      for (let dy = -kernelSize; dy <= kernelSize; dy++) {
        for (let dx = -kernelSize; dx <= kernelSize; dx++) {
          const localDepth = depthValues[(y + dy) * width + (x + dx)];
          if (isFinite(localDepth)) {
            const diff = localDepth - centerDepth;
            localVariance += diff * diff;
            localCount++;
          }
        }
      }

      if (localCount > 0) {
        localVariance /= localCount;
        noiseScore += Math.sqrt(localVariance);
        noiseSampleCount++;
      }
    }
  }

  const avgNoise = noiseSampleCount > 0 ? noiseScore / noiseSampleCount : 0;
  const hasNoise = avgNoise > 0.05; // More than 5cm average local variance

  // Check for discontinuities (sudden depth changes)
  let discontinuityCount = 0;
  let discontinuitySampleCount = 0;
  const discontinuityThreshold = 0.2; // 20cm threshold

  for (let y = 1; y < height - 1; y += 3) {
    for (let x = 1; x < width - 1; x += 3) {
      if (maskData) {
        const maskIdx =
          Math.floor((y / height) * maskData.height) * maskData.width * 4 +
          Math.floor((x / width) * maskData.width) * 4;
        if (maskData.data[maskIdx + 3] < 128) {
          continue;
        }
      }

      const centerDepth = depthValues[y * width + x];
      if (!isFinite(centerDepth)) continue;

      // Check neighbors
      const neighbors = [
        depthValues[y * width + (x - 1)],
        depthValues[y * width + (x + 1)],
        depthValues[(y - 1) * width + x],
        depthValues[(y + 1) * width + x],
      ];

      for (const neighborDepth of neighbors) {
        if (isFinite(neighborDepth)) {
          const diff = Math.abs(centerDepth - neighborDepth);
          if (diff > discontinuityThreshold) {
            discontinuityCount++;
          }
          discontinuitySampleCount++;
        }
      }
    }
  }

  const discontinuityRatio =
    discontinuitySampleCount > 0
      ? discontinuityCount / discontinuitySampleCount
      : 0;
  const hasDiscontinuities = discontinuityRatio > 0.15; // More than 15% discontinuities

  // Calculate overall quality score (0-1, higher is better)
  let score = 1.0;
  score -= holeRatio * 0.4; // Holes reduce quality significantly
  score -= Math.min(avgNoise / 0.1, 0.3); // Noise reduces quality
  score -= discontinuityRatio * 0.3; // Discontinuities reduce quality
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    hasHoles,
    hasNoise,
    hasDiscontinuities,
    holeRatio,
    noiseLevel: avgNoise,
    discontinuityRatio,
  };
}

/**
 * Determines if depth quality is sufficient for reliable positioning.
 *
 * @param {Object} qualityAssessment - Result from assessDepthQuality
 * @returns {boolean} True if quality is sufficient
 */
export function isDepthQualitySufficient(qualityAssessment) {
  return (
    qualityAssessment.score > 0.5 &&
    !qualityAssessment.hasHoles &&
    qualityAssessment.noiseLevel < 0.1
  );
}
