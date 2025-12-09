/**
 * RobotNavigationManager.js - Goal and target selection for robot navigation
 * =============================================================================
 *
 * ROLE: Manages navigation goals, target selection, and movement commands.
 * Centralizes all path-finding and target logic that was scattered in RobotSystem.
 *
 * GOAL SYSTEM:
 *   - setGoal/clearGoal: Global goal all robots navigate toward
 *   - evaluateGoalAccessibility: Check if goal is reachable
 *   - checkRobotAtGoal: Track when robots reach the goal
 *   - onGoalReached: Callback when all robots arrive
 *
 * TARGET SELECTION:
 *   - setInitialWanderTarget: Random target on spawn
 *   - selectRandomWanderTarget: Random navmesh point
 *   - selectRandomTableTarget: Random surface center
 *   - setRobotNavigationTarget: Specific world position
 *
 * MOVEMENT CONTROL:
 *   - stopRobotMovement: Halt a robot in place
 *   - returnToSpawn: Navigate robot to its spawn position
 *
 * =============================================================================
 */
import { Logger } from "../utils/Logger.js";
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  findPath,
  findRandomPoint,
} from "navcat";
import { crowd } from "navcat/blocks";

export class RobotNavigationManager {
  constructor(robotSystem) {
    this.rs = robotSystem;
    this.logger = new Logger("RobotNavigationManager", true);

    // Goal state
    this.goalPosition = null;
    this.goalNodeRef = null;
    this.goalAccessible = false;
    this.robotsAtGoal = null;
    this.goalReachedCallback = null;
    this.goalReachThreshold = 2.0;
    this.goalReachThresholdSq = 4.0; // Squared for fast comparison
  }

  setGoal(goalPosition) {
    this.goalPosition = goalPosition;
    this.goalNodeRef = null;
    this.goalAccessible = false;
    this.robotsAtGoal = new Set();
    this.goalReachedCallback = null;

    this.logger.log(
      `Goal set at (${goalPosition[0].toFixed(2)}, ${goalPosition[1].toFixed(
        2
      )}, ${goalPosition[2].toFixed(2)})`
    );

    if (this.rs.navMesh) {
      this.evaluateGoalAccessibility();
    }
  }

  setGoalFromPosition(pos) {
    if (!pos) {
      this.logger.warn(
        "setGoalFromPosition called with null/undefined position"
      );
      return;
    }
    const goalArray = Array.isArray(pos) ? pos : [pos.x, pos.y, pos.z];
    // Validate array values
    if (goalArray.some((v) => v === undefined || v === null || isNaN(v))) {
      this.logger.warn(
        `Invalid goal position values: ${JSON.stringify(goalArray)}`
      );
      return;
    }
    this.setGoal(goalArray);
  }

  clearGoal() {
    this.goalPosition = null;
    this.goalNodeRef = null;
    this.goalAccessible = false;
    this.robotsAtGoal = null;
    this.logger.log("Goal cleared - robots returning to wander");

    for (const [entityIndex, agentId] of this.rs.robotAgentIds.entries()) {
      const robotEntity = this.rs.robotEntities.get(entityIndex);
      if (robotEntity) {
        this.selectRandomWanderTarget(robotEntity, agentId);
      }
    }
  }

  onGoalReached(callback) {
    this.goalReachedCallback = callback;
  }

  evaluateGoalAccessibility() {
    if (!this.rs.navMesh || !this.goalPosition) {
      this.logger.warn("evaluateGoalAccessibility: No navMesh or goalPosition");
      this.goalAccessible = false;
      return;
    }

    const goalResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.rs.navMesh,
      this.goalPosition,
      [1, 1, 1],
      DEFAULT_QUERY_FILTER
    );

    if (!goalResult.success) {
      this.logger.warn("evaluateGoalAccessibility: findNearestPoly failed");
      this.goalAccessible = false;
      return;
    }

    this.goalNodeRef = goalResult.nodeRef;
    this.logger.log(
      `evaluateGoalAccessibility: Found goalNodeRef=${goalResult.nodeRef}`
    );

    let canReach = false;
    for (const [entityIndex, agentId] of this.rs.robotAgentIds.entries()) {
      const agent = this.rs.agents.agents[agentId];
      if (!agent) continue;

      const pathResult = findPath(
        this.rs.navMesh,
        agent.position,
        this.goalPosition,
        [2, 2, 2],
        DEFAULT_QUERY_FILTER
      );

      if (pathResult.success && pathResult.path.length > 0) {
        canReach = true;
        break;
      }
    }

    this.goalAccessible = canReach;
    this.logger.log(`evaluateGoalAccessibility: goalAccessible=${canReach}`);

