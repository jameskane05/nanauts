import * as THREE from "three";
import { Logger } from "../utils/Logger.js";
import { HorizontalBlurShader } from "three/examples/jsm/shaders/HorizontalBlurShader.js";
import { VerticalBlurShader } from "three/examples/jsm/shaders/VerticalBlurShader.js";

const logger = new Logger("ContactShadow", false);

// Toggle this to switch between debug red plane and actual shadow rendering
const DEBUG_MODE = true;
const DEBUG_CAPTURE_KEY = "p";
const SHADOW_LAYER = 9;

/**
 * ContactShadowVFX - Scene-based contact shadows matching Three.js example
 * Shadow group is added to SCENE and positioned each frame under target
 */
export class ContactShadowVFX {
  constructor(renderer, scene, target, config = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.target = target;

    const {
      size = { x: 0.5, y: 0.5 },
      offset = { x: 0, y: -1.05, z: 0 },
      blur = 3.5,
      darkness = 1.5,
      opacity = 0.5,
      renderTargetSize = 256,
      cameraHeight = 2.0,
    } = config;

    this.config = { size, offset, blur, darkness, opacity, cameraHeight };

    // Shadow group - added to SCENE (not parented to target)
    this.shadowGroup = new THREE.Group();
    this.shadowGroup.name = "contactShadow";
    scene.add(this.shadowGroup);

    // Reusable vector for positioning
    this.targetWorldPos = new THREE.Vector3();
    this.debugCaptureRequested = false;

    // Render targets
    this.renderTarget = new THREE.WebGLRenderTarget(
      renderTargetSize,
      renderTargetSize
    );
    this.renderTarget.texture.generateMipmaps = false;

    this.renderTargetBlur = new THREE.WebGLRenderTarget(
      renderTargetSize,
      renderTargetSize
    );
    this.renderTargetBlur.texture.generateMipmaps = false;

    // Plane geometry - faces up
    const planeGeometry = new THREE.PlaneGeometry(size.x, size.y).rotateX(
      Math.PI / 2
    );

    // Debug material (red)
    this.debugMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      opacity: 1.0,
      transparent: false,
      depthWrite: false,
    });

    // Shadow material (uses render target texture)
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      map: this.renderTarget.texture,
      opacity: opacity,
      transparent: true,
      depthWrite: false,
    });

    this.plane = new THREE.Mesh(
      planeGeometry,
      DEBUG_MODE ? this.debugMaterial : this.shadowMaterial
    );
    this.plane.renderOrder = 1;
    this.plane.scale.y = -1;
    this.shadowGroup.add(this.plane);

    // Blur plane
    this.blurPlane = new THREE.Mesh(planeGeometry.clone());
    this.blurPlane.visible = false;
    this.shadowGroup.add(this.blurPlane);

    // Orthographic camera looking UP
    this.shadowCamera = new THREE.OrthographicCamera(
      -size.x / 2,
      size.x / 2,
      size.y / 2,
      -size.y / 2,
      0,
      cameraHeight
    );
    this.shadowCamera.rotation.x = Math.PI / 2;
    this.shadowCamera.layers.set(SHADOW_LAYER);
    this.shadowGroup.add(this.shadowCamera);
    if (DEBUG_MODE) {
      this.cameraHelper = new THREE.CameraHelper(this.shadowCamera);
      this.scene.add(this.cameraHelper);
    }

    // Depth material - custom shader to output black with alpha
    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        varying float vViewZ;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewZ = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vViewZ;
        uniform float cameraHeight;
        uniform float darkness;
        void main() {
          float normalizedDepth = clamp(vViewZ / cameraHeight, 0.0, 1.0);
          float alpha = (1.0 - normalizedDepth) * darkness;
          gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
        }
      `,
      uniforms: {
        cameraHeight: { value: cameraHeight },
        darkness: { value: darkness },
      },
      depthTest: false,
      depthWrite: false,
    });

    // Blur materials
    this.horizontalBlurMaterial = new THREE.ShaderMaterial(
      HorizontalBlurShader
    );
    this.horizontalBlurMaterial.depthTest = false;

    this.verticalBlurMaterial = new THREE.ShaderMaterial(VerticalBlurShader);
    this.verticalBlurMaterial.depthTest = false;

    this.enabled = true;
    this.frameCounter = 0;
    this.updateFrequency = 2;

    ContactShadowVFX._registerKeyListener();
    ContactShadowVFX._instances.add(this);

    this._enableShadowLayerOnTarget();

    logger.log(
      `ContactShadow created for ${
        target.name || "object"
      } (DEBUG_MODE: ${DEBUG_MODE})`
    );
  }

  _enableShadowLayerOnTarget() {
    if (!this.target) return;
    this.target.traverse((child) => {
      child.layers.enable(SHADOW_LAYER);
    });
  }

  blurShadow(amount) {
    this.blurPlane.visible = true;

    // Horizontal blur
    this.blurPlane.material = this.horizontalBlurMaterial;
    this.blurPlane.material.uniforms.tDiffuse.value = this.renderTarget.texture;
    this.horizontalBlurMaterial.uniforms.h.value = (amount * 1) / 256;

    this.renderer.setRenderTarget(this.renderTargetBlur);
    this.renderer.render(this.blurPlane, this.shadowCamera);

    // Vertical blur
    this.blurPlane.material = this.verticalBlurMaterial;
    this.blurPlane.material.uniforms.tDiffuse.value =
      this.renderTargetBlur.texture;
    this.verticalBlurMaterial.uniforms.v.value = (amount * 1) / 256;

    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.blurPlane, this.shadowCamera);

    this.blurPlane.visible = false;
  }

  render() {
    if (!this.enabled || !this.target) {
      this.plane.visible = false;
      return;
    }

    // Position shadow group under target each frame
    this.target.getWorldPosition(this.targetWorldPos);
    this.shadowGroup.position.set(
      this.targetWorldPos.x + this.config.offset.x,
      this.targetWorldPos.y + this.config.offset.y,
      this.targetWorldPos.z + this.config.offset.z
    );

    // Debug mode - just show the plane (camera helper still visible)
    if (DEBUG_MODE) {
      this.plane.visible = true;
      if (this.cameraHelper) {
        this.cameraHelper.visible = true;
        this.cameraHelper.update();
      }
      return;
    }

    this.frameCounter++;
    if (this.frameCounter % this.updateFrequency !== 0) {
      return;
    }

    // Save state
    const initialBackground = this.scene.background;
    const initialOverride = this.scene.overrideMaterial;
    const initialClearAlpha = this.renderer.getClearAlpha();

    // Hide plane (and helper) during depth render
    this.plane.visible = false;
    if (this.cameraHelper) {
      this.cameraHelper.visible = false;
    }

    // Setup for depth render
    this.scene.background = null;
    this.scene.overrideMaterial = this.depthMaterial;
    this.renderer.setClearAlpha(0);

    // Render depth to render target
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.scene, this.shadowCamera);

    if (this.debugCaptureRequested) {
      this.captureShadowTexture();
      this.debugCaptureRequested = false;
    }

    // Reset override material
    this.scene.overrideMaterial = initialOverride;

    // Blur passes
    this.blurShadow(this.config.blur);
    this.blurShadow(this.config.blur * 0.4);

    // Restore state
    this.renderer.setRenderTarget(null);
    this.renderer.setClearAlpha(initialClearAlpha);
    this.scene.background = initialBackground;

    this.plane.visible = true;
    if (this.cameraHelper) {
      this.cameraHelper.visible = true;
      this.cameraHelper.update();
    }
  }

  setOpacity(opacity) {
    this.config.opacity = opacity;
    this.shadowMaterial.opacity = opacity;
  }

  captureShadowTexture() {
    const size = this.renderTarget.width;
    const buffer = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(
      this.renderTarget,
      0,
      0,
      size,
      size,
      buffer
    );

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(size, size);
    imageData.data.set(buffer);
    ctx.putImageData(imageData, 0, 0);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `contact-shadow-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  dispose() {
    if (this.shadowGroup.parent) {
      this.shadowGroup.parent.remove(this.shadowGroup);
    }
    ContactShadowVFX._instances.delete(this);
    this.renderTarget.dispose();
    this.renderTargetBlur.dispose();
    this.plane.geometry.dispose();
    this.debugMaterial.dispose();
    this.shadowMaterial.dispose();
    this.blurPlane.geometry.dispose();
    this.depthMaterial.dispose();
    this.horizontalBlurMaterial.dispose();
    this.verticalBlurMaterial.dispose();
    if (this.cameraHelper) {
      this.scene.remove(this.cameraHelper);
      this.cameraHelper.geometry.dispose();
      this.cameraHelper.material.dispose();
    }
  }
}

ContactShadowVFX._instances = new Set();
ContactShadowVFX._keyListenerRegistered = false;
ContactShadowVFX._registerKeyListener = function () {
  if (ContactShadowVFX._keyListenerRegistered) return;
  if (typeof window === "undefined") return;
  window.addEventListener("keydown", (event) => {
    if (event.key === DEBUG_CAPTURE_KEY) {
      ContactShadowVFX._instances.forEach((instance) => {
        instance.debugCaptureRequested = true;
      });
      logger.log(
        `ContactShadow debug capture requested for ${ContactShadowVFX._instances.size} instance(s)`
      );
    }
  });
  ContactShadowVFX._keyListenerRegistered = true;
};
