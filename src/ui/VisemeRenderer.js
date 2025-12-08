/**
 * VisemeRenderer.js - Viseme/Phoneme mesh rendering
 *
 * Creates and manages a hologram-styled viseme mesh that can be attached
 * to any parent Object3D. Each panel that needs a viseme creates its own
 * instance - no sharing or reparenting needed.
 */

import {
  PlaneGeometry,
  ShaderMaterial,
  Mesh,
  TextureLoader,
  DoubleSide,
  Vector3,
  Vector2,
} from "three";
import {
  hologramVertexShader,
  hologramFragmentShader,
} from "../vfx/shaders/hologramShader.glsl.js";

// Shared texture cache - loaded once, used by all instances
let sharedTexture = null;
let textureLoading = false;
const textureCallbacks = [];

function loadSharedTexture(callback) {
  if (sharedTexture) {
    callback(sharedTexture);
    return;
  }

  textureCallbacks.push(callback);

  if (textureLoading) return;
  textureLoading = true;

  const loader = new TextureLoader();
  loader.load("./textures/viseme.png", (texture) => {
    sharedTexture = texture;
    textureCallbacks.forEach((cb) => cb(texture));
    textureCallbacks.length = 0;
  });
}

export class VisemeRenderer {
  constructor(options = {}) {
    this.size = options.size ?? 0.12;
    this.renderOrder = options.renderOrder ?? 9010; // Above panels (9000)
    this.position = options.position ?? { x: 0, y: 0, z: 0.01 };

    this.mesh = null;
    this.uniforms = null;
    this._ready = false;
  }

  get ready() {
    return this._ready;
  }

  create(parent) {
    if (this.mesh) {
      this.mesh.visible = true;
      // Re-parent if needed (e.g., after XR session restart)
      if (parent && this.mesh.parent !== parent) {
        parent.add(this.mesh);
      }
      return;
    }

    loadSharedTexture((texture) => {
      if (this.mesh) return; // Already created while waiting

      const margin = 0.02;
      const cellSize = 1 / 4;
      const displaySize = cellSize * (1 - margin * 2);

      this.uniforms = {
        uTexture: { value: texture },
        uTime: { value: 0.0 },
        uHoloColor: { value: new Vector3(0.0, 0.85, 0.95) },
        uScanLineIntensity: { value: 0.4 },
        uAlpha: { value: this._pendingAlpha ?? 1.0 },
        uUvOffset: {
          value: new Vector2(cellSize * margin, 3 / 4 + cellSize * margin),
        },
        uUvRepeat: { value: new Vector2(displaySize, displaySize) },
      };

      const material = new ShaderMaterial({
        vertexShader: hologramVertexShader,
        fragmentShader: hologramFragmentShader,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false, // Always render on top
        side: DoubleSide,
      });

      const geometry = new PlaneGeometry(this.size, this.size);
      this.mesh = new Mesh(geometry, material);
      this.mesh.position.set(this.position.x, this.position.y, this.position.z);
      this.mesh.renderOrder = this.renderOrder;

      if (parent) {
        parent.add(this.mesh);
      }

      this._ready = true;
    });
  }

  show() {
    if (this.mesh) {
      this.mesh.visible = true;
    }
  }

  hide() {
    if (this.mesh) {
      this.mesh.visible = false;
    }
  }

  setVisible(visible) {
    if (this.mesh) {
      this.mesh.visible = visible;
    }
  }

  updateFrame(uv) {
    if (!this.uniforms) return;
    this.uniforms.uUvOffset.value.set(uv.u, uv.v);
    this.uniforms.uUvRepeat.value.set(uv.uSize, uv.vSize);
  }

  updateTime(deltaTime) {
    if (!this.uniforms) return;
    this.uniforms.uTime.value += deltaTime;
  }

  setAlpha(alpha) {
    // Store pending alpha for when mesh is created
    this._pendingAlpha = alpha;
    if (!this.uniforms) return;
    this.uniforms.uAlpha.value = alpha;
  }

  dispose() {
    if (!this.mesh) return;

    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.mesh.geometry?.dispose();
    this.mesh.material?.dispose();
    this.mesh = null;
    this.uniforms = null;
    this._ready = false;
  }
}
