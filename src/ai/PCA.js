/**
 * PCA.js - PRINCIPAL COMPONENT ANALYSIS FOR POINT CLOUDS
 * =============================================================================
 *
 * ROLE: Performs PCA on 3D point clouds to extract principal axes, which are
 * used to create oriented bounding boxes for detected objects.
 *
 * KEY RESPONSIBILITIES:
 * - Compute point cloud centroid (mean position)
 * - Calculate 3x3 covariance matrix
 * - Extract eigenvalues and eigenvectors (principal components)
 * - Create oriented bounding box from PCA results
 * - Estimate object dimensions from principal axis lengths
 *
 * PCA OUTPUT:
 * - centroid: Mean position of point cloud
 * - eigenvalues: Variance along each principal axis
 * - eigenvectors: Principal axis directions (sorted by eigenvalue)
 * - rotation: Quaternion aligning box to principal axes
 *
 * BOUNDING BOX:
 * Creates minimum-volume oriented bounding box by projecting points
 * onto principal axes and finding extent along each.
 *
 * EXPORTS:
 * - computeCentroid(points): Point cloud center
 * - performPCA(points): Full PCA analysis
 * - createBoundingBoxFromPCA(points, pcaResult): Oriented bounding box
 *
 * USAGE: Used by DepthProcessor for object size estimation
 * =============================================================================
 */

import { Vector3 as THREEVector3, Quaternion, Matrix4 } from "three";

/**
 * Computes the centroid (mean) of a point cloud.
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @returns {THREEVector3} Centroid point
 */
export function computeCentroid(points) {
  if (points.length === 0) {
    return new THREEVector3(0, 0, 0);
  }

  const sum = new THREEVector3(0, 0, 0);
  for (const point of points) {
    sum.add(point);
  }
  return sum.multiplyScalar(1.0 / points.length);
}

/**
 * Computes the covariance matrix of a point cloud.
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @param {THREEVector3} centroid - Centroid of the point cloud
 * @returns {Array<Array<number>>} 3x3 covariance matrix
 */
function computeCovarianceMatrix(points, centroid) {
  const n = points.length;
  if (n === 0) {
    return [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
  }

  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const point of points) {
    const dx = point.x - centroid.x;
    const dy = point.y - centroid.y;
    const dz = point.z - centroid.z;

    cov[0][0] += dx * dx;
    cov[0][1] += dx * dy;
    cov[0][2] += dx * dz;
    cov[1][0] += dy * dx;
    cov[1][1] += dy * dy;
    cov[1][2] += dy * dz;
    cov[2][0] += dz * dx;
    cov[2][1] += dz * dy;
    cov[2][2] += dz * dz;
  }

  const invN = 1.0 / n;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      cov[i][j] *= invN;
    }
  }

  return cov;
}

/**
 * Simple 3x3 matrix eigendecomposition using Jacobi method.
 * Returns eigenvalues and eigenvectors sorted by eigenvalue magnitude.
 *
 * @param {Array<Array<number>>} matrix - 3x3 symmetric matrix
 * @returns {Object} {eigenvalues: Array<number>, eigenvectors: Array<THREEVector3>}
 */
