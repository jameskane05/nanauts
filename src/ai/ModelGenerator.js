/**
 * ModelGenerator.js - 3D MODEL GENERATION AND SPAWNING
 * =============================================================================
 *
 * ROLE: Triggers 3D model generation via the Trellis API, loads the resulting
 * GLB file, and spawns it in the scene at the tracked object's location.
 * Shows progress indicator during generation.
 *
 * KEY RESPONSIBILITIES:
 * - Capture current camera frame for 3D generation input
 * - Call apiClient.generate3DModel() with image + object label
 * - Load returned GLB file using GLTFLoader
 * - Scale model to fit within the tracked object's wireframe bounds
 * - Position model at tracked object's world location
 * - Show/update/hide progress indicator during generation
 *
 * GENERATION FLOW:
 * 1. User clicks label -> AIManager calls generate3DModel()
 * 2. Show "GENERATING..." progress indicator at object position
 * 3. Capture camera frame, send to /generate3d endpoint
 * 4. Receive GLB base64, decode to Uint8Array
 * 5. Load via GLTFLoader, scale to fit wireframe bounds
 * 6. Spawn in scene, hide progress indicator
 *
 * PROGRESS INDICATOR: Yellow floating label showing generation status and time.
 * Fades out over 4 seconds after completion using frame-based animation.
 *
 * USAGE: Instantiated by AIManager, called when user clicks detection label
 * =============================================================================
 */

import {
  Vector3,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  SRGBColorSpace,
  CanvasTexture,
  LinearFilter,
} from "@iwsdk/core";
import { MeshBasicMaterial as ThreeMeshBasicMaterial } from "three";
import { CameraSource } from "@iwsdk/core";
import { Logger } from "../utils/Logger.js";

export class ModelGenerator {
  constructor(world, player, apiClient) {
    this.world = world;
    this.player = player;
    this.apiClient = apiClient;
    this.generating3D = false;
    this.generationStartTime = null;
    this.progressIndicator = null;
    this.spawned3DModels = new Map();
    this.logger = new Logger("ModelGenerator", false);
  }

  async generate3DModel(
    objectId,
    label,
    cameraEntity,
    trackedObject,
    wireframeBox,
    isVideoMode = false
  ) {
    if (this.generating3D) {
      this.logger.warn(`3D generation already in progress, skipping`);
      return;
    }

    this.generating3D = true;
    this.generationStartTime = Date.now();
    this.logger.log(`Starting 3D generation for ${label} (${objectId})...`);

    if (trackedObject) {
      this.showProgressIndicator(trackedObject.fusedPosition, label);
    }

    try {
      if (!cameraEntity) {
        throw new Error("Camera entity not available");
      }

      const videoElement = CameraSource.data.videoElement?.[cameraEntity.index];
      if (!videoElement || videoElement.readyState !== 4) {
        throw new Error("Camera video element not ready");
      }

      const canvas = document.createElement("canvas");
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(videoElement, 0, 0);
      const imageData = canvas.toDataURL("image/jpeg", 0.95);

      const base64Data = imageData.split(",")[1];

      const result = await this.apiClient.generate3DModel(base64Data, label);

      if (result.glb_file) {
        const glbBase64 = result.glb_file;
        const glbBytes = Uint8Array.from(atob(glbBase64), (c) =>
          c.charCodeAt(0)
        );

        await this.loadAndSpawnGLB(
          glbBytes,
          objectId,
          label,
          trackedObject,
          wireframeBox,
          isVideoMode
        );
      } else {
        throw new Error(
          `No 3D file found in response. Format: ${
            result.format
          }, has glb: ${!!result.glb_file}`
        );
      }

      this.logger.log(`3D model spawned for ${label} (${objectId})`);

      this.hideProgressIndicator();
    } catch (error) {
      this.logger.error(`Error generating 3D model for ${label}:`, error);
      this.updateProgressIndicator("Error: " + error.message, true);
      setTimeout(() => {
        this.hideProgressIndicator();
      }, 3000);
    } finally {
      this.generating3D = false;
      this.generationStartTime = null;
    }
  }

