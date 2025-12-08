/**
 * Triangulation.js - MULTI-VIEW 3D POSITION ESTIMATION
 * =============================================================================
 *
 * ROLE: Provides geometric triangulation for estimating 3D positions from
 * multiple camera views. Creates rays and finds their closest intersection.
 *
 * KEY RESPONSIBILITIES:
 * - Create camera rays from pixel coordinates and camera pose
 * - Find closest point between skew lines (ray intersection)
 * - Triangulate position from multiple observation rays
 * - Weight observations by uncertainty for robust estimation
 *
 * RAY CREATION:
 * Unprojects 2D pixel coordinates to 3D direction using camera intrinsics,
 * then transforms to world space using camera extrinsics.
 *
 * TRIANGULATION:
 * Uses least-squares midpoint method for multiple rays.
 * Falls back to weighted average when rays are nearly parallel.
 *
 * EXPORTS:
 * - createCameraRay(u, v, intrinsics, position, rotation, depth): Ray object
 * - closestPointBetweenRays(ray1, ray2): Intersection point and distance
 * - triangulateRays(rays): Best 3D position from multiple rays
 *
 * USAGE: Used by ObjectTracker and DepthProcessor for 3D reconstruction
 * =============================================================================
 */

import { Vector3 as THREEVector3 } from "three";

/**
 * Creates a camera ray from pixel coordinates and camera pose.
 * Ray represents the 3D line from camera origin through the pixel.
 *
 * @param {number} u - Pixel X coordinate
 * @param {number} v - Pixel Y coordinate
 * @param {Object} intrinsics - Camera intrinsics {fx, fy, cx, cy}
 * @param {THREEVector3} cameraPosition - Camera position in world space
 * @param {THREE.Quaternion} cameraRotation - Camera rotation quaternion
 * @param {number} depth - Estimated depth at pixel (meters)
 * @returns {Object} Ray: {origin: THREEVector3, direction: THREEVector3, depth: number}
 */
export function createCameraRay(
  u,
  v,
  intrinsics,
  cameraPosition,
  cameraRotation,
  depth
) {
  const { fx, fy, cx, cy } = intrinsics;

  // Unproject pixel to 3D direction vector in camera space
  // Direction = K^-1 [u, v, 1]^T (normalized)
  const dirX = (u - cx) / fx;
  const dirY = (v - cy) / fy;
  const dirZ = 1.0;

  // Normalize direction vector
  const direction = new THREEVector3(dirX, dirY, dirZ).normalize();

  // Rotate direction to world space
  direction.applyQuaternion(cameraRotation);

  return {
    origin: cameraPosition.clone(),
    direction: direction,
    depth: depth,
  };
}

/**
 * Finds the closest point between two skew lines (rays).
 * Uses formula from Hartley & Sturm (1997).
 *
 * @param {Object} ray1 - Ray: {origin: THREEVector3, direction: THREEVector3}
 * @param {Object} ray2 - Ray: {origin: THREEVector3, direction: THREEVector3}
 * @returns {Object} {point: THREEVector3, distance: number} - Closest point and distance between rays
 */
export function closestPointBetweenRays(ray1, ray2) {
  const w = new THREEVector3().subVectors(ray1.origin, ray2.origin);
  const a = ray1.direction.dot(ray1.direction);
  const b = ray1.direction.dot(ray2.direction);
  const c = ray2.direction.dot(ray2.direction);
  const d = ray1.direction.dot(w);
  const e = ray2.direction.dot(w);

  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-10) {
    // Rays are nearly parallel
    const t1 = 0;
    const point1 = new THREEVector3()
      .copy(ray1.origin)
      .addScaledVector(ray1.direction, t1);
    const point2 = new THREEVector3()
      .copy(ray2.origin)
      .addScaledVector(ray2.direction, 0);
    const distance = point1.distanceTo(point2);
    return {
      point: new THREEVector3().addVectors(point1, point2).multiplyScalar(0.5),
      distance: distance,
    };
  }

  const t1 = (b * e - c * d) / denom;
  const t2 = (a * e - b * d) / denom;

  const point1 = new THREEVector3()
    .copy(ray1.origin)
    .addScaledVector(ray1.direction, t1);
  const point2 = new THREEVector3()
    .copy(ray2.origin)
    .addScaledVector(ray2.direction, t2);

  const closestPoint = new THREEVector3()
    .addVectors(point1, point2)
    .multiplyScalar(0.5);
  const distance = point1.distanceTo(point2);

  return { point: closestPoint, distance: distance };
}

/**
 * Triangulates 3D position from multiple camera rays using least-squares.
 * For 2 rays: uses closest point between skew lines.
 * For 3+ rays: minimizes sum of squared distances to all rays.
 *
 * @param {Array<Object>} rays - Array of rays: [{origin, direction, depth, uncertainty?}, ...]
 * @param {Array<number>} weights - Optional weights for each ray (default: equal weights)
 * @returns {Object} {position: THREEVector3, uncertainty: number}
 */
