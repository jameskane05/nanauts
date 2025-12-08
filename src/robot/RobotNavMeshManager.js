/**
 * RobotNavMeshManager.js - NavMesh generation and off-mesh connections
 * =============================================================================
 * 
 * ROLE: Generates navigation meshes from room surfaces for robot pathfinding.
 * Also creates off-mesh connections for jumps between disconnected surfaces.
 * 
 * NAVMESH GENERATION:
 *   - Uses navcat library (generateSoloNavMesh)
 *   - Input: Walkable surface meshes from NavSurfacesSystem
 *   - Config: Cell size, walkable height/climb/slope, etc.
 * 
 * OFF-MESH CONNECTIONS:
 *   - Enables robots to jump between surfaces not connected by walkable area
 *   - Created between nearby edge points of different surfaces
 *   - Bidirectional connections for jump down/up
 * 
 * KEY METHODS:
 *   - rebuild(): Regenerate navmesh from current surfaces
 *   - dispose(): Clean up navmesh resources
 *   - createDebugHelpers(): Visualization for debugging
 * 
 * DEBUG VISUALIZATION:
 *   - NavMesh polygons (createNavMeshHelper)
 *   - Off-mesh connections (createNavMeshOffMeshConnectionsHelper)
 *   - Enabled via ?navmeshDebug=true or RobotSystem.setDebugVisuals(true)
 * 
 * DEPENDENCIES:
 *   - NavSurfacesSystem: Provides walkable surface meshes
 *   - BlockPlacerSystem: Provides placed blocks for obstacles
 * 
 * CONFIG: this.config contains Recast navmesh generation parameters.
 * =============================================================================
 */
import {
  addOffMeshConnection,
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  OffMeshConnectionDirection,
} from "navcat";
import { crowd, generateSoloNavMesh } from "navcat/blocks";
import {
  getPositionsAndIndices,
  createNavMeshHelper,
  createNavMeshOffMeshConnectionsHelper,
} from "navcat/three";
import { Logger } from "../utils/Logger.js";