function eigendecomposition(matrix) {
  // For 3x3 symmetric matrices, use simplified Jacobi method
  // This is a simplified version - for production, consider using a library
  const maxIterations = 100;
  const tolerance = 1e-10;

  let A = [
    [matrix[0][0], matrix[0][1], matrix[0][2]],
    [matrix[1][0], matrix[1][1], matrix[1][2]],
    [matrix[2][0], matrix[2][1], matrix[2][2]],
  ];

  let V = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let iter = 0; iter < maxIterations; iter++) {
    let maxOffDiag = 0;
    let p = 0;
    let q = 0;

    // Find largest off-diagonal element
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const absVal = Math.abs(A[i][j]);
        if (absVal > maxOffDiag) {
          maxOffDiag = absVal;
          p = i;
          q = j;
        }
      }
    }

    if (maxOffDiag < tolerance) break;

    // Compute rotation angle
    const theta = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    // Apply Jacobi rotation
    const Apq = A[p][q];
    const App = A[p][p];
    const Aqq = A[q][q];

    A[p][p] = c * c * App - 2 * c * s * Apq + s * s * Aqq;
    A[q][q] = s * s * App + 2 * c * s * Apq + c * c * Aqq;
    A[p][q] = A[q][p] = (c * c - s * s) * Apq + c * s * (App - Aqq);

    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const Akp = A[k][p];
        const Akq = A[k][q];
        A[k][p] = A[p][k] = c * Akp - s * Akq;
        A[k][q] = A[q][k] = s * Akp + c * Akq;
      }
    }

    // Update eigenvectors
    for (let k = 0; k < 3; k++) {
      const Vkp = V[k][p];
      const Vkq = V[k][q];
      V[k][p] = c * Vkp - s * Vkq;
      V[k][q] = s * Vkp + c * Vkq;
    }
  }

  // Extract eigenvalues and eigenvectors
  const eigenvalues = [A[0][0], A[1][1], A[2][2]];
  const eigenvectors = [
    new THREEVector3(V[0][0], V[1][0], V[2][0]),
    new THREEVector3(V[0][1], V[1][1], V[2][1]),
    new THREEVector3(V[0][2], V[1][2], V[2][2]),
  ];

  // Sort by eigenvalue magnitude (descending)
  const indices = [0, 1, 2].sort(
    (a, b) => Math.abs(eigenvalues[b]) - Math.abs(eigenvalues[a])
  );

  return {
    eigenvalues: indices.map((i) => eigenvalues[i]),
    eigenvectors: indices.map((i) => eigenvectors[i]),
  };
}

/**
 * Performs PCA analysis on a point cloud to determine orientation and dimensions.
 * Returns principal axes, dimensions, and centroid.
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @returns {Object} PCA results:
 *   - centroid: THREEVector3 - Centroid of points
 *   - axes: Array<THREEVector3> - Principal axes (sorted by variance)
 *   - dimensions: THREEVector3 - Dimensions along each axis
 *   - eigenvalues: Array<number> - Eigenvalues (variances)
 */
export function performPCA(points) {
  if (points.length < 3) {
    // Fallback for small point sets
    const centroid = computeCentroid(points);
    const dimensions = new THREEVector3(0.1, 0.1, 0.1);
    return {
      centroid,
      axes: [
        new THREEVector3(1, 0, 0),
        new THREEVector3(0, 1, 0),
        new THREEVector3(0, 0, 1),
      ],
      dimensions,
      eigenvalues: [0, 0, 0],
    };
  }

  const centroid = computeCentroid(points);
  const cov = computeCovarianceMatrix(points, centroid);
  const { eigenvalues, eigenvectors } = eigendecomposition(cov);

  // Normalize eigenvectors
  const axes = eigenvectors.map((v) => v.normalize());

  // Calculate dimensions along each principal axis
  const dimensions = new THREEVector3(0, 0, 0);
  const projectedCoords = [[], [], []];

  for (const point of points) {
    const relative = new THREEVector3().subVectors(point, centroid);
    for (let i = 0; i < 3; i++) {
      const coord = relative.dot(axes[i]);
      projectedCoords[i].push(coord);
    }
  }

  // Calculate spread (max - min) along each axis
  for (let i = 0; i < 3; i++) {
    const coords = projectedCoords[i];
    if (coords.length > 0) {
      const min = Math.min(...coords);
      const max = Math.max(...coords);
      dimensions.setComponent(i, Math.max(max - min, 0.1)); // Minimum 10cm
    }
  }

  return {
    centroid,
    axes,
    dimensions,
    eigenvalues,
  };
}

/**
 * Constructs a 3D bounding box from PCA results.
 *
 * @param {Object} pcaResult - Result from performPCA()
 * @returns {Object} Bounding box:
 *   - center: THREEVector3 - Center position
 *   - size: THREEVector3 - Size along each axis
 *   - rotation: Quaternion - Rotation quaternion
 */
export function createBoundingBoxFromPCA(pcaResult) {
  const { centroid, axes, dimensions } = pcaResult;

  // Create rotation matrix from principal axes
  // First axis is primary orientation
  const rotationMatrix = new Matrix4();
  rotationMatrix.makeBasis(axes[0], axes[1], axes[2]);

  // Extract quaternion from rotation matrix
  const quaternion = new Quaternion();
  quaternion.setFromRotationMatrix(rotationMatrix);

  return {
    center: centroid.clone(),
    size: dimensions.clone(),
    rotation: quaternion,
  };
}
