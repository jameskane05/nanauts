/**
 * DBSCAN.js - DENSITY-BASED SPATIAL CLUSTERING FOR OUTLIER REMOVAL
 * =============================================================================
 *
 * ROLE: Implements DBSCAN algorithm to remove outlier points (flying pixels)
 * from point clouds before PCA analysis. Essential for robust depth processing.
 *
 * KEY RESPONSIBILITIES:
 * - Cluster 3D points by spatial density
 * - Identify outliers (points not in any cluster)
 * - Return largest cluster as inliers
 * - Filter flying pixels from depth sensor noise
 *
 * ALGORITHM:
 * DBSCAN groups points within eps distance, requiring minPoints neighbors.
 * Points without enough neighbors are marked as outliers (noise).
 *
 * PARAMETERS:
 * - eps: Neighborhood radius (default 0.02m = 2cm)
 * - minPoints: Minimum cluster size (default 3)
 *
 * EXPORTS:
 * - dbscan(points, eps, minPoints): Returns { clusters, outliers }
 * - removeOutliers(points, eps, minPoints): Returns filtered points array
 *
 * USAGE: Used by DepthProcessor to clean point clouds before centroid/PCA
 * =============================================================================
 */

import { Vector3 as THREEVector3 } from "three";

/**
 * DBSCAN (Density-Based Spatial Clustering of Applications with Noise) algorithm.
 * Removes outliers (flying pixels) from point clouds before PCA analysis.
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @param {number} eps - Distance threshold for neighborhood (default: 0.02m = 2cm)
 * @param {number} minPoints - Minimum points required to form a cluster (default: 3)
 * @returns {Object} {clusters: Array<Array<THREEVector3>>, outliers: Array<THREEVector3>}
 */
export function dbscan(points, eps = 0.02, minPoints = 3) {
  if (points.length === 0) {
    return { clusters: [], outliers: [] };
  }

  const visited = new Set();
  const clustered = new Set();
  const clusters = [];
  const outliers = [];

  // Helper: Calculate squared distance (avoiding sqrt for performance)
  const squaredDistance = (p1, p2) => {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    const dz = p1.z - p2.z;
    return dx * dx + dy * dy + dz * dz;
  };

  const epsSquared = eps * eps;

  // Find neighbors within eps distance
  const getNeighbors = (pointIndex) => {
    const neighbors = [];
    const point = points[pointIndex];
    for (let i = 0; i < points.length; i++) {
      if (i !== pointIndex && squaredDistance(point, points[i]) <= epsSquared) {
        neighbors.push(i);
      }
    }
    return neighbors;
  };

  // Expand cluster from a seed point
  const expandCluster = (pointIndex, neighbors, clusterId) => {
    clusters[clusterId] = clusters[clusterId] || [];
    clusters[clusterId].push(points[pointIndex]);
    clustered.add(pointIndex);

    let i = 0;
    while (i < neighbors.length) {
      const neighborIndex = neighbors[i];

      if (!visited.has(neighborIndex)) {
        visited.add(neighborIndex);
        const neighborNeighbors = getNeighbors(neighborIndex);
        if (neighborNeighbors.length >= minPoints) {
          neighbors.push(...neighborNeighbors);
        }
      }

      if (!clustered.has(neighborIndex)) {
        clusters[clusterId].push(points[neighborIndex]);
        clustered.add(neighborIndex);
      }

      i++;
    }
  };

  // Main DBSCAN algorithm
  let clusterId = 0;
  for (let i = 0; i < points.length; i++) {
    if (visited.has(i)) continue;

    visited.add(i);
    const neighbors = getNeighbors(i);

    if (neighbors.length < minPoints) {
      outliers.push(points[i]);
    } else {
      expandCluster(i, neighbors, clusterId);
      clusterId++;
    }
  }

  // Find largest cluster (assumed to be the main object)
  let largestCluster = null;
  let largestSize = 0;
  for (const cluster of clusters) {
    if (cluster.length > largestSize) {
      largestSize = cluster.length;
      largestCluster = cluster;
    }
  }

  return {
    clusters,
    outliers,
    largestCluster: largestCluster || [],
  };
}

/**
 * Removes outliers from a point cloud using DBSCAN.
 * Returns only the largest cluster (main object).
 *
 * @param {Array<THREEVector3>} points - Input point cloud
 * @param {number} eps - Distance threshold (default: 0.02m)
 * @param {number} minPoints - Minimum cluster size (default: 3)
 * @returns {Array<THREEVector3>} Cleaned point cloud (largest cluster only)
 */
export function removeOutliers(points, eps = 0.02, minPoints = 3) {
  if (points.length < minPoints) {
    return points;
  }

  const result = dbscan(points, eps, minPoints);
  return result.largestCluster.length > 0 ? result.largestCluster : points;
}