export class RobotNavMeshManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotNavMeshManager", false);

    // NavMesh state
    this.navMesh = null;
    this.navMeshInitialized = false;
    this.lastNavMeshRebuildTime = 0;

    // Visualization helpers
    this.navMeshHelper = null;
    this.offMeshHelper = null;

    // NavMesh configuration
    this.config = {
      cellSize: 0.1,
      cellHeight: 0.1,
      walkableRadiusWorld: 0.1,
      walkableClimbWorld: 0.2,
      walkableHeightWorld: 0.5,
      walkableSlopeAngleDegrees: 45,
      borderSize: 0,
      minRegionArea: 0,
      mergeRegionArea: 0,
      maxSimplificationError: 1.3,
      maxEdgeLength: 12,
      maxVerticesPerPoly: 6,
      detailSampleDistanceVoxels: 6,
      detailSampleMaxErrorVoxels: 1,
    };
  }

  rebuild() {
    const rs = this.robotSystem;
    const navSurfacesSystem = rs.world.navSurfacesSystem;
    if (!navSurfacesSystem) {
      this.logger.warn("NavSurfacesSystem not available");
      return false;
    }

    const surfaces = navSurfacesSystem.getAllSurfaces();
    const walkableMeshes = surfaces.map((s) => s.mesh);

    const blockPlacerSystem = rs.world.blockPlacerSystem;
    if (blockPlacerSystem) {
      const blockMeshes = blockPlacerSystem.getBlockMeshes();
      walkableMeshes.push(...blockMeshes);
    }

    if (walkableMeshes.length === 0) {
      return false;
    }

    walkableMeshes.forEach((mesh) => mesh.updateMatrixWorld(true));
    const [positions, indices] = getPositionsAndIndices(walkableMeshes);

    const c = this.config;
    const cellSize = c.cellSize;
    const cellHeight = c.cellHeight;
    const walkableRadiusVoxels = Math.ceil(c.walkableRadiusWorld / cellSize);
    const walkableClimbVoxels = Math.ceil(c.walkableClimbWorld / cellHeight);
    const walkableHeightVoxels = Math.ceil(c.walkableHeightWorld / cellHeight);
    const detailSampleDistance = c.detailSampleDistanceVoxels < 0.9 ? 0 : cellSize * c.detailSampleDistanceVoxels;
    const detailSampleMaxError = cellHeight * c.detailSampleMaxErrorVoxels;

    const navMeshConfig = {
      cellSize,
      cellHeight,
      walkableRadiusWorld: c.walkableRadiusWorld,
      walkableRadiusVoxels,
      walkableHeightWorld: c.walkableHeightWorld,
      walkableHeightVoxels,
      walkableSlopeAngleDegrees: c.walkableSlopeAngleDegrees,
      walkableClimbWorld: c.walkableClimbWorld,
      walkableClimbVoxels,
      borderSize: c.borderSize,
      minRegionArea: c.minRegionArea,
      mergeRegionArea: c.mergeRegionArea,
      maxSimplificationError: c.maxSimplificationError,
      maxEdgeLength: c.maxEdgeLength,
      maxVerticesPerPoly: c.maxVerticesPerPoly,
      detailSampleDistance,
      detailSampleMaxError,
    };

    try {
      const navMeshResult = generateSoloNavMesh({ positions, indices }, navMeshConfig);
      this.navMesh = navMeshResult.navMesh;

      if (rs.showDebugVisuals) {
        this.createVisualizations();
      }
    } catch (error) {
      this.logger.error("Navmesh generation error:", error);
      return false;
    }

    this.createOffMeshConnections();
    this.lastNavMeshRebuildTime = performance.now();

    if (rs.goalPosition) {
      rs.evaluateGoalAccessibility();
    }

    // Update existing agents to new navmesh
    for (const [entityIndex, agentId] of rs.robotAgentIds.entries()) {
      const agent = rs.agents?.agents?.[agentId];
      if (agent) {
        const currentPos = agent.position;
        const nearestResult = findNearestPoly(
          createFindNearestPolyResult(),
          this.navMesh,
          currentPos,
          [1, 1, 1],
          DEFAULT_QUERY_FILTER
        );
          if (nearestResult.success) {
            if (rs.goalAccessible && rs.goalNodeRef) {
              crowd.requestMoveTarget(rs.agents, agentId, rs.goalNodeRef, rs.goalPosition);
            } else {
              crowd.requestMoveTarget(rs.agents, agentId, nearestResult.nodeRef, nearestResult.position);
            }
          }
      }
    }

    this.logger.log("Navmesh rebuilt with", surfaces.length, "surfaces");

    if (!rs.agents && this.navMesh) {
      rs.agents = crowd.create(rs.maxRobots);
      this.logger.log("Crowd created with maxAgents:", rs.maxRobots);
    }

    this.navMeshInitialized = true;
    this.logger.log("NavMesh ready for robot spawning");
    return true;
  }

  createOffMeshConnections() {
    const rs = this.robotSystem;
    const navSurfacesSystem = rs.world.navSurfacesSystem;
    if (!navSurfacesSystem) return;

    const surfaces = navSurfacesSystem.getAllSurfaces();
    if (surfaces.length < 2) return;

    // Separate floor from other surfaces (tables, etc.)
    const floorSurface = navSurfacesSystem.getFloorSurface();
    const otherSurfaces = surfaces.filter(s => s !== floorSurface);

    // Create connections between floor and each table
    if (floorSurface) {
      for (const tableSurface of otherSurfaces) {
        const heightDiff = Math.abs(tableSurface.center[1] - floorSurface.center[1]);
        // Only connect if table is within reasonable jump height (1.5m)
        if (heightDiff > 1.5) continue;

        // Jump point on floor is directly below table edge (toward floor center)
        const tableCenter = tableSurface.center;
        const floorY = floorSurface.center[1];
        
        // Calculate edge of table closest to floor center
        const dx = floorSurface.center[0] - tableCenter[0];
        const dz = floorSurface.center[2] - tableCenter[2];
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const nx = dx / len;
        const nz = dz / len;
        
        const halfW = tableSurface.dimensions.width / 2;
        const halfD = tableSurface.dimensions.depth / 2;
        const tableExtent = Math.abs(nx) * halfW + Math.abs(nz) * halfD;
        const edgeMargin = 0.15;

        // Table edge point
        const tableEdge = [
          tableCenter[0] + nx * (tableExtent - edgeMargin),
          tableCenter[1],
          tableCenter[2] + nz * (tableExtent - edgeMargin),
        ];

        // Floor point directly below table edge, slightly offset outward
        const floorPoint = [
          tableEdge[0] + nx * 0.3,
          floorY,
          tableEdge[2] + nz * 0.3,
        ];

        const startResult = findNearestPoly(
          createFindNearestPolyResult(),
          this.navMesh,
          floorPoint,
          [0.5, 1.0, 0.5],
          DEFAULT_QUERY_FILTER
        );

        const endResult = findNearestPoly(
          createFindNearestPolyResult(),
          this.navMesh,
          tableEdge,
          [0.5, 0.5, 0.5],
          DEFAULT_QUERY_FILTER
        );

        if (startResult.success && endResult.success) {
          addOffMeshConnection(this.navMesh, {
            start: floorPoint,
            end: tableEdge,
            direction: OffMeshConnectionDirection.BIDIRECTIONAL,
            radius: 0.3,
            flags: 0xffffff,
            area: 0x000000,
          });

          this.logger.log(
            `Floor-table connection: floor(${floorPoint[0].toFixed(2)}, ${floorPoint[2].toFixed(2)}) -> table(${tableEdge[0].toFixed(2)}, ${tableEdge[2].toFixed(2)}) height=${heightDiff.toFixed(2)}m`
          );
        }
      }
    }

    // Create connections between tables (original logic for same-height surfaces)
    for (let i = 0; i < otherSurfaces.length; i++) {
      for (let j = i + 1; j < otherSurfaces.length; j++) {
        const surface1 = otherSurfaces[i];
        const surface2 = otherSurfaces[j];
        const edgeDistance = this.calculateEdgeDistance(surface1, surface2);

        if (edgeDistance <= 2.0) {
          const { start, end } = this.calculateEdgeJumpPoints(surface1, surface2);

          const startResult = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            start,
            [0.5, 0.5, 0.5],
            DEFAULT_QUERY_FILTER
          );

          const endResult = findNearestPoly(
            createFindNearestPolyResult(),
            this.navMesh,
            end,
            [0.5, 0.5, 0.5],
            DEFAULT_QUERY_FILTER
          );

          if (startResult.success && endResult.success) {
            addOffMeshConnection(this.navMesh, {
              start: [start[0], start[1], start[2]],
              end: [end[0], end[1], end[2]],
              direction: OffMeshConnectionDirection.BIDIRECTIONAL,
              radius: 0.3,
              flags: 0xffffff,
              area: 0x000000,
            });

            this.logger.log(
              `Table-table connection: (${start[0].toFixed(2)}, ${start[2].toFixed(2)}) -> (${end[0].toFixed(2)}, ${end[2].toFixed(2)})`
            );
          }
        }
      }
    }

    if (rs.showDebugVisuals) {
      this.createOffMeshVisualization();
    }
  }

  calculateEdgeDistance(surface1, surface2) {
    const c1 = surface1.center;
    const c2 = surface2.center;
    const dx = c2[0] - c1[0];
    const dz = c2[2] - c1[2];
    const centerDist = Math.sqrt(dx * dx + dz * dz);

    const halfW1 = surface1.dimensions.width / 2;
    const halfD1 = surface1.dimensions.depth / 2;
    const halfW2 = surface2.dimensions.width / 2;
    const halfD2 = surface2.dimensions.depth / 2;

    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = dx / len;
    const nz = dz / len;

    const extent1 = Math.abs(nx) * halfW1 + Math.abs(nz) * halfD1;
    const extent2 = Math.abs(nx) * halfW2 + Math.abs(nz) * halfD2;

    return Math.max(0, centerDist - extent1 - extent2);
  }

  calculateEdgeJumpPoints(surface1, surface2) {
    const center1 = surface1.center;
    const center2 = surface2.center;

    const dx = center2[0] - center1[0];
    const dz = center2[2] - center1[2];
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = dx / len;
    const nz = dz / len;

    const halfW1 = surface1.dimensions.width / 2;
    const halfD1 = surface1.dimensions.depth / 2;
    const extent1 = Math.abs(nx) * halfW1 + Math.abs(nz) * halfD1;

    const halfW2 = surface2.dimensions.width / 2;
    const halfD2 = surface2.dimensions.depth / 2;
    const extent2 = Math.abs(nx) * halfW2 + Math.abs(nz) * halfD2;

    const edgeMargin = 0.1;

    const start = [
      center1[0] + nx * (extent1 - edgeMargin),
      center1[1],
      center1[2] + nz * (extent1 - edgeMargin),
    ];

    const end = [
      center2[0] - nx * (extent2 - edgeMargin),
      center2[1],
      center2[2] - nz * (extent2 - edgeMargin),
    ];

    return { start, end };
  }

  createVisualizations() {
    const rs = this.robotSystem;

    if (this.navMeshHelper) {
      rs.world.scene.remove(this.navMeshHelper);
    }

    if (this.navMesh) {
      this.navMeshHelper = createNavMeshHelper({
        navMesh: this.navMesh,
        navMeshMaterialColor: 0x00ffff,
        navMeshMaterialOpacity: 0.3,
      });
      this.navMeshHelper.position.y += 0.01;
      rs.world.scene.add(this.navMeshHelper);
    }
  }

  createOffMeshVisualization() {
    const rs = this.robotSystem;

    if (this.offMeshHelper) {
      rs.world.scene.remove(this.offMeshHelper);
    }

    if (this.navMesh) {
      this.offMeshHelper = createNavMeshOffMeshConnectionsHelper({
        navMesh: this.navMesh,
        lineColor: 0xff00ff,
      });
      this.offMeshHelper.position.y += 0.02;
      rs.world.scene.add(this.offMeshHelper);
    }
  }

  removeVisualizations() {
    const rs = this.robotSystem;

    if (this.navMeshHelper) {
      rs.world.scene.remove(this.navMeshHelper);
      this.navMeshHelper = null;
    }
    if (this.offMeshHelper) {
      rs.world.scene.remove(this.offMeshHelper);
      this.offMeshHelper = null;
    }
  }

  findNearestPoly(position, halfExtents = [1, 1, 1]) {
    if (!this.navMesh) return null;
    return findNearestPoly(
      createFindNearestPolyResult(),
      this.navMesh,
      position,
      halfExtents,
      DEFAULT_QUERY_FILTER
    );
  }

  getNavMesh() {
    return this.navMesh;
  }

  isInitialized() {
    return this.navMeshInitialized;
  }
}

