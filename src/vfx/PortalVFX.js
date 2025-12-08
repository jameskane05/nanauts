/**
 * PortalVFX - Tech/holographic portal tube effect with shader and particles
 *
 * Creates a futuristic portal tube with:
 * - 3D cylinder that bevels outward at top
 * - Custom shader for scan lines, grid, and energy effects
 * - Swirling particle system around the portal edge
 * - Proper occlusion - robots visible inside tube, hidden outside
 */

import {
  Group,
  Mesh,
  PlaneGeometry,
  CylinderGeometry,
  ShaderMaterial,
  MeshBasicMaterial,
  DoubleSide,
  BackSide,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  TextureLoader,
  Color,
  AdditiveBlending,
} from "three";

import {
  portalVertexShader,
  portalFragmentShader,
} from "./shaders/portalShader.glsl.js";
import { Logger } from "../utils/Logger.js";

export class PortalVFX {
  constructor(options = {}) {
    this.logger = new Logger("PortalVFX", false);

    // Configuration
    this.config = {
      maxRadius: options.maxRadius || 0.3,
      tubeDepth: options.tubeDepth || 0.4,
      bevelAmount: options.bevelAmount || 1.3, // Top radius multiplier
      primaryColor: new Color(options.primaryColor || 0x00ffff),
      secondaryColor: new Color(options.secondaryColor || 0x0088ff),
      glowIntensity: options.glowIntensity || 1.2,
      scanLineSpeed: options.scanLineSpeed || 2.0,
      particleCount: options.particleCount || 40,
      particleSpeed: options.particleSpeed || 1.5,
      particleSize: options.particleSize || 0.015,
    };

    // State
    this.progress = 0;
    this.isActive = false;
    this.time = 0;

    // Three.js objects
    this.group = new Group();
    this.floorOccluder = null;
    this.portalBottom = null;
    this.tubeInner = null;
    this.tubeWalls = null;
    this.tubeMask = null;
    this.particleSystem = null;
    this.glowRing = null;

    // Particle animation state
    this.particleAngles = [];
    this.particleRadii = [];
    this.particleSpeeds = [];
    this.particleHeights = [];

    this._createFloorOccluder();
    this._createTube();
    this._createPortalBottom();
    this._createParticleSystem();
    this._createGlowRing();

    this.logger.log("PortalVFX created");
  }