    if (this.goalAccessible) {
      this._sendAllRobotsToGoal();
    }
  }

  _sendAllRobotsToGoal() {
    let sentCount = 0;
    for (const [entityIndex, agentId] of this.rs.robotAgentIds.entries()) {
      const agent = this.rs.agents.agents[agentId];
      if (!agent) continue;

      const pathResult = findPath(
        this.rs.navMesh,
        agent.position,
        this.goalPosition,
        [2, 2, 2],
        DEFAULT_QUERY_FILTER
      );

      if (pathResult.success && pathResult.path.length > 0) {
        crowd.requestMoveTarget(
          this.rs.agents,
          agentId,
          this.goalNodeRef,
          this.goalPosition
        );
        sentCount++;
      }
    }
    this.logger.log(`_sendAllRobotsToGoal: Sent ${sentCount} robots to goal`);
  }

  checkRobotAtGoal(entityIndex, agentPosition) {
    if (!this.goalPosition || !this.robotsAtGoal) return false;

    const dx = agentPosition[0] - this.goalPosition[0];
    const dz = agentPosition[2] - this.goalPosition[2];
    const distSq = dx * dx + dz * dz;

    if (
      distSq < this.goalReachThresholdSq &&
      !this.robotsAtGoal.has(entityIndex)
    ) {
      this.robotsAtGoal.add(entityIndex);
      this.logger.log(
        `Robot ${entityIndex} reached goal (${this.robotsAtGoal.size}/${
          this.rs.robotAgentIds.size
        }) dist=${Math.sqrt(distSq).toFixed(2)}m`
      );

      if (this.robotsAtGoal.size >= this.rs.robotAgentIds.size) {
        this.logger.log("All robots reached goal!");
        if (this.goalReachedCallback) {
          this.goalReachedCallback();
        }
      }
      return true;
    }
    return false;
  }

  setInitialWanderTarget(robotEntity, agentId) {
    if (!this.rs.navMesh) {
      this.logger.warn("setInitialWanderTarget: No navmesh");
      return;
    }

    if (agentId === null || agentId === undefined) {
      this.logger.warn("setInitialWanderTarget: No robot agent ID");
      return;
    }

    const agent = this.rs.agents.agents[agentId];
    if (!agent) {
      const availableIds = Object.keys(this.rs.agents.agents);
      this.logger.warn(
        `setInitialWanderTarget: Agent not found for ID "${agentId}". Available IDs: [${availableIds.join(
          ", "
        )}]`
      );
      return;
    }

    const randomResult = findRandomPoint(
      this.rs.navMesh,
      DEFAULT_QUERY_FILTER,
      Math.random
    );

    if (!randomResult.success) {
      this.logger.warn("setInitialWanderTarget: findRandomPoint failed");
      return;
    }

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.rs.navMesh,
      randomResult.position,
      [1, 1, 1],
      DEFAULT_QUERY_FILTER
    );

    if (!nearestResult.success) {
      this.logger.warn(
        "setInitialWanderTarget: Could not find nearest poly to random point"
      );
      return;
    }

    this.logger.log(
      `Setting initial wander target to (${randomResult.position[0].toFixed(
        2
      )}, ${randomResult.position[1].toFixed(
        2
      )}, ${randomResult.position[2].toFixed(2)})`
    );

    crowd.requestMoveTarget(
      this.rs.agents,
      agentId,
      nearestResult.nodeRef,
      randomResult.position
    );
  }

  selectRandomWanderTarget(robotEntity, agentId) {
    if (!this.rs.navMesh || agentId === null || agentId === undefined) {
      this.logger.log(
        `selectRandomWanderTarget SKIPPED - navMesh: ${!!this.rs
          .navMesh}, agentId: ${agentId}`
      );
      return;
    }

    const agent = this.rs.agents.agents[agentId];
    if (!agent) {
      this.logger.log(
        `selectRandomWanderTarget SKIPPED - no agent for agentId: ${agentId}`
      );
      return;
    }

    const randomResult = findRandomPoint(
      this.rs.navMesh,
      DEFAULT_QUERY_FILTER,
      Math.random
    );

    if (randomResult.success) {
      const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        this.rs.navMesh,
        randomResult.position,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER
      );

      if (nearestResult.success) {
        const pos = randomResult.position;
        this.logger.log(
          `Robot ${agentId} -> wander target: (${pos[0].toFixed(
            2
          )}, ${pos[1].toFixed(2)}, ${pos[2].toFixed(2)})`
        );
        crowd.requestMoveTarget(
          this.rs.agents,
          agentId,
          nearestResult.nodeRef,
          randomResult.position
        );
      } else {
        this.logger.log(
          `selectRandomWanderTarget FAILED nearestPoly for agent ${agentId}`
        );
      }
    } else {
      this.logger.log(
        `selectRandomWanderTarget FAILED findRandomPoint for agent ${agentId}`
      );
    }
  }

  selectRandomTableTarget(robotEntity, agentId) {
    if (!this.rs.navMesh || agentId === null || agentId === undefined) return;

    const agent = this.rs.agents.agents[agentId];
    if (!agent) return;

    const navSurfacesSystem = this.rs.world.navSurfacesSystem;
    if (!navSurfacesSystem) return;

    const surfaces = navSurfacesSystem.getAllSurfaces();
    if (surfaces.length === 0) return;

    const randomSurface = surfaces[Math.floor(Math.random() * surfaces.length)];
    const targetPos = randomSurface.center;

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.rs.navMesh,
      targetPos,
      [0.5, 0.5, 0.5],
      DEFAULT_QUERY_FILTER
    );

    if (nearestResult.success) {
      crowd.requestMoveTarget(
        this.rs.agents,
        agentId,
        nearestResult.nodeRef,
        nearestResult.position
      );
    }
  }

  setRobotNavigationTarget(entityIndex, x, y, z) {
    if (!this.rs.navMesh) return;

    const agentId = this.rs.robotAgentIds.get(entityIndex);
    if (agentId === null || agentId === undefined) return;

    const agent = this.rs.agents.agents[agentId];
    if (!agent) return;

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.rs.navMesh,
      [x, y, z],
      [1, 1, 1],
      DEFAULT_QUERY_FILTER
    );

    if (nearestResult.success) {
      crowd.requestMoveTarget(
        this.rs.agents,
        agentId,
        nearestResult.nodeRef,
        nearestResult.position
      );
    }
  }

  stopRobotMovement(entityIndex) {
    // Don't stop robots 4 and 5 - they can navigate while panicking
    if (entityIndex === 4 || entityIndex === 5) {
      return;
    }

    const agentId = this.rs.robotAgentIds.get(entityIndex);
    if (agentId === null || agentId === undefined) return;

    const agent = this.rs.agents.agents[agentId];
    if (!agent) return;

    agent.velocity = [0, 0, 0];
    agent.desiredVelocity = [0, 0, 0];

    if (this.rs.navMesh) {
      const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        this.rs.navMesh,
        agent.position,
        [0.5, 0.5, 0.5],
        DEFAULT_QUERY_FILTER
      );

      if (nearestResult.success) {
        crowd.requestMoveTarget(
          this.rs.agents,
          agentId,
          nearestResult.nodeRef,
          agent.position
        );
      }
    }
  }

  returnToSpawn(entityIndex) {
    const spawnPos = this.rs.getSpawnPosition(entityIndex);
    if (!spawnPos || !this.rs.navMesh || !this.rs.agents) return false;

    const agentId = this.rs.robotAgentIds.get(entityIndex);
    if (agentId === null || agentId === undefined) return false;

    const nearestResult = findNearestPoly(
      createFindNearestPolyResult(),
      this.rs.navMesh,
      spawnPos,
      [1, 1, 1],
      DEFAULT_QUERY_FILTER
    );

    if (nearestResult.success) {
      crowd.requestMoveTarget(
        this.rs.agents,
        agentId,
        nearestResult.nodeRef,
        nearestResult.position
      );
      return true;
    }
    return false;
  }

  returnAllToSpawn() {
    for (const [entityIndex] of this.rs.robotAgentIds.entries()) {
      this.returnToSpawn(entityIndex);
    }
  }

  checkAllAtSpawn() {
    for (const [entityIndex, agentId] of this.rs.robotAgentIds.entries()) {
      const agent = this.rs.agents?.agents?.[agentId];
      const spawnPos = this.rs.getSpawnPosition(entityIndex);
      if (!agent || !spawnPos) continue;

      const dist = Math.sqrt(
        Math.pow(agent.position[0] - spawnPos[0], 2) +
          Math.pow(agent.position[2] - spawnPos[2], 2)
      );

      if (dist > 0.3) {
        return false;
      }
    }
    return true;
  }

  tryGoalOrWander(robotEntity, agentId) {
    if (this.goalAccessible && this.goalNodeRef) {
      crowd.requestMoveTarget(
        this.rs.agents,
        agentId,
        this.goalNodeRef,
        this.goalPosition
      );
    } else if (this.rs.useWandering) {
      this.selectRandomWanderTarget(robotEntity, agentId);
    } else {
      this.selectRandomTableTarget(robotEntity, agentId);
    }
  }
}