export function triangulateRays(rays, weights = null) {
  if (rays.length === 0) {
    return { position: new THREEVector3(0, 0, 0), uncertainty: Infinity };
  }

  if (rays.length === 1) {
    // Single ray: use depth estimate
    const ray = rays[0];
    const position = new THREEVector3()
      .copy(ray.origin)
      .addScaledVector(ray.direction, ray.depth || 1.0);
    return { position, uncertainty: ray.uncertainty || 1.0 };
  }

  if (rays.length === 2) {
    // Two rays: find closest point
    const result = closestPointBetweenRays(rays[0], rays[1]);
    const avgUncertainty =
      ((rays[0].uncertainty || 0.1) + (rays[1].uncertainty || 0.1)) / 2;
    return {
      position: result.point,
      uncertainty: Math.max(result.distance / 2, avgUncertainty),
    };
  }

  // Three or more rays: least-squares minimization
  // Minimize: sum_i w_i * || (origin_i + t_i * direction_i) - p ||^2
  // Where p is the triangulated point
  // This is solved using normal equations

  const n = rays.length;
  const w = weights || new Array(n).fill(1.0);

  // Build system: A * p = b
  // Where A is 3x3 matrix, b is 3x1 vector
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const ray = rays[i];
    const weight = w[i] / (ray.uncertainty || 0.1);
    const dir = ray.direction;
    const orig = ray.origin;

    // Projection matrix: I - direction * direction^T
    // We want to minimize distance to ray, which is equivalent to
    // minimizing distance to the point on ray closest to p
    const d = dir;
    const o = orig;

    // For each ray, add constraint: (p - o) - ((p - o) · d) * d = 0
    // This simplifies to: (I - d*d^T) * p = (I - d*d^T) * o
    const I_minus_ddT = [
      [1 - d.x * d.x, -d.x * d.y, -d.x * d.z],
      [-d.y * d.x, 1 - d.y * d.y, -d.y * d.z],
      [-d.z * d.x, -d.z * d.y, 1 - d.z * d.z],
    ];

    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        A[row][col] += weight * I_minus_ddT[row][col];
      }
      b[row] +=
        weight *
        (I_minus_ddT[row][0] * o.x +
          I_minus_ddT[row][1] * o.y +
          I_minus_ddT[row][2] * o.z);
    }
  }

  // Solve A * p = b using Gaussian elimination
  const position = solveLinearSystem(A, b);
  if (!position) {
    // Fallback: use weighted average of ray endpoints
    let sumWeight = 0;
    const weightedSum = new THREEVector3(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const ray = rays[i];
      const weight = w[i] / (ray.uncertainty || 0.1);
      const endpoint = new THREEVector3()
        .copy(ray.origin)
        .addScaledVector(ray.direction, ray.depth || 1.0);
      weightedSum.addScaledVector(endpoint, weight);
      sumWeight += weight;
    }
    return {
      position: weightedSum.multiplyScalar(1.0 / sumWeight),
      uncertainty: 1.0,
    };
  }

  // Calculate uncertainty as average distance to rays
  let totalDistance = 0;
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const ray = rays[i];
    const weight = w[i] / (ray.uncertainty || 0.1);
    const pointOnRay = new THREEVector3()
      .copy(ray.origin)
      .addScaledVector(ray.direction, ray.depth || 1.0);
    const distance = position.distanceTo(pointOnRay);
    totalDistance += distance * weight;
    totalWeight += weight;
  }

  const uncertainty = totalWeight > 0 ? totalDistance / totalWeight : 1.0;

  return { position, uncertainty };
}

/**
 * Solves linear system A * x = b using Gaussian elimination.
 *
 * @param {Array<Array<number>>} A - 3x3 matrix
 * @param {Array<number>} b - 3x1 vector
 * @returns {THREEVector3|null} Solution vector or null if singular
 */
function solveLinearSystem(A, b) {
  const n = 3;
  const augmented = [
    [A[0][0], A[0][1], A[0][2], b[0]],
    [A[1][0], A[1][1], A[1][2], b[1]],
    [A[2][0], A[2][1], A[2][2], b[2]],
  ];

  // Forward elimination
  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }

    // Swap rows
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];

    // Check for singular matrix
    if (Math.abs(augmented[i][i]) < 1e-10) {
      return null;
    }

    // Eliminate
    for (let k = i + 1; k < n; k++) {
      const factor = augmented[k][i] / augmented[i][i];
      for (let j = i; j < n + 1; j++) {
        augmented[k][j] -= factor * augmented[i][j];
      }
    }
  }

  // Back substitution
  const x = [0, 0, 0];
  for (let i = n - 1; i >= 0; i--) {
    x[i] = augmented[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= augmented[i][j] * x[j];
    }
    x[i] /= augmented[i][i];
  }

  return new THREEVector3(x[0], x[1], x[2]);
}