  async loadAndSpawnGLB(
    glbBytes,
    objectId,
    label,
    trackedObject,
    wireframeBox,
    isVideoMode
  ) {
    const { GLTFLoader } = await import(
      "three/examples/jsm/loaders/GLTFLoader.js"
    );

    const loader = new GLTFLoader();
    const blob = new Blob([glbBytes], { type: "model/gltf-binary" });
    const url = URL.createObjectURL(blob);

    const gltf = await new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => resolve(gltf),
        undefined,
        (error) => reject(error)
      );
    });

    URL.revokeObjectURL(url);

    const modelScene = gltf.scene;
    if (!modelScene) {
      throw new Error("No scene in GLB file");
    }

    if (!trackedObject) {
      throw new Error(`Tracked object ${objectId} not found`);
    }

    if (!wireframeBox) {
      throw new Error(`Wireframe box for ${objectId} not found`);
    }

    const boxPosition = wireframeBox.position.clone();
    const boxScale = wireframeBox.scale;

    const wireframeGeometry = wireframeBox.geometry;
    if (!wireframeGeometry || !wireframeGeometry.boundingBox) {
      wireframeGeometry.computeBoundingBox();
    }
    const wireframeBBox = wireframeGeometry.boundingBox;
    const boxWidth = (wireframeBBox.max.x - wireframeBBox.min.x) * boxScale.x;
    const boxHeight = (wireframeBBox.max.y - wireframeBBox.min.y) * boxScale.y;
    const boxDepth = (wireframeBBox.max.z - wireframeBBox.min.z) * boxScale.z;

    let hasMeshes = false;
    modelScene.traverse((child) => {
      if (child.isMesh) {
        hasMeshes = true;
        child.visible = true;
        child.castShadow = true;
        child.receiveShadow = true;
        if (!child.material) {
          child.material = new ThreeMeshBasicMaterial({ color: 0xffffff });
        }
        if (child.geometry) {
          child.geometry.computeBoundingBox();
          child.geometry.computeBoundingSphere();
        }
      }
    });

    if (!hasMeshes) {
      throw new Error("No meshes found in GLB file");
    }

    modelScene.computeBoundingBox();
    const modelBBox = modelScene.boundingBox;
    const modelWidth = modelBBox.max.x - modelBBox.min.x;
    const modelHeight = modelBBox.max.y - modelBBox.min.y;
    const modelDepth = modelBBox.max.z - modelBBox.min.z;

    const scaleX = boxWidth / modelWidth;
    const scaleY = boxHeight / modelHeight;
    const scaleZ = boxDepth / modelDepth;
    const scale = Math.min(scaleX, scaleY, scaleZ) * 0.9;

    modelScene.scale.set(scale, scale, scale);

    const modelCenter = new Vector3();
    modelBBox.getCenter(modelCenter);
    modelScene.position.copy(boxPosition);
    modelScene.position.sub(modelCenter.multiplyScalar(scale));

    const modelEntity = this.world.createTransformEntity(modelScene);
    if (!modelEntity) {
      throw new Error("Failed to create model entity");
    }

    this.spawned3DModels.set(objectId, modelEntity);

    this.logger.log(
      `3D model loaded and positioned for ${label} (${objectId})`
    );
  }

  showProgressIndicator(position, label) {
    this.hideProgressIndicator();

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#ffff00";
    ctx.font = "bold 48px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `GENERATING ${label.toUpperCase()}`,
      canvas.width / 2,
      canvas.height / 2 - 15
    );

    ctx.fillStyle = "#ffffff";
    ctx.font = "32px Arial";
    ctx.fillText("0.0s", canvas.width / 2, canvas.height / 2 + 20);

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;

    const geometry = new PlaneGeometry(1.0, 0.3);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.95,
      side: 2,
      depthWrite: false,
    });

    const progressMesh = new Mesh(geometry, material);
    progressMesh.position.copy(position);
    progressMesh.position.add(new Vector3(0, 0.75, 0));

    const headPos = this.player?.head?.position;
    if (headPos) {
      progressMesh.lookAt(headPos.x, headPos.y, headPos.z);
    }

    const progressEntity = this.world.createTransformEntity(progressMesh);
    if (progressEntity) {
      this.progressIndicator = progressEntity;
    }
  }

  updateProgressIndicator(text, isError = false) {
    if (!this.progressIndicator) return;

    const progressMesh = this.progressIndicator.object3D;
    if (!progressMesh) return;

    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = isError ? "rgba(100, 0, 0, 0.9)" : "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = isError ? "#ff0000" : "#ffff00";
    ctx.font = "bold 36px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const lines = text.split("\n");
    const lineHeight = 40;
    const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;

    lines.forEach((line, i) => {
      ctx.fillText(line, canvas.width / 2, startY + i * lineHeight);
    });

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;

    progressMesh.material.map = texture;
    progressMesh.material.needsUpdate = true;
  }

  hideProgressIndicator() {
    if (this.progressIndicator) {
      const progressMesh = this.progressIndicator.object3D;
      if (progressMesh && progressMesh.material) {
        // Queue for frame-based fade instead of using setTimeout
        if (!this._fadingIndicators) {
          this._fadingIndicators = [];
        }
        this._fadingIndicators.push({
          mesh: progressMesh,
          startOpacity: progressMesh.material.opacity,
          startTime: Date.now(),
          fadeDuration: 4000,
        });
        this.progressIndicator = null;
      } else {
        if (progressMesh && progressMesh.parent) {
          progressMesh.parent.remove(progressMesh);
        } else if (progressMesh) {
          this.world.scene.remove(progressMesh);
        }
        this.progressIndicator = null;
      }
    }
  }

  /**
   * Update method - call from AIManager each XR frame to process fading indicators
   */
  update() {
    if (!this._fadingIndicators || this._fadingIndicators.length === 0) return;

    for (let i = this._fadingIndicators.length - 1; i >= 0; i--) {
      const fade = this._fadingIndicators[i];
      const elapsed = Date.now() - fade.startTime;
      const progress = Math.min(elapsed / fade.fadeDuration, 1);
      const newOpacity = fade.startOpacity * (1 - progress);

      if (fade.mesh.material) {
        fade.mesh.material.opacity = newOpacity;
      }

      if (progress >= 1) {
        // Fade complete - remove mesh
        if (fade.mesh.parent) {
          fade.mesh.parent.remove(fade.mesh);
        } else {
          this.world.scene.remove(fade.mesh);
        }
        this._fadingIndicators.splice(i, 1);
      }
    }
  }

  getSpawnedModel(objectId) {
    return this.spawned3DModels.get(objectId);
  }
}
