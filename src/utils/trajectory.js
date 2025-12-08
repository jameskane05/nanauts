/**
 * Trajectory.js - POSITION HISTORY SMOOTHING AND VELOCITY CALCULATION
 * =============================================================================
 *
 * ROLE: Smooths object trajectories using exponential moving average and
 * calculates velocity from position history. Used for stable 3D tracking.
 *
 * KEY RESPONSIBILITIES:
 * - Smooth position history using EMA (exponential moving average)
 * - Calculate velocity vectors from position/timestamp pairs
 * - Predict future positions based on velocity
 * - Filter noisy position updates for stable display
 *
 * SMOOTHING:
 * Uses recency-weighted exponential moving average. Higher smoothingFactor
 * (0-1) gives more smoothing but increases lag.
 *
 * EXPORTS:
 * - smoothTrajectory(positionHistory, smoothingFactor): Smoothed position
 * - calculateTrajectoryVelocity(positionHistory): Velocity vector (m/s)
 * - predictPosition(position, velocity, dt): Future position prediction
 *
 * USAGE: Used by ObjectTracker for stable position updates
 * =============================================================================
 */

import { Vector3 as THREEVector3 } from "three";

/**
 * Smooths trajectory using exponential moving average.
 * Based on Paper 7: Video2MR trajectory visualization techniques.
 *
 * @param {Array<Object>} positionHistory - Array of {position, timestamp, uncertainty}
 * @param {number} smoothingFactor - Smoothing factor (0-1), higher = more smoothing (default: 0.7)
 * @returns {THREEVector3} Smoothed position
 */
export function smoothTrajectory(positionHistory, smoothingFactor = 0.7) {
  if (positionHistory.length === 0) {
    return new THREEVector3(0, 0, 0);
  }

  if (positionHistory.length === 1) {
    return positionHistory[0].position.clone();
  }

  // Exponential moving average with recency weighting
  let smoothed = positionHistory[0].position.clone();

  for (let i = 1; i < positionHistory.length; i++) {
    const current = positionHistory[i].position;
    const weight = Math.pow(smoothingFactor, positionHistory.length - i - 1);
    smoothed.lerp(current, 1.0 - weight);
  }

  return smoothed;
}

/**
 * Calculates trajectory velocity from position history.
 *
 * @param {Array<Object>} positionHistory - Array of {position, timestamp}
 * @returns {THREEVector3} Velocity vector in m/s
 */
export function calculateTrajectoryVelocity(positionHistory) {
  if (positionHistory.length < 2) {
    return new THREEVector3(0, 0, 0);
  }

  const recent = positionHistory.slice(-2);
  const dt = (recent[1].timestamp - recent[0].timestamp) / 1000.0; // Convert to seconds

  if (dt <= 0) {
    return new THREEVector3(0, 0, 0);
  }

  const velocity = new THREEVector3()
    .subVectors(recent[1].position, recent[0].position)
    .multiplyScalar(1.0 / dt);

  return velocity;
}

/**
 * Predicts future position based on trajectory.
 * Uses velocity extrapolation.
 *
 * @param {Array<Object>} positionHistory - Array of {position, timestamp}
 * @param {number} predictionTime - Time to predict ahead in seconds (default: 0.1)
 * @returns {THREEVector3|null} Predicted position or null if insufficient data
 */
export function predictTrajectory(positionHistory, predictionTime = 0.1) {
  if (positionHistory.length < 2) {
    return null;
  }

  const current = positionHistory[positionHistory.length - 1];
  const velocity = calculateTrajectoryVelocity(positionHistory);

  const predicted = new THREEVector3()
    .copy(current.position)
    .addScaledVector(velocity, predictionTime);

  return predicted;
}

/**
 * Visualizes trajectory as a line or curve.
 * Returns points for rendering a trajectory visualization.
 *
 * @param {Array<Object>} positionHistory - Array of {position, timestamp}
 * @param {number} maxPoints - Maximum number of points to return (default: 20)
 * @returns {Array<THREEVector3>} Array of points for trajectory visualization
 */
export function getTrajectoryPoints(positionHistory, maxPoints = 20) {
  if (positionHistory.length === 0) {
    return [];
  }

  // Sample points evenly from history
  const step = Math.max(1, Math.floor(positionHistory.length / maxPoints));
  const points = [];

  for (let i = 0; i < positionHistory.length; i += step) {
    points.push(positionHistory[i].position.clone());
  }

  // Always include the most recent point
  if (
    positionHistory.length > 0 &&
    points[points.length - 1] !==
      positionHistory[positionHistory.length - 1].position
  ) {
    points.push(positionHistory[positionHistory.length - 1].position.clone());
  }

  return points;
}