  _createFloorOccluder() {
    // Floor-level plane with shader-based hole that blocks visibility of tube from side views
    // Shader approach avoids geometry recreation every frame
    const size = 4.0; // Large enough to cover surrounding area

    const geometry = new PlaneGeometry(size, size);

    const material = new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uHoleRadius;
        varying vec2 vUv;
        void main() {
          vec2 center = vec2(0.5, 0.5);
          float dist = length(vUv - center) * 4.0; // Scale to match geometry size
          if (dist < uHoleRadius) discard;
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
        }
      `,
      uniforms: {
        uHoleRadius: { value: 0.01 },
      },
    });
    // Set material properties after construction for ShaderMaterial
    material.colorWrite = false;
    material.depthWrite = true;

    this.floorOccluder = new Mesh(geometry, material);
    this.floorOccluder.rotation.x = -Math.PI / 2;
    this.floorOccluder.position.y = 0.001;
    this.floorOccluder.renderOrder = -900;

    this.group.add(this.floorOccluder);
  }

  _createTube() {
    // Two-layer approach for MR:
    // 1. Opaque black inner cylinder - blocks passthrough camera
    // 2. Transparent energy effect - glows on top without self-occlusion
    //
    // PERF: Create geometry at max size once, then use scale to animate opening.
    // This avoids expensive geometry disposal/creation every frame.

    const radiusTop = this.config.maxRadius * this.config.bevelAmount;
    const radiusBottom = this.config.maxRadius * 0.7;
    const height = this.config.tubeDepth;
    const segments = 24; // Reduced from 32

    // LAYER 1: Opaque black interior - blocks passthrough when looking DOWN into tube
    const innerGeometry = new CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      segments,
      1,
      true
    );

    const innerMaterial = new MeshBasicMaterial({
      color: 0x000308,
      side: BackSide,
      transparent: false,
      depthWrite: true,
    });

    this.tubeInner = new Mesh(innerGeometry, innerMaterial);
    this.tubeInner.position.y = -height / 2;
    this.tubeInner.scale.set(0.01, 1, 0.01); // Start tiny, will scale up
    this.tubeInner.renderOrder = -890;
    this.group.add(this.tubeInner);

    // LAYER 2: Energy effect on interior walls
    const wallGeometry = new CylinderGeometry(
      radiusTop * 0.99,
      radiusBottom * 0.99,
      height,
      segments,
      1,
      true
    );

    const wallMaterial = new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uProgress;
        uniform vec3 uPrimaryColor;
        uniform vec3 uSecondaryColor;
        varying vec2 vUv;

        void main() {
          float rings = sin((vUv.y * 25.0 - uTime * 2.0)) * 0.5 + 0.5;
          rings = smoothstep(0.35, 0.65, rings);

          float streaks = sin(vUv.x * 3.14159 * 10.0 + uTime * 0.3) * 0.5 + 0.5;
          streaks = smoothstep(0.7, 1.0, streaks) * 0.6;

          float pattern = rings * 0.8 + streaks * 0.4;
          vec3 energyColor = mix(uSecondaryColor, uPrimaryColor, vUv.y * 0.7 + pattern * 0.3);

          float bottomFade = smoothstep(0.0, 0.3, vUv.y);
          float topFade = smoothstep(1.0, 0.85, vUv.y);
          float rimGlow = smoothstep(0.8, 1.0, vUv.y) * 1.2;

          float alpha = pattern * 0.7 * bottomFade * topFade * uProgress;
          alpha += rimGlow * uProgress * 0.4;

          gl_FragColor = vec4(energyColor, alpha);
        }
      `,
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 0 },
        uPrimaryColor: { value: this.config.primaryColor },
        uSecondaryColor: { value: this.config.secondaryColor },
      },
      transparent: true,
      side: BackSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.tubeWalls = new Mesh(wallGeometry, wallMaterial);
    this.tubeWalls.position.y = -height / 2;
    this.tubeWalls.scale.set(0.01, 1, 0.01);
    this.tubeWalls.renderOrder = -880;
    this.group.add(this.tubeWalls);

    // Stencil mask for robot occlusion
    const maskGeometry = new CylinderGeometry(
      radiusTop * 1.02,
      radiusBottom * 1.02,
      height,
      segments,
      1,
      true
    );

    const maskMaterial = new MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      side: BackSide,
      stencilWrite: true,
      stencilRef: 1,
      stencilFunc: 519,
      stencilZPass: 7681,
    });

    this.tubeMask = new Mesh(maskGeometry, maskMaterial);
    this.tubeMask.position.y = -height / 2;
    this.tubeMask.scale.set(0.01, 1, 0.01);
    this.tubeMask.renderOrder = -895;
    this.group.add(this.tubeMask);
  }

  _updateTubeGeometry() {
    // PERF: Use scale instead of recreating geometry every frame
    const scale = Math.max(0.01, this.progress);

    if (this.tubeInner) {
      this.tubeInner.scale.set(scale, 1, scale);
    }
    if (this.tubeWalls) {
      this.tubeWalls.scale.set(scale, 1, scale);
    }
    if (this.tubeMask) {
      this.tubeMask.scale.set(scale, 1, scale);
    }
  }

  _createPortalBottom() {
    // The tech pattern - at floor level inside the tube opening
    const geometry = new PlaneGeometry(1, 1, 1, 1);

    const material = new ShaderMaterial({
      vertexShader: portalVertexShader,
      fragmentShader: portalFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uRadius: { value: this.config.maxRadius },
        uProgress: { value: 0 },
        uPrimaryColor: { value: this.config.primaryColor },
        uSecondaryColor: { value: this.config.secondaryColor },
        uGlowIntensity: { value: this.config.glowIntensity },
        uScanLineSpeed: { value: this.config.scanLineSpeed },
      },
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
    });

    this.portalBottom = new Mesh(geometry, material);
    this.portalBottom.rotation.x = -Math.PI / 2;
    // At floor level - just slightly below to avoid z-fighting with glow
    this.portalBottom.position.y = -0.001;
    this.portalBottom.scale.set(
      this.config.maxRadius * 2.5,
      this.config.maxRadius * 2.5,
      1
    );
    this.portalBottom.renderOrder = -885; // Above XRMesh occluder (-1000)

    this.group.add(this.portalBottom);
  }

  _createParticleSystem() {
    const count = this.config.particleCount;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    this.particleAngles = new Float32Array(count);
    this.particleRadii = new Float32Array(count);
    this.particleSpeeds = new Float32Array(count);
    this.particleHeights = new Float32Array(count);

    const primaryColor = this.config.primaryColor;
    const secondaryColor = this.config.secondaryColor;

    for (let i = 0; i < count; i++) {
      this.particleAngles[i] = Math.random() * Math.PI * 2;
      this.particleRadii[i] = 0.9 + Math.random() * 0.15;
      this.particleSpeeds[i] = 0.5 + Math.random() * 1.0;
      // Distribute particles along the tube depth, starting at floor level and going down
      this.particleHeights[i] = -Math.random() * this.config.tubeDepth * 0.7;

      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;

      const colorMix = Math.random();
      colors[i * 3] =
        primaryColor.r * (1 - colorMix) + secondaryColor.r * colorMix;
      colors[i * 3 + 1] =
        primaryColor.g * (1 - colorMix) + secondaryColor.g * colorMix;
      colors[i * 3 + 2] =
        primaryColor.b * (1 - colorMix) + secondaryColor.b * colorMix;

      sizes[i] = this.config.particleSize * (0.5 + Math.random() * 1.0);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setAttribute("size", new Float32BufferAttribute(sizes, 1));

    const textureLoader = new TextureLoader();
    const particleTexture = textureLoader.load("./images/star-particle.png");

    const material = new PointsMaterial({
      size: this.config.particleSize,
      map: particleTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.particleSystem = new Points(geometry, material);
    this.particleSystem.renderOrder = -870; // Above XRMesh occluder (-1000)
    this.group.add(this.particleSystem);
  }

  _createGlowRing() {
    const ringGeometry = new PlaneGeometry(1.4, 1.4);

    const ringMaterial = new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uProgress;
        uniform vec3 uColor;
        uniform float uTime;
        uniform float uBevelAmount;
        varying vec2 vUv;

        void main() {
          vec2 center = vec2(0.5, 0.5);
          float dist = length(vUv - center) * 2.0;

          if (dist > 1.0) discard;

          // Account for bevel - glow follows the larger top opening
          float ringRadius = uProgress * uBevelAmount;
          float innerRadius = ringRadius * 0.85;
          float outerRadius = ringRadius * 1.05;

          float ringInner = smoothstep(innerRadius - 0.1, innerRadius + 0.02, dist);
          float ringOuter = smoothstep(outerRadius + 0.12, outerRadius - 0.02, dist);
          float ring = ringInner * ringOuter;

          float pulse = sin(uTime * 3.0) * 0.15 + 0.85;
          ring *= pulse;

          float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
          float highlight = sin(angle * 6.0 + uTime * 2.5) * 0.2 + 0.8;
          ring *= highlight;

          float glow = smoothstep(outerRadius + 0.25, outerRadius, dist) *
                       smoothstep(innerRadius - 0.15, innerRadius + 0.05, dist);
          glow *= 0.35 * (1.0 - dist * 0.4);

          float alpha = (ring * 0.7 + glow) * smoothstep(0.0, 0.3, uProgress);
          alpha *= smoothstep(1.0, 0.85, dist);

          vec3 color = uColor * (1.0 + ring * 0.3);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uProgress: { value: 0 },
        uColor: { value: this.config.primaryColor },
        uTime: { value: 0 },
        uBevelAmount: { value: this.config.bevelAmount },
      },
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.glowRing = new Mesh(ringGeometry, ringMaterial);
    this.glowRing.rotation.x = -Math.PI / 2;
    // At floor level, surrounding the portal
    this.glowRing.position.y = 0.003;
    this.glowRing.scale.set(
      this.config.maxRadius * 2.8,
      this.config.maxRadius * 2.8,
      1
    );
    this.glowRing.renderOrder = -875; // Above XRMesh occluder (-1000)

    this.group.add(this.glowRing);
  }

  setPosition(position) {
    this.group.position.copy(position);
  }

  setQuaternion(quaternion) {
    this.group.quaternion.copy(quaternion);
  }

  setProgress(progress) {
    this.progress = Math.max(0, Math.min(1, progress));

    if (this.portalBottom) {
      this.portalBottom.material.uniforms.uProgress.value = this.progress;
    }
    if (this.tubeWalls) {
      this.tubeWalls.material.uniforms.uProgress.value = this.progress;
    }
    if (this.glowRing) {
      this.glowRing.material.uniforms.uProgress.value = this.progress;
    }
    if (this.particleSystem) {
      this.particleSystem.material.opacity = this.progress * 0.8;
    }

    // Update floor occluder hole size (matches portal opening)
    this._updateFloorOccluder();

    // Update tube geometry to animate opening
    this._updateTubeGeometry();
  }

  _updateFloorOccluder() {
    if (!this.floorOccluder?.material?.uniforms) return;

    // PERF: Update shader uniform instead of recreating geometry
    const holeRadius = Math.max(
      0.01,
      this.config.maxRadius * this.progress * this.config.bevelAmount
    );
    this.floorOccluder.material.uniforms.uHoleRadius.value = holeRadius;
  }

  update(deltaTime) {
    this.time += deltaTime;

    if (this.portalBottom) {
      this.portalBottom.material.uniforms.uTime.value = this.time;
    }
    if (this.tubeWalls) {
      this.tubeWalls.material.uniforms.uTime.value = this.time;
    }
    if (this.glowRing) {
      this.glowRing.material.uniforms.uTime.value = this.time;
    }

    if (this.particleSystem && this.progress > 0) {
      this._updateParticles(deltaTime);
    }
  }

  _updateParticles(deltaTime) {
    const positions = this.particleSystem.geometry.attributes.position.array;
    const count = this.config.particleCount;
    const topRadius =
      this.config.maxRadius * this.progress * this.config.bevelAmount;

    for (let i = 0; i < count; i++) {
      this.particleAngles[i] +=
        deltaTime * this.particleSpeeds[i] * this.config.particleSpeed;

      // Spiral down into the tube then reset at the rim
      this.particleHeights[i] -= deltaTime * 0.2;
      if (this.particleHeights[i] < -this.config.tubeDepth * 0.8) {
        this.particleHeights[i] = 0.02; // Start just above floor level
        this.particleRadii[i] = 0.95 + Math.random() * 0.1;
      }

      const angle = this.particleAngles[i];
      // Radius decreases as particles go down (following the tube bevel)
      const depthFactor = 1.0 + this.particleHeights[i] / this.config.tubeDepth;
      const radius =
        topRadius * this.particleRadii[i] * Math.max(0.5, depthFactor);

      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = this.particleHeights[i];
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }

    this.particleSystem.geometry.attributes.position.needsUpdate = true;
  }

  getStencilRef() {
    return 1;
  }

  addToScene(scene) {
    scene.add(this.group);
  }

  removeFromScene(scene) {
    scene.remove(this.group);
  }

  dispose() {
    if (this.floorOccluder) {
      this.floorOccluder.geometry.dispose();
      this.floorOccluder.material.dispose();
    }

    if (this.portalBottom) {
      this.portalBottom.geometry.dispose();
      this.portalBottom.material.dispose();
    }

    if (this.tubeInner) {
      this.tubeInner.geometry.dispose();
      this.tubeInner.material.dispose();
    }

    if (this.tubeWalls) {
      this.tubeWalls.geometry.dispose();
      this.tubeWalls.material.dispose();
    }

    if (this.tubeMask) {
      this.tubeMask.geometry.dispose();
      this.tubeMask.material.dispose();
    }

    if (this.particleSystem) {
      this.particleSystem.geometry.dispose();
      this.particleSystem.material.dispose();
      if (this.particleSystem.material.map) {
        this.particleSystem.material.map.dispose();
      }
    }

    if (this.glowRing) {
      this.glowRing.geometry.dispose();
      this.glowRing.material.dispose();
    }

    this.group.clear();
    this.logger.log("PortalVFX disposed");
  }
}

export default PortalVFX;
