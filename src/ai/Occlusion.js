/**
 * Occlusion.js - SEGMENTATION MASK OCCLUSION DETECTION
 * =============================================================================
 *
 * ROLE: Detects various types of occlusion in segmentation masks to improve
 * depth estimation robustness. Identifies border occlusion, internal holes,
 * and fragmentation that indicate partially visible objects.
 *
 * KEY RESPONSIBILITIES:
 * - Detect masks touching image borders (truncated objects)
 * - Find internal holes in masks (occluded regions)
 * - Measure mask fragmentation (multiple disconnected regions)
 * - Calculate occlusion confidence score
 * - Identify depth discontinuities at occlusion boundaries
 *
 * OCCLUSION TYPES:
 * - Border: Object extends beyond image frame
 * - Internal: Holes within mask (something in front)
 * - Fragmentation: Multiple disconnected mask regions
 * - Depth discontinuity: Sharp depth changes at edges
 *
 * EXPORTS:
 * - isNearImageBorder(maskData, borderThickness): Border occlusion check
 * - hasInternalOcclusion(maskData, minHoleArea): Internal hole detection
 * - checkOcclusion(maskData, depthMap): Full occlusion analysis
 * - getOcclusionConfidence(maskData): Occlusion severity score
 *
 * USAGE: Used by DepthProcessor to weight position estimates
 * =============================================================================
 */

/**
 * Checks if mask is near image border.
 * Objects near borders are likely occluded.
 *
 * @param {ImageData} maskData - Mask image data
 * @param {number} borderThickness - Border thickness in pixels (default: 5)
 * @returns {boolean} True if mask is near border
 */
export function isNearImageBorder(maskData, borderThickness = 5) {
  const width = maskData.width;
  const height = maskData.height;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      const alpha = maskData.data[index + 3];

      if (alpha > 128) {
        // Found mask pixel
        if (
          x < borderThickness ||
          x >= width - borderThickness ||
          y < borderThickness ||
          y >= height - borderThickness
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Checks if mask has internal holes or fragmentation.
 * Fragmented masks may indicate occlusion.
 *
 * @param {ImageData} maskData - Mask image data
 * @param {number} minHoleArea - Minimum hole area in pixels (default: 20)
 * @returns {boolean} True if mask has internal occlusion
 */
export function hasInternalOcclusion(maskData, minHoleArea = 20) {
  const width = maskData.width;
  const height = maskData.height;

  // Create binary mask
  const binaryMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      binaryMask[y * width + x] = maskData.data[index + 3] > 128 ? 1 : 0;
    }
  }

  // Count connected components using flood fill
  const visited = new Uint8Array(width * height);
  let componentCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binaryMask[idx] === 1 && visited[idx] === 0) {
        // Found new component
        componentCount++;
        floodFill(binaryMask, visited, x, y, width, height, componentCount);
      }
    }
  }

  // Multiple components indicate fragmentation
  if (componentCount > 1) {
    return true;
  }

  // Check for internal holes by filling and comparing
  const filledMask = fillHoles(binaryMask, width, height);
  let holeArea = 0;

  for (let i = 0; i < width * height; i++) {
    if (filledMask[i] === 1 && binaryMask[i] === 0) {
      holeArea++;
    }
  }

  return holeArea >= minHoleArea;
}

/**
 * Checks if object is occluded by comparing depth at internal vs external edges.
 * Ported from backend is_occluded_by_others logic.
 *
 * @param {ImageData} maskData - Mask image data
 * @param {ImageData} depthMap - Depth map (RGBA format)
 * @param {number} zThresh - Depth threshold in meters (default: 0.05)
 * @param {number} dilationIter - Dilation iterations (default: 2)
 * @param {number} filterSize - Filter size for min pooling (default: 3)
 * @returns {boolean} True if occluded
 */
export function isOccludedByOthers(
  maskData,
  depthMap,
  zThresh = 0.05,
  dilationIter = 2,
  filterSize = 3
) {
  const width = maskData.width;
  const height = maskData.height;

  // Convert depth map to meters
  const nearMeters = 0.25;
  const farMeters = 2.5;
  const zMap = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const depthIdx = (y * depthMap.width + x) * 4;
      const depthNormalized = depthMap.data[depthIdx] / 255.0;
      zMap[y * width + x] =
        nearMeters + (1.0 - depthNormalized) * (farMeters - nearMeters);
    }
  }

  // Create binary mask
  const binaryMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      binaryMask[y * width + x] = maskData.data[idx + 3] > 128 ? 1 : 0;
    }
  }

  // Erode mask to get internal edge
  const eroded = erode(binaryMask, width, height, dilationIter);
  const internalEdge = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    internalEdge[i] = binaryMask[i] & ~eroded[i];
  }

  // Dilate mask to get external edge
  const dilated = dilate(binaryMask, width, height, dilationIter);
  const externalEdge = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    externalEdge[i] = dilated[i] & ~binaryMask[i];
  }

  // Apply minimum filter to external edge depths
  const zExtMin = minimumFilter(zMap, externalEdge, width, height, filterSize);

  // Compare depths at internal edge
  let occlusionCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (internalEdge[idx] === 1) {
        const zInt = zMap[idx];
        const zExt = zExtMin[idx];
        if (isFinite(zInt) && isFinite(zExt) && zInt - zExt > zThresh) {
          occlusionCount++;
        }
      }
    }
  }

  return occlusionCount > 10;
}

