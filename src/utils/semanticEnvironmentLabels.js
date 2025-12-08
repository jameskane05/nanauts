/**
 * SemanticEnvironmentLabels.js - XR MESH SEMANTIC LABEL VISUALIZATION
 * =============================================================================
 *
 * ROLE: ECS system for debugging Quest scene understanding. Displays floating
 * labels and wireframe visualizations for detected meshes with semantic labels
 * (table, lamp, etc.).
 *
 * KEY RESPONSIBILITIES:
 * - Subscribe to XRMesh events filtered by semantic label
 * - Create 3D panel labels above detected objects
 * - Generate wireframe debug visualizations of mesh bounds
 * - Toggle visibility for debugging purposes
 *
 * FILTERED LABELS:
 * Only visualizes "table" and "lamp" meshes by default.
 * Other semantic labels (floor, wall, etc.) are ignored.
 *
 * DEBUG FEATURES:
 * - showLabels: Toggle 3D label panels
 * - showDebugMeshes: Toggle wireframe visualizations
 *
 * USAGE: Enabled via URL parameter ?semanticLabels=true in index.js
 * =============================================================================
 */

import {
  createSystem,
  PanelUI,
  PanelDocument,
  XRMesh,
  Vector3,
  eq,
  Mesh,
  BoxGeometry,
  MeshBasicMaterial,
} from "@iwsdk/core";
import { WireframeGeometry, LineSegments } from "three";
import { Logger } from "./Logger.js";

