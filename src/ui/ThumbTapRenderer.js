/**
 * ThumbTapRenderer.js - Animated thumbtap sprite for hand tracking UI
 *
 * Creates and manages an animated sprite mesh showing the thumbtap gesture.
 * Uses a 2x2 sprite sheet and cycles through frames every 500ms.
 */

import {
  PlaneGeometry,
  MeshBasicMaterial,
  Mesh,
  TextureLoader,
  DoubleSide,
} from "three";

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
  loader.load("./images/uv-scroll-thumbtap.png", (texture) => {
    sharedTexture = texture;
    textureCallbacks.forEach((cb) => cb(texture));
    textureCallbacks.length = 0;
  });
}

export class ThumbTapRenderer {
  constructor(options = {}) {
    this.size = options.size ?? 0.03;
    this.renderOrder = options.renderOrder ?? 9020;
    this.position = options.position ?? { x: 0, y: 0, z: 0.02 };
    this.frameInterval = options.frameInterval ?? 500;

    this.mesh = null;
    this._ready = false;
    this._currentFrame = 0;
    this._lastFrameTime = 0;

    // 2x2 grid UV coordinates (row 0 = top, row 1 = bottom)
    this._frames = [
      { u: 0, v: 0.5 }, // top-left
      { u: 0.5, v: 0.5 }, // top-right
      { u: 0, v: 0 }, // bottom-left
      { u: 0.5, v: 0 }, // bottom-right
    ];
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

    if (!parent) return;

    loadSharedTexture((texture) => {
      if (this.mesh) return;

      const geometry = new PlaneGeometry(this.size, this.size);
      const uvs = geometry.attributes.uv;
      this._setUVsForFrame(uvs, 0);

      const material = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: DoubleSide,
      });

      this.mesh = new Mesh(geometry, material);
      this.mesh.position.set(this.position.x, this.position.y, this.position.z);
      this.mesh.renderOrder = this.renderOrder;
      this.mesh.visible = false;
      this.mesh.name = "thumbtap-sprite";

      parent.add(this.mesh);
      this._ready = true;
      this._lastFrameTime = performance.now();
    });
  }

  _setUVsForFrame(uvAttr, frameIndex) {
    const frame = this._frames[frameIndex];
    const cellSize = 0.5;

    // PlaneGeometry UV layout - flip V to correct upside-down image
    uvAttr.setXY(0, frame.u, frame.v + cellSize);
    uvAttr.setXY(1, frame.u + cellSize, frame.v + cellSize);
    uvAttr.setXY(2, frame.u, frame.v);
    uvAttr.setXY(3, frame.u + cellSize, frame.v);
    uvAttr.needsUpdate = true;
  }

  update() {
    if (!this.mesh || !this.mesh.visible) return;

    const now = performance.now();
    if (now - this._lastFrameTime >= this.frameInterval) {
      this._currentFrame = (this._currentFrame + 1) % this._frames.length;
      this._setUVsForFrame(
        this.mesh.geometry.attributes.uv,
        this._currentFrame
      );
      this._lastFrameTime = now;
    }
  }

  show() {
    if (this.mesh) {
      this.mesh.visible = true;
      this._lastFrameTime = performance.now();
    }
  }

  hide() {
    if (this.mesh) {
      this.mesh.visible = false;
    }
  }

  setVisible(visible) {
    if (visible) {
      this.show();
    } else {
      this.hide();
    }
  }

  dispose() {
    if (!this.mesh) return;

    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.mesh.geometry?.dispose();
    this.mesh.material?.dispose();
    this.mesh = null;
    this._ready = false;
  }
}