/**
 * Main occlusion detection function.
 * Combines all occlusion checks.
 *
 * @param {ImageData} maskData - Mask image data
 * @param {ImageData} depthMap - Depth map (optional)
 * @param {Object} options - Options:
 *   - minRegionArea: Minimum region area (default: 25)
 *   - borderThickness: Border thickness (default: 5)
 *   - zThresh: Depth threshold (default: 0.3)
 *   - minHoleArea: Minimum hole area (default: 100)
 * @returns {boolean} True if occluded
 */
export function checkOcclusion(maskData, depthMap = null, options = {}) {
  const {
    minRegionArea = 25,
    borderThickness = 5,
    zThresh = 0.3,
    minHoleArea = 100,
  } = options;

  // Remove small regions first
  const cleanedMask = removeSmallRegions(maskData, minRegionArea);

  // Check border occlusion
  if (isNearImageBorder(cleanedMask, borderThickness)) {
    return true;
  }

  // Check internal occlusion
  if (hasInternalOcclusion(cleanedMask, minHoleArea)) {
    return true;
  }

  // Check depth-based occlusion if depth map available
  if (depthMap) {
    if (isOccludedByOthers(cleanedMask, depthMap, zThresh)) {
      return true;
    }
  }

  return false;
}

// Helper functions

function floodFill(mask, visited, startX, startY, width, height, label) {
  const stack = [[startX, startY]];

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = y * width + x;

    if (
      x < 0 ||
      x >= width ||
      y < 0 ||
      y >= height ||
      visited[idx] !== 0 ||
      mask[idx] === 0
    ) {
      continue;
    }

    visited[idx] = label;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function fillHoles(mask, width, height) {
  const filled = new Uint8Array(mask.length);
  filled.set(mask);

  // Fill from borders inward
  for (let y = 0; y < height; y++) {
    floodFill(filled, new Uint8Array(width * height), 0, y, width, height, 2);
    floodFill(
      filled,
      new Uint8Array(width * height),
      width - 1,
      y,
      width,
      height,
      2
    );
  }
  for (let x = 0; x < width; x++) {
    floodFill(filled, new Uint8Array(width * height), x, 0, width, height, 2);
    floodFill(
      filled,
      new Uint8Array(width * height),
      x,
      height - 1,
      width,
      height,
      2
    );
  }

  // Invert: holes are now 0s that weren't filled
  for (let i = 0; i < width * height; i++) {
    filled[i] = filled[i] === 2 ? 0 : 1;
  }

  return filled;
}

function erode(mask, width, height, iterations) {
  let result = new Uint8Array(mask);

  for (let iter = 0; iter < iterations; iter++) {
    const newResult = new Uint8Array(width * height);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (
          result[idx] === 1 &&
          result[(y - 1) * width + x] === 1 &&
          result[(y + 1) * width + x] === 1 &&
          result[y * width + x - 1] === 1 &&
          result[y * width + x + 1] === 1
        ) {
          newResult[idx] = 1;
        }
      }
    }

    result = newResult;
  }

  return result;
}

function dilate(mask, width, height, iterations) {
  let result = new Uint8Array(mask);

  for (let iter = 0; iter < iterations; iter++) {
    const newResult = new Uint8Array(result);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;
        if (
          result[idx] === 1 ||
          result[(y - 1) * width + x] === 1 ||
          result[(y + 1) * width + x] === 1 ||
          result[y * width + x - 1] === 1 ||
          result[y * width + x + 1] === 1
        ) {
          newResult[idx] = 1;
        }
      }
    }

    result = newResult;
  }

  return result;
}

function minimumFilter(zMap, edgeMask, width, height, filterSize) {
  const result = new Float32Array(width * height);
  result.fill(Infinity);

  const halfSize = Math.floor(filterSize / 2);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edgeMask[y * width + x] === 1) {
        let minZ = Infinity;

        for (let dy = -halfSize; dy <= halfSize; dy++) {
          for (let dx = -halfSize; dx <= halfSize; dx++) {
            const ny = y + dy;
            const nx = x + dx;

            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              const z = zMap[ny * width + nx];
              if (isFinite(z)) {
                minZ = Math.min(minZ, z);
              }
            }
          }
        }

        result[y * width + x] = isFinite(minZ) ? minZ : Infinity;
      }
    }
  }

  return result;
}

function removeSmallRegions(maskData, minArea) {
  const width = maskData.width;
  const height = maskData.height;
  const binaryMask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      binaryMask[y * width + x] = maskData.data[idx + 3] > 128 ? 1 : 0;
    }
  }

  // Find connected components and remove small ones
  const visited = new Uint8Array(width * height);
  const componentSizes = [];
  let componentId = 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binaryMask[idx] === 1 && visited[idx] === 0) {
        const size = floodFillAndCount(
          binaryMask,
          visited,
          x,
          y,
          width,
          height,
          componentId
        );
        componentSizes[componentId] = size;
        componentId++;
      }
    }
  }

  // Remove small components
  const cleanedMask = new ImageData(width, height);
  cleanedMask.data.set(maskData.data);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const compId = visited[idx];
      if (compId > 0 && componentSizes[compId] < minArea) {
        const pixelIdx = idx * 4;
        cleanedMask.data[pixelIdx + 3] = 0; // Remove pixel
      }
    }
  }

  return cleanedMask;
}

function floodFillAndCount(
  mask,
  visited,
  startX,
  startY,
  width,
  height,
  label
) {
  const stack = [[startX, startY]];
  let count = 0;

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const idx = y * width + x;

    if (
      x < 0 ||
      x >= width ||
      y < 0 ||
      y >= height ||
      visited[idx] !== 0 ||
      mask[idx] === 0
    ) {
      continue;
    }

    visited[idx] = label;
    count++;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  return count;
}
