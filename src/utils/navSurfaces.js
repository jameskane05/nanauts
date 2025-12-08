/**
 * NavSurfaces.js - XR MESH DETECTION AND NAVIGATION SURFACE PROCESSING
 * =============================================================================
 *
 * ROLE: ECS system that processes XRMesh entities from Quest scene understanding
 * to identify navigable surfaces (floors, tables). Calculates environment bounds
 * and provides surface data for robot navigation.
 *
 * KEY RESPONSIBILITIES:
 * - Subscribe to XRMesh qualify/disqualify events
 * - Classify surfaces by semantic label (floor, table, wall, etc.)
 * - Track first/last detected surfaces for spawn positioning
 * - Calculate combined environment bounds from all meshes
 * - Create optional debug visualization panels for surfaces
 * - Provide surface data to RobotNavMeshManager for pathfinding
 *
 * SURFACE CLASSIFICATION:
 * - floor/ground: Navigable walking surfaces
 * - table: Elevated surfaces for object placement
 * - wall/ceiling: Non-navigable boundaries
 *
 * REGISTRATION: this.world.navSurfacesSystem = this
 *
 * USAGE: Registered as system in index.js. Other systems access via world reference.
 * =============================================================================
 */

import {
  createSystem,
  PanelUI,
  PanelDocument,
  XRMesh,
  Vector3,
  Box3,
  BoxGeometry,
  eq,
  PlaneGeometry,
  MeshBasicMaterial,
  Mesh,
  Group,
} from "@iwsdk/core";
import { Logger } from "./Logger.js";