export class SemanticLabelsSystem extends createSystem({
  detectedMeshes: { required: [XRMesh] },
  meshLabelPanels: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/mesh-label.json")],
  },
}) {
  init() {
    this.showLabels = true;
    this.showDebugMeshes = true;

    this.meshPanels = new Map();
    this.pendingPanels = new Map();
    this.meshVisualizations = new Map();
    this.vec3 = new Vector3();
    this.offset = new Vector3(0, 0.5, 0);
    this.logger = new Logger("SemanticLabelsSystem", false);

    this.queries.detectedMeshes.subscribe("qualify", (entity) => {
      const semanticLabel = XRMesh.data.semanticLabel?.[entity.index] || "";
      const labelLower = semanticLabel.toLowerCase();
      if (labelLower === "table" || labelLower === "lamp") {
        if (this.showLabels) {
          this.assignLabelToMesh(entity);
        }
        if (this.showDebugMeshes) {
          this.visualizeMesh(entity);
        }
      }
    });

    this.queries.detectedMeshes.subscribe("disqualify", (entity) => {
      if (this.showLabels) {
        this.removeLabelFromMesh(entity);
      }
      if (this.showDebugMeshes) {
        this.removeMeshVisualization(entity);
      }
    });

    this.queries.meshLabelPanels.subscribe("qualify", (panelEntity) => {
      const pending = this.pendingPanels.get(panelEntity.index);
      if (pending) {
        const document = PanelDocument.data.document?.[panelEntity.index];
        if (document) {
          const textElement = document.getElementById("mesh-label-text");
          if (textElement) {
            textElement.setProperties({ text: pending.label });
            this.meshPanels.set(pending.meshEntity, {
              panelEntity,
              textElement,
              mesh: pending.meshData,
              label: pending.label,
            });
            this.pendingPanels.delete(panelEntity.index);
          }
        }
      }
    });
  }

  assignLabelToMesh(meshEntity) {
    if (this.meshPanels.has(meshEntity)) return;

    const semanticLabel = XRMesh.data.semanticLabel?.[meshEntity.index] || "";
    const isBounded3D = XRMesh.data.isBounded3D?.[meshEntity.index] || false;
    const dimensions = XRMesh.data.dimensions?.[meshEntity.index];
    const min = XRMesh.data.min?.[meshEntity.index];
    const max = XRMesh.data.max?.[meshEntity.index];

    const meshData = {
      semanticLabel,
      isBounded3D,
      dimensions,
      min,
      max,
    };

    const label = this.getMeshLabel(meshData);

    const panelEntity = this.world.createTransformEntity();

    this.pendingPanels = this.pendingPanels || new Map();
    this.pendingPanels.set(panelEntity.index, { meshEntity, label, meshData });

    panelEntity.addComponent(PanelUI, { config: "./ui/mesh-label.json" });
  }

  visualizeMesh(meshEntity) {
    const semanticLabel = XRMesh.data.semanticLabel?.[meshEntity.index] || "";
    const labelLower = semanticLabel.toLowerCase();
    if (labelLower !== "table" && labelLower !== "lamp") return;

    const isBounded3D = XRMesh.data.isBounded3D?.[meshEntity.index] || false;
    if (!isBounded3D) return;

    const meshObject = meshEntity.object3D;
    if (!meshObject) {
      this.logger.warn("Mesh entity has no object3D");
      return;
    }

    meshObject.visible = true;

    const visualizations = [];
    let meshCount = 0;

    meshObject.traverse((child) => {
      if (child.isMesh && child.geometry) {
        meshCount++;
        child.visible = true;
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((mat) => {
              mat.transparent = true;
              mat.opacity = 0.2;
            });
          } else {
            child.material.transparent = true;
            child.material.opacity = 0.2;
          }
        }

        const wireframe = new LineSegments(
          new WireframeGeometry(child.geometry),
          new MeshBasicMaterial({
            color: 0x3b82f6,
            transparent: true,
            opacity: 0.9,
          })
        );
        child.add(wireframe);
        visualizations.push(wireframe);
      }
    });

    this.logger.log(`Visualizing bounded mesh: ${meshCount} mesh(es) found`);

    const dimensions = XRMesh.data.dimensions?.[meshEntity.index];

    if (dimensions) {
      const width = dimensions.x || dimensions.X || 1;
      const height = dimensions.y || dimensions.Y || 1;
      const depth = dimensions.z || dimensions.Z || 1;

      if (width > 0 && height > 0 && depth > 0) {
        const boxGeometry = new BoxGeometry(width, height, depth);
        const boxMaterial = new MeshBasicMaterial({
          color: 0x00ff00,
          transparent: true,
          opacity: 0.4,
          wireframe: true,
        });
        const boundingBox = new Mesh(boxGeometry, boxMaterial);

        boundingBox.position.set(0, 0, 0);
        meshObject.add(boundingBox);
        visualizations.push(boundingBox);

        this.logger.log(
          `Added bounding box: ${width.toFixed(2)}×${height.toFixed(
            2
          )}×${depth.toFixed(2)}`
        );
      }
    }

    if (visualizations.length > 0) {
      this.meshVisualizations.set(meshEntity, visualizations);
    } else {
      this.logger.warn("No visualizations created for bounded mesh");
    }
  }

  removeMeshVisualization(meshEntity) {
    const visualization = this.meshVisualizations.get(meshEntity);
    if (visualization) {
      const meshObject = meshEntity.object3D;
      if (meshObject) {
        if (Array.isArray(visualization)) {
          visualization.forEach((viz) => {
            if (viz.parent) viz.parent.remove(viz);
            if (viz.geometry) viz.geometry.dispose();
            if (viz.material) viz.material.dispose();
          });
        } else {
          if (visualization.parent) visualization.parent.remove(visualization);
          if (visualization.geometry) visualization.geometry.dispose();
          if (visualization.material) visualization.material.dispose();
        }
      }
      this.meshVisualizations.delete(meshEntity);
    }
  }

  removeLabelFromMesh(meshEntity) {
    const panelData = this.meshPanels.get(meshEntity);
    if (panelData) {
      const panelObject = panelData.panelEntity.object3D;
      if (panelObject) {
        panelObject.visible = false;
      }
      panelData.panelEntity.destroy();
      this.meshPanels.delete(meshEntity);
    }
    this.removeMeshVisualization(meshEntity);
  }

  getMeshLabel(mesh) {
    const parts = [];

    const semanticLabel = mesh.semanticLabel || mesh.semanticlabel;
    if (semanticLabel && semanticLabel.trim()) {
      parts.push(semanticLabel);
    } else {
      parts.push("Mesh");
    }

    const isBounded = mesh.isBounded3D || mesh.isbounded3d;
    if (isBounded) {
      parts.push("[Bounded]");
    }

    const dimensions = mesh.dimensions || mesh.Dimensions;
    if (dimensions) {
      const x = dimensions.x || dimensions.X || 0;
      const y = dimensions.y || dimensions.Y || 0;
      const z = dimensions.z || dimensions.Z || 0;
      if (x > 0 || y > 0 || z > 0) {
        parts.push(`${x.toFixed(1)}×${y.toFixed(1)}×${z.toFixed(1)}m`);
      }
    }

    const min = mesh.min || mesh.Min;
    const max = mesh.max || mesh.Max;
    if (min && max) {
      const minX = min.x || min.X || 0;
      const minY = min.y || min.Y || 0;
      const minZ = min.z || min.Z || 0;
      const maxX = max.x || max.X || 0;
      const maxY = max.y || max.Y || 0;
      const maxZ = max.z || max.Z || 0;
      const center = {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        z: (minZ + maxZ) / 2,
      };
      parts.push(
        `@(${center.x.toFixed(1)},${center.y.toFixed(1)},${center.z.toFixed(
          1
        )})`
      );
    }

    return parts.join(" ");
  }

  update() {
    window.systemTiming?.start("SemanticLabels");
    if (!this.showLabels) {
      window.systemTiming?.end("SemanticLabels");
      return;
    }

    for (const [meshEntity, panelData] of this.meshPanels.entries()) {
      const meshObject = meshEntity.object3D;
      const panelObject = panelData.panelEntity.object3D;

      if (!meshObject || !panelObject) {
        continue;
      }

      panelObject.visible = true;
      meshObject.getWorldPosition(this.vec3);

      if (panelData.mesh.dimensions) {
        const dims = panelData.mesh.dimensions;
        const height = dims.y || dims.Y || 0.5;
        this.offset.y = height / 2 + 0.3;
      } else {
        this.offset.y = 0.5;
      }

      panelObject.position.copy(this.vec3).add(this.offset);
      panelObject.lookAt(this.player.head.position);
    }
    window.systemTiming?.end("SemanticLabels");
  }
}