export class NavSurfacesSystem extends createSystem({
  detectedMeshes: { required: [XRMesh] },
  surfaceLabelPanels: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/mesh-label.json")],
  },
}) {
  init() {
    this.showSurfaceLabels = false;

    this.tableMeshes = new Map();
    this.surfaces = new Map();
    this.surfacePanels = new Map();
    this.pendingPanels = new Map();
    this.vec3 = new Vector3();
    this.offset = new Vector3(0, 0.3, 0);
    this.firstSurface = null;
    this.lastSurface = null;
    this.environmentBounds = null; // Combined bounds of all detected meshes
    this.logger = new Logger("NavSurfacesSystem", true);

    // Track occluded meshes for debug visualization
    this.occludedMeshes = new Map(); // entityIndex -> original geometry
    this._debugOcclusionGroup = null;

    this.world.navSurfacesSystem = this;

    this.queries.detectedMeshes.subscribe("qualify", (entity) => {
      this.handleMeshDetected(entity);
    });

    this.queries.detectedMeshes.subscribe("disqualify", (entity) => {
      this.handleMeshRemoved(entity);
    });

    this.queries.surfaceLabelPanels.subscribe("qualify", (panelEntity) => {
      const pending = this.pendingPanels.get(panelEntity.index);
      if (pending) {
        const document = PanelDocument.data.document?.[panelEntity.index];
        if (document) {
          const textElement = document.getElementById("mesh-label-text");
          if (textElement) {
            textElement.setProperties({ text: pending.label });
            this.surfacePanels.set(pending.surfaceId, {
              panelEntity,
              textElement,
              label: pending.label,
            });
            this.pendingPanels.delete(panelEntity.index);
          }
        }
      }
    });
  }

  handleMeshDetected(meshEntity) {
    const semanticLabel = XRMesh.data.semanticLabel?.[meshEntity.index] || "";
    const labelLower = semanticLabel.toLowerCase();
    const isBounded = XRMesh.data.isBounded3D?.[meshEntity.index] ?? true;

    // Update environment bounds with all detected meshes
    this.updateEnvironmentBounds(meshEntity);

    this.logger.log(
      "Mesh detected - label:",
      semanticLabel || "(none)",
      "isBounded:",
      isBounded
    );

    // Global meshes (isBounded3D = false) are room structure - configure for occlusion
    // Skip doors and windows - they should be see-through when open
    if (!isBounded) {
      if (labelLower === "door" || labelLower === "window") {
        this.logger.log(
          `Skipping occlusion for ${semanticLabel} - should be see-through`
        );
        this.tryDetectFloor(meshEntity);
        return;
      }
      this.logger.log(
        "Global mesh (room structure) detected - configuring for occlusion"
      );
      this.configureForOcclusion(meshEntity);
      this.tryDetectFloor(meshEntity);
      return;
    }

    // Also skip occlusion for bounded door/window meshes
    if (labelLower === "door" || labelLower === "window") {
      this.logger.log(
        `Bounded ${semanticLabel} detected - skipping (no occlusion)`
      );
      return;
    }

    // Bounded meshes have semantic labels
    if (labelLower === "table") {
      this.tableMeshes.set(meshEntity.index, meshEntity);
      this.logger.log(
        "Table detected:",
        semanticLabel,
        "Total tables:",
        this.tableMeshes.size
      );
      this.createSurfaceForTable(meshEntity);
    } else if (labelLower === "floor" || labelLower === "ground") {
      this.logger.log("Floor/ground detected:", semanticLabel);
      this.createSurfaceForFloor(meshEntity);
    } else if (labelLower === "" || labelLower === "other") {
      // Check if unlabeled bounded mesh is floor-like
      this.tryDetectFloor(meshEntity);
    }
  }

  tryDetectFloor(meshEntity) {
    const meshObject = meshEntity.object3D;
    if (!meshObject) return;

    const boundingBox = new Box3();
    let hasGeometry = false;

    meshObject.updateMatrixWorld(true);
    meshObject.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.updateMatrixWorld(true);
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox) {
          const childBox = child.geometry.boundingBox.clone();
          childBox.applyMatrix4(child.matrixWorld);
          if (!hasGeometry) {
            boundingBox.copy(childBox);
            hasGeometry = true;
          } else {
            boundingBox.union(childBox);
          }
        }
      }
    });

    if (!hasGeometry || boundingBox.isEmpty()) return;

    const min = boundingBox.min;
    const max = boundingBox.max;
    const width = max.x - min.x;
    const depth = max.z - min.z;
    const height = max.y - min.y;

    // For global meshes (room structure), extract floor from the bottom
    // Check if it has significant horizontal extent
    const isWide = width > 0.5 && depth > 0.5;
    // Global meshes may be tall (include walls), so check if bottom is near ground
    const bottomNearGround = min.y < 0.3 && min.y > -1.0;

    this.logger.log(
      `Checking mesh: ${width.toFixed(1)}x${depth.toFixed(1)}x${height.toFixed(
        2
      )}m, minY=${min.y.toFixed(
        2
      )}, isWide=${isWide}, bottomNearGround=${bottomNearGround}`
    );

    // If the mesh has horizontal extent and bottom is near ground, create floor surface
    if (isWide && bottomNearGround) {
      this.logger.log("Detected floor-like surface from unlabeled mesh");
      this.createSurfaceForFloor(meshEntity);
    }
  }

  updateEnvironmentBounds(meshEntity) {
    const meshObject = meshEntity.object3D;
    if (!meshObject) return;

    const min = XRMesh.data.min?.[meshEntity.index];
    const max = XRMesh.data.max?.[meshEntity.index];

    if (!min || !max) {
      // Fallback: compute bounds from geometry
      const boundingBox = new Box3();
      let hasGeometry = false;

      meshObject.updateMatrixWorld(true);
      meshObject.traverse((child) => {
        if (child.isMesh && child.geometry) {
          child.updateMatrixWorld(true);
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox) {
            const childBox = child.geometry.boundingBox.clone();
            childBox.applyMatrix4(child.matrixWorld);
            if (!hasGeometry) {
              boundingBox.copy(childBox);
              hasGeometry = true;
            } else {
              boundingBox.union(childBox);
            }
          }
        }
      });

      if (!hasGeometry) return;

      if (!this.environmentBounds) {
        this.environmentBounds = boundingBox.clone();
      } else {
        this.environmentBounds.union(boundingBox);
      }
    } else {
      // Use XRMesh min/max data
      const meshBox = new Box3(
        new Vector3(
          min.x || min.X || 0,
          min.y || min.Y || 0,
          min.z || min.Z || 0
        ),
        new Vector3(
          max.x || max.X || 0,
          max.y || max.Y || 0,
          max.z || max.Z || 0
        )
      );

      if (!this.environmentBounds) {
        this.environmentBounds = meshBox.clone();
      } else {
        this.environmentBounds.union(meshBox);
      }
    }
  }

  configureForOcclusion(meshEntity) {
    // Configure detected mesh for MR occlusion:
    // - Invisible (no color output)
    // - Writes to depth buffer (occludes virtual objects behind it)
    // - Tests stencil to create "hole" where portal is (stencil == 1)
    const meshObject = meshEntity.object3D;
    if (!meshObject) return;

    // Create dedicated occluder material - opaque, writes depth, no color
    // Tests stencil: only render where stencil != 1 (portal mask writes 1)
    const occluderMaterial = new MeshBasicMaterial({
      colorWrite: false,
      stencilWrite: false,
      stencilRef: 1,
      stencilFunc: 517, // NotEqualStencilFunc - skip where portal mask wrote
      stencilFail: 7680, // KeepStencilOp
      stencilZFail: 7680,
      stencilZPass: 7680,
    });
    // Ensure it's treated as opaque for proper depth rendering
    occluderMaterial.transparent = false;
    occluderMaterial.depthWrite = true;
    occluderMaterial.depthTest = true;

    // Track for debug visualization - clone geometry before material swap
    const semanticLabel =
      XRMesh.data.semanticLabel?.[meshEntity.index] || "(none)";
    meshObject.traverse((child) => {
      if (child.isMesh && child.geometry) {
        this.occludedMeshes.set(meshEntity.index, {
          geometry: child.geometry.clone(),
          worldMatrix: child.matrixWorld.clone(),
          label: semanticLabel,
        });
      }
    });

    // Replace materials on all mesh children
    meshObject.traverse((child) => {
      if (child.isMesh) {
        // Dispose old material
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose?.());
          } else {
            child.material.dispose?.();
          }
        }
        // Apply occluder material
        child.material = occluderMaterial;
        // Render AFTER portal stencil mask (-895) so stencil is already written
        child.renderOrder = -800;
      }
    });

    this.logger.log("Configured mesh for occlusion:", semanticLabel);

    // Update debug visualization if active
    this._updateDebugOcclusionVis();
  }

  enableDebugOcclusionVisualization() {
    // Create group to hold miniature occlusion mesh
    this._debugOcclusionGroup = new Group();
    this._debugOcclusionGroup.name = "debug-occlusion-vis";
    this.world.scene.add(this._debugOcclusionGroup);

    // Store last hand quaternion for rotation tracking
    this._debugLastHandQuat = null;

    this._updateDebugOcclusionVis();
    this.logger.log("Debug occlusion visualization enabled");
  }

  _getLabelColor(label) {
    // Different colors for different semantic labels
    const labelLower = (label || "").toLowerCase();
    if (labelLower.includes("floor") || labelLower.includes("ground"))
      return 0x00ff00; // Green
    if (labelLower.includes("wall")) return 0x0088ff; // Blue
    if (labelLower.includes("ceiling")) return 0xff8800; // Orange
    if (labelLower.includes("table")) return 0xffff00; // Yellow
    if (labelLower.includes("door")) return 0xff0000; // Red
    if (labelLower.includes("window")) return 0x00ffff; // Cyan
    if (labelLower.includes("couch") || labelLower.includes("sofa"))
      return 0x8800ff; // Purple
    if (labelLower.includes("shelf")) return 0x888888; // Gray
    return 0xff00ff; // Magenta for unknown
  }

  _updateDebugOcclusionVis() {
    if (!this._debugOcclusionGroup) return;

    // Clear old children
    while (this._debugOcclusionGroup.children.length > 0) {
      const child = this._debugOcclusionGroup.children[0];
      this._debugOcclusionGroup.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }

    // Create miniature debug meshes - 50% bigger than before
    const scale = 0.045; // 4.5cm per meter (was 3cm)

    for (const [entityIdx, data] of this.occludedMeshes) {
      const color = this._getLabelColor(data.label);
      const debugMaterial = new MeshBasicMaterial({
        color: color,
        wireframe: true,
        transparent: true,
        opacity: 0.8,
      });

      const debugMesh = new Mesh(data.geometry, debugMaterial);
      debugMesh.scale.setScalar(scale);
      debugMesh.name = data.label || "unknown";

      // Rotate to make floor horizontal (XR meshes are in world space)
      // No additional rotation needed - just scale down
      this._debugOcclusionGroup.add(debugMesh);
    }

    this.logger.log(
      `Debug occlusion: ${this.occludedMeshes.size} meshes visualized (colors: floor=green, wall=blue, ceiling=orange, table=yellow, door=red, window=cyan)`
    );
  }

  updateDebugOcclusionPosition(leftHandPos, leftHandQuat) {
    if (!this._debugOcclusionGroup || !leftHandPos) return;

    // Position above left hand
    this._debugOcclusionGroup.position.set(
      leftHandPos.x,
      leftHandPos.y + 0.2, // Raised a bit more for bigger model
      leftHandPos.z
    );

    // Rotate with hand if quaternion provided
    if (leftHandQuat) {
      this._debugOcclusionGroup.quaternion.copy(leftHandQuat);
    }
  }

  handleMeshRemoved(meshEntity) {
    if (this.tableMeshes.has(meshEntity.index)) {
      this.tableMeshes.delete(meshEntity.index);
      this.removeSurface(`surface_${meshEntity.index}`);
    }
    // Also check for floor surfaces
    this.removeSurface(`floor_${meshEntity.index}`);

    // Clean up simplified raycast mesh cache
    if (this._simplifiedMeshes?.has(meshEntity.index)) {
      const mesh = this._simplifiedMeshes.get(meshEntity.index);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
      this._simplifiedMeshes.delete(meshEntity.index);
    }
  }

  removeSurface(surfaceId) {
    const surfaceData = this.surfaces.get(surfaceId);
    if (!surfaceData) return;

    if (surfaceData.entity) {
      surfaceData.entity.destroy();
    }
    if (surfaceData.mesh) {
      surfaceData.mesh.geometry?.dispose();
      surfaceData.mesh.material?.dispose();
    }
    this.surfaces.delete(surfaceId);

    // Clean up simplified surface mesh cache
    const cacheKey = `surface_${surfaceId}`;
    if (this._simplifiedMeshes?.has(cacheKey)) {
      const mesh = this._simplifiedMeshes.get(cacheKey);
      mesh.geometry?.dispose();
      mesh.material?.dispose();
      this._simplifiedMeshes.delete(cacheKey);
    }

    const panelData = this.surfacePanels.get(surfaceId);
    if (panelData?.panelEntity) {
      panelData.panelEntity.destroy();
    }
    this.surfacePanels.delete(surfaceId);

    this.logger.log("Removed surface:", surfaceId);
  }

  createSurfaceForTable(meshEntity) {
    const meshObject = meshEntity.object3D;
    if (!meshObject) {
      this.logger.warn(
        "createSurfaceForTable: meshObject is null for entity",
        meshEntity.index
      );
      return null;
    }

    const boundingBox = new Box3();
    let hasGeometry = false;

    meshObject.updateMatrixWorld(true);

    meshObject.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.updateMatrixWorld(true);
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox) {
          const childBox = child.geometry.boundingBox.clone();
          childBox.applyMatrix4(child.matrixWorld);
          if (!hasGeometry) {
            boundingBox.copy(childBox);
            hasGeometry = true;
          } else {
            boundingBox.union(childBox);
          }
        }
      }
    });

    if (!hasGeometry || boundingBox.isEmpty()) {
      this.logger.warn(
        "createSurfaceForTable: No geometry found for entity",
        meshEntity.index
      );
      return null;
    }

    const min = boundingBox.min;
    const max = boundingBox.max;
    const center = boundingBox.getCenter(new Vector3());

    const width = max.x - min.x;
    const depth = max.z - min.z;
    const height = max.y - min.y;
    const tableTopY = max.y;

    if (width <= 0 || depth <= 0) {
      this.logger.warn(
        "createSurfaceForTable: Invalid dimensions for entity",
        meshEntity.index,
        "width:",
        width,
        "depth:",
        depth
      );
      return null;
    }

    const geometry = new PlaneGeometry(width, depth);
    const material = new MeshBasicMaterial({
      color: 0x888888,
      transparent: true,
      opacity: 0.1,
      side: 2,
    });
    const surface = new Mesh(geometry, material);

    meshObject.getWorldPosition(this.vec3);
    this.logger.log(
      "Mesh object world position:",
      this.vec3,
      "Bounding box center:",
      center,
      "tableTopY:",
      tableTopY
    );

    surface.position.set(center.x, tableTopY, center.z);
    surface.rotation.x = -Math.PI / 2;
    surface.visible = false;

    this.logger.log(
      "Surface created at position:",
      surface.position,
      "Dimensions:",
      width.toFixed(2),
      "×",
      depth.toFixed(2),
      "m"
    );

    const surfaceEntity = this.world.createTransformEntity(surface);

    const surfaceId = `surface_${meshEntity.index}`;
    const surfaceData = {
      mesh: surface,
      entity: surfaceEntity,
      center: [center.x, tableTopY, center.z],
      dimensions: { width, depth, height },
      tableEntity: meshEntity,
      id: surfaceId,
    };

    this.surfaces.set(surfaceId, surfaceData);
    this.logger.log(
      "Created surface:",
      surfaceId,
      "at",
      surfaceData.center,
      `(${width.toFixed(2)}×${depth.toFixed(2)}m)`
    );

    // Track first and last table surfaces
    if (!this.firstSurface) {
      this.firstSurface = surfaceData;
      // Note: createStartMarker removed - was debug visualization
    }
    this.lastSurface = surfaceData;

    if (this.showSurfaceLabels) {
      this.createLabelForSurface(surfaceData);
    }

    return surfaceData;
  }

  createSurfaceForFloor(meshEntity) {
    const meshObject = meshEntity.object3D;
    if (!meshObject) return null;

    meshObject.updateMatrixWorld(true);

    // Find the first mesh with geometry to use directly for navmesh
    // Using actual mesh geometry respects walls and room shape
    let floorMesh = null;
    let boundingBox = new Box3();
    let hasGeometry = false;

    meshObject.traverse((child) => {
      if (child.isMesh && child.geometry) {
        child.updateMatrixWorld(true);
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox) {
          const childBox = child.geometry.boundingBox.clone();
          childBox.applyMatrix4(child.matrixWorld);
          if (!hasGeometry) {
            boundingBox.copy(childBox);
            hasGeometry = true;
            floorMesh = child; // Use the first mesh we find
          } else {
            boundingBox.union(childBox);
          }
        }
      }
    });

    if (!hasGeometry || boundingBox.isEmpty()) return null;

    const min = boundingBox.min;
    const max = boundingBox.max;
    const center = boundingBox.getCenter(new Vector3());

    const width = max.x - min.x;
    const depth = max.z - min.z;
    const floorY = min.y;

    if (width <= 0 || depth <= 0) return null;

    // Use the actual mesh geometry for navmesh generation
    // This respects the room's actual shape including walls
    // Clone the mesh so we don't modify the original XRMesh
    let surfaceMesh;
    if (floorMesh && floorMesh.geometry) {
      const clonedGeometry = floorMesh.geometry.clone();
      const material = new MeshBasicMaterial({
        color: 0x44aa44,
        transparent: true,
        opacity: 0.1,
        side: 2,
      });
      surfaceMesh = new Mesh(clonedGeometry, material);
      // Apply the world transform to the cloned mesh
      surfaceMesh.applyMatrix4(floorMesh.matrixWorld);
      surfaceMesh.visible = false; // Hide the debug visualization

      this.logger.log(
        `Using actual mesh geometry for floor (${width.toFixed(
          1
        )}x${depth.toFixed(1)}m bounds)`
      );
    } else {
      // Fallback to simple plane if no mesh geometry available
      const geometry = new PlaneGeometry(width, depth);
      const material = new MeshBasicMaterial({
        color: 0x44aa44,
        transparent: true,
        opacity: 0.1,
        side: 2,
      });
      surfaceMesh = new Mesh(geometry, material);
      surfaceMesh.position.set(center.x, floorY, center.z);
      surfaceMesh.rotation.x = -Math.PI / 2;
      surfaceMesh.visible = false;

      this.logger.log(
        `Using simplified plane for floor: ${width.toFixed(1)}x${depth.toFixed(
          1
        )}m`
      );
    }

    const surfaceEntity = this.world.createTransformEntity(surfaceMesh);

    const surfaceId = `floor_${meshEntity.index}`;
    const surfaceData = {
      mesh: surfaceMesh,
      entity: surfaceEntity,
      center: [center.x, floorY, center.z],
      dimensions: { width, depth, height: 0 },
      isFloor: true,
      floorEntity: meshEntity,
      id: surfaceId,
    };

    this.surfaces.set(surfaceId, surfaceData);
    this.logger.log(
      "Created floor surface:",
      surfaceId,
      "at Y=",
      floorY.toFixed(2)
    );

    // Notify robot system to rebuild navmesh
    if (this.world.robotSystem) {
      this.world.robotSystem.rebuildNavMesh();
    }

    return surfaceData;
  }

  createLabelForSurface(surfaceData) {
    const panelEntity = this.world.createTransformEntity();
    panelEntity.addComponent(PanelUI, { config: "./ui/mesh-label.json" });

    const label = `Table Surface\n${surfaceData.dimensions.width.toFixed(
      1
    )}×${surfaceData.dimensions.depth.toFixed(1)}m`;

    this.pendingPanels.set(panelEntity.index, {
      surfaceId: surfaceData.id,
      label,
    });

    panelEntity.object3D.position.set(
      surfaceData.center[0],
      surfaceData.center[1] + 0.2,
      surfaceData.center[2]
    );
  }

  getAllSurfaces() {
    return Array.from(this.surfaces.values());
  }

  getFirstSurface() {
    const surfaces = this.getAllSurfaces();
    return surfaces.length > 0 ? surfaces[0] : null;
  }

  getRandomSurface() {
    const surfaces = this.getAllSurfaces();
    if (surfaces.length === 0) return null;
    return surfaces[Math.floor(Math.random() * surfaces.length)];
  }

  getSpawnPosition(surfaceData) {
    if (!surfaceData) return null;
    return {
      x: surfaceData.center[0],
      y: surfaceData.center[1] + 0.1,
      z: surfaceData.center[2],
    };
  }

  // Debug marker methods removed (createStartMarker, setGoalPosition, validateGoalPosition)
  // Goal placement is now handled by RobotSpawnerSystem

  getFirstSurface() {
    return this.firstSurface;
  }

  getLastSurface() {
    return this.lastSurface;
  }

  getFloorSurface() {
    for (const [id, surface] of this.surfaces) {
      if (id.startsWith("floor_")) {
        return surface;
      }
    }
    return null;
  }

  /**
   * Get all detected XRMesh objects for raycasting.
   * Returns an array of Three.js meshes that represent the real-world geometry.
   * @param {boolean} simplified - If true, returns simplified box meshes for faster raycasting
   * @returns {Array<Mesh>} Array of mesh objects
   */
  getRaycastMeshes(simplified = true) {
    // Use simplified geometry cache for performance
    if (simplified) {
      return this._getSimplifiedRaycastMeshes();
    }

    // Full detailed meshes (slower but more accurate)
    const meshes = [];
    for (const entity of this.queries.detectedMeshes.entities) {
      const meshObject = entity.object3D;
      if (!meshObject) continue;

      // Traverse to find all actual mesh children
      meshObject.traverse((child) => {
        if (child.isMesh && child.geometry) {
          meshes.push(child);
        }
      });
    }
    return meshes;
  }

  /**
   * Get simplified box meshes for fast raycasting.
   * Creates invisible box meshes from the bounding boxes of detected XRMeshes.
   */
  _getSimplifiedRaycastMeshes() {
    // Lazy init simplified meshes cache
    if (!this._simplifiedMeshes) {
      this._simplifiedMeshes = new Map();
    }

    const meshes = [];
    for (const entity of this.queries.detectedMeshes.entities) {
      const meshObject = entity.object3D;
      if (!meshObject) continue;

      // Check if we already have a simplified mesh for this entity
      let simpleMesh = this._simplifiedMeshes.get(entity.index);
      if (!simpleMesh) {
        // Create simplified box mesh from bounding box
        const box = new Box3();
        meshObject.updateMatrixWorld(true);
        meshObject.traverse((child) => {
          if (child.isMesh && child.geometry) {
            child.geometry.computeBoundingBox();
            if (child.geometry.boundingBox) {
              const childBox = child.geometry.boundingBox.clone();
              childBox.applyMatrix4(child.matrixWorld);
              box.union(childBox);
            }
          }
        });

        if (!box.isEmpty()) {
          const size = box.getSize(new Vector3());
          const center = box.getCenter(new Vector3());

          // Create invisible box mesh for raycasting
          const boxGeo = new BoxGeometry(size.x, size.y, size.z);
          const boxMat = new MeshBasicMaterial({ visible: false });
          simpleMesh = new Mesh(boxGeo, boxMat);
          simpleMesh.position.copy(center);
          simpleMesh.updateMatrixWorld(true);

          this._simplifiedMeshes.set(entity.index, simpleMesh);
        }
      }

      if (simpleMesh) {
        meshes.push(simpleMesh);
      }
    }

    // For simplified raycasting, create simple plane meshes for floors instead of complex geometry
    for (const surface of this.surfaces.values()) {
      if (!surface.mesh) continue;

      // Use cached simplified surface mesh if available
      const cacheKey = `surface_${surface.id}`;
      let simpleSurface = this._simplifiedMeshes.get(cacheKey);

      if (!simpleSurface) {
        const { width, depth } = surface.dimensions;
        const [cx, cy, cz] = surface.center;

        // Create a simple plane for raycasting (much faster than complex room mesh)
        const planeGeo = new PlaneGeometry(width, depth);
        planeGeo.rotateX(-Math.PI / 2);
        const planeMat = new MeshBasicMaterial({ visible: false });
        simpleSurface = new Mesh(planeGeo, planeMat);
        simpleSurface.position.set(cx, cy, cz);
        simpleSurface.updateMatrixWorld(true);

        this._simplifiedMeshes.set(cacheKey, simpleSurface);
      }

      meshes.push(simpleSurface);
    }

    return meshes;
  }

  update() {
    if (!this.showSurfaceLabels) return;

    for (const [surfaceId, panelData] of this.surfacePanels.entries()) {
      const surfaceData = this.surfaces.get(surfaceId);
      if (!surfaceData) continue;

      const panelObject = panelData.panelEntity.object3D;
      if (!panelObject) continue;

      panelObject.position.set(
        surfaceData.center[0],
        surfaceData.center[1] + 0.2,
        surfaceData.center[2]
      );

      this.player.head.getWorldPosition(this.vec3);
      panelObject.lookAt(this.vec3);
    }
  }
}
