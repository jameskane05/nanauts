/**
 * HitTestVFX.js - Visual effects for XR hit testing
 *
 * Provides:
 * - Animated reticle with radar sweep, grid, particles
 * - Placed visual burst effect on selection
 */

import {
  RingGeometry,
  PlaneGeometry,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  Group,
  ShaderMaterial,
  AdditiveBlending,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  TextureLoader,
  Color,
} from "three";

export class HitTestVFX {
  constructor(scene) {
    this.scene = scene;
    this._time = 0;
    this._placedVisuals = [];

    this._particleTexture = new TextureLoader().load(
      "./images/star-particle.png"
    );

    this.reticle = this._createReticle();
  }

  _createReticle() {
    const group = new Group();
    group.visible = false;
    group.matrixAutoUpdate = false;

    const primaryColor = new Color(0x00ff88);
    const secondaryColor = new Color(0x00ffcc);
    const reticleRadius = 0.12;

    const discGeometry = new PlaneGeometry(
      reticleRadius * 3,
      reticleRadius * 3
    );
    const discMaterial = new ShaderMaterial({
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uPrimaryColor;
        uniform vec3 uSecondaryColor;
        uniform float uRadius;
        
        varying vec2 vUv;
        
        #define PI 3.14159265359
        
        void main() {
          vec2 center = vec2(0.5, 0.5);
          vec2 uv = vUv;
          float dist = length(uv - center) * 2.0;
          
          if (dist > 1.0) discard;
          
          float normDist = 1.0 - dist;
          
          // === GRID PATTERN ===
          float gridScale = 15.0;
          vec2 gridUv = (uv - center) * gridScale;
          
          float gridAngle = uTime * 0.15;
          float cs = cos(gridAngle);
          float sn = sin(gridAngle);
          gridUv = vec2(gridUv.x * cs - gridUv.y * sn, gridUv.x * sn + gridUv.y * cs);
          
          vec2 gridLines = abs(fract(gridUv) - 0.5);
          float grid = smoothstep(0.02, 0.06, min(gridLines.x, gridLines.y));
          grid = 1.0 - grid;
          grid *= smoothstep(0.0, 0.4, normDist) * 0.5;
          
          // === RADAR SWEEP ===
          float angle = atan(uv.y - 0.5, uv.x - 0.5);
          float sweepAngle = mod(-uTime * 2.5, PI * 2.0);
          float angleDiff = mod(angle - sweepAngle + PI * 2.0, PI * 2.0);
          
          float sweep = smoothstep(PI * 0.5, 0.0, angleDiff);
          sweep *= smoothstep(0.15, 0.3, dist) * smoothstep(1.0, 0.7, dist);
          sweep *= 0.6;
          
          // === CONCENTRIC RINGS ===
          float ringFreq = 8.0;
          float rings = sin((dist * ringFreq - uTime * 1.5) * PI);
          rings = smoothstep(0.5, 1.0, rings);
          rings *= smoothstep(0.0, 0.3, normDist) * smoothstep(1.0, 0.6, normDist) * 0.3;
          
          // === OUTER RING ===
          float outerRing = smoothstep(0.88, 0.92, dist) * smoothstep(1.0, 0.96, dist);
          float pulse = sin(uTime * 3.0) * 0.2 + 0.8;
          outerRing *= pulse;
          
          // === INNER RING ===
          float innerRing = smoothstep(0.28, 0.32, dist) * smoothstep(0.38, 0.34, dist) * 0.6;
          
          // === CENTER DOT ===
          float centerDot = smoothstep(0.12, 0.08, dist);
          centerDot *= 0.9 + sin(uTime * 4.0) * 0.1;
          
          // === COMBINE ===
          vec3 color = vec3(0.0);
          color += uPrimaryColor * grid;
          color += uSecondaryColor * sweep;
          color += mix(uPrimaryColor, uSecondaryColor, 0.5) * rings;
          color += uPrimaryColor * outerRing * 1.2;
          color += uPrimaryColor * innerRing;
          color += uSecondaryColor * centerDot;
          
          float edgeGlow = smoothstep(1.0, 0.85, dist) * smoothstep(0.7, 0.9, dist) * 0.4;
          color += uPrimaryColor * edgeGlow * pulse;
          
          float alpha = grid * 0.8 + sweep * 0.9 + rings * 0.6 + outerRing * 0.9 + innerRing * 0.7 + centerDot + edgeGlow * 0.5;
          alpha = clamp(alpha, 0.0, 1.0);
          alpha *= smoothstep(1.0, 0.95, dist);
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uTime: { value: 0 },
        uPrimaryColor: { value: primaryColor },
        uSecondaryColor: { value: secondaryColor },
        uRadius: { value: reticleRadius },
      },
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    const disc = new Mesh(discGeometry, discMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.003;
    disc.renderOrder = 500;
    group.add(disc);

    // Particles orbiting the reticle
    const particleCount = 24;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const particleAngles = new Float32Array(particleCount);
    const particleSpeeds = new Float32Array(particleCount);
    const particleRadii = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      particleAngles[i] = Math.random() * Math.PI * 2;
      particleSpeeds[i] = 0.8 + Math.random() * 0.8;
      particleRadii[i] = 0.08 + Math.random() * 0.04;

      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0.01;
      positions[i * 3 + 2] = 0;

      const colorMix = Math.random();
      colors[i * 3] =
        primaryColor.r * (1 - colorMix) + secondaryColor.r * colorMix;
      colors[i * 3 + 1] =
        primaryColor.g * (1 - colorMix) + secondaryColor.g * colorMix;
      colors[i * 3 + 2] =
        primaryColor.b * (1 - colorMix) + secondaryColor.b * colorMix;
    }

    const particleGeo = new BufferGeometry();
    particleGeo.setAttribute(
      "position",
      new Float32BufferAttribute(positions, 3)
    );
    particleGeo.setAttribute("color", new Float32BufferAttribute(colors, 3));

    const particleMat = new PointsMaterial({
      size: 0.012,
      map: this._particleTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: true,
    });

    const particles = new Points(particleGeo, particleMat);
    particles.renderOrder = 501;
    group.add(particles);

    group.userData.disc = disc;
    group.userData.particles = particles;
    group.userData.particleAngles = particleAngles;
    group.userData.particleSpeeds = particleSpeeds;
    group.userData.particleRadii = particleRadii;
    group.userData.primaryColor = primaryColor;
    group.userData.secondaryColor = secondaryColor;

    this.scene.add(group);
    return group;
  }

  setReticleVisible(visible) {
    if (this.reticle) {
      this.reticle.visible = visible;
    }
  }

  setReticleMatrix(matrix) {
    if (this.reticle) {
      this.reticle.matrix.fromArray(matrix);
    }
  }

  setReticleColor(color) {
    const uniforms = this.reticle?.userData?.disc?.material?.uniforms;
    if (uniforms) {
      uniforms.uPrimaryColor.value.set(color);
      // Derive secondary color (slightly brighter/shifted)
      const c = new Color(color);
      const secondary = new Color(
        Math.min(1, c.r + 0.2),
        Math.min(1, c.g + 0.2),
        Math.min(1, c.b + 0.2)
      );
      uniforms.uSecondaryColor.value.copy(secondary);
    }
    if (this.reticle?.userData?.primaryColor) {
      this.reticle.userData.primaryColor.set(color);
    }
    // Update particle colors
    const particles = this.reticle?.userData?.particles;
    if (particles) {
      const primary = new Color(color);
      const secondary = new Color(
        Math.min(1, primary.r + 0.2),
        Math.min(1, primary.g + 0.2),
        Math.min(1, primary.b + 0.2)
      );
      const colors = particles.geometry.attributes.color.array;
      const count = colors.length / 3;
      for (let i = 0; i < count; i++) {
        const mix = i / count;
        colors[i * 3] = primary.r * (1 - mix) + secondary.r * mix;
        colors[i * 3 + 1] = primary.g * (1 - mix) + secondary.g * mix;
        colors[i * 3 + 2] = primary.b * (1 - mix) + secondary.b * mix;
      }
      particles.geometry.attributes.color.needsUpdate = true;
    }
  }

  update(delta) {
    this._time += delta;
    this._updateReticleAnimation(delta);
    this._updatePlacedVisuals(delta);
  }

  _updateReticleAnimation(delta) {
    if (!this.reticle?.visible) return;

    const { disc, particles, particleAngles, particleSpeeds, particleRadii } =
      this.reticle.userData;

    if (disc?.material?.uniforms?.uTime) {
      disc.material.uniforms.uTime.value = this._time;
    }

    if (particles && particleAngles) {
      const positions = particles.geometry.attributes.position.array;
      const count = particleAngles.length;

      for (let i = 0; i < count; i++) {
        particleAngles[i] += delta * particleSpeeds[i];
        const angle = particleAngles[i];
        const radius = particleRadii[i];

        positions[i * 3] = Math.cos(angle) * radius;
        positions[i * 3 + 1] =
          0.008 + Math.sin(angle * 2 + this._time * 3) * 0.004;
        positions[i * 3 + 2] = Math.sin(angle) * radius;
      }

      particles.geometry.attributes.position.needsUpdate = true;
    }
  }

  createPlacedVisual(position) {
    const group = new Group();
    group.position.copy(position);
    group.position.y += 0.002;

    const primaryColor = new Color(0x88ccff);
    const secondaryColor = new Color(0xaaddff);
    const radius = 0.18;

    const discGeometry = new PlaneGeometry(radius * 3, radius * 3);
    const discMaterial = new ShaderMaterial({
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
        uniform float uRadius;
        
        varying vec2 vUv;
        
        #define PI 3.14159265359
        
        void main() {
          vec2 center = vec2(0.5, 0.5);
          vec2 uv = vUv;
          float dist = length(uv - center) * 2.0;
          
          if (dist > 1.0) discard;
          
          float normDist = 1.0 - dist;
          
          float gridScale = 15.0;
          vec2 gridUv = (uv - center) * gridScale;
          
          float gridAngle = uTime * 0.15;
          float cs = cos(gridAngle);
          float sn = sin(gridAngle);
          gridUv = vec2(gridUv.x * cs - gridUv.y * sn, gridUv.x * sn + gridUv.y * cs);
          
          vec2 gridLines = abs(fract(gridUv) - 0.5);
          float grid = smoothstep(0.02, 0.06, min(gridLines.x, gridLines.y));
          grid = 1.0 - grid;
          grid *= smoothstep(0.0, 0.4, normDist) * 0.5;
          
          float angle = atan(uv.y - 0.5, uv.x - 0.5);
          float sweepAngle = mod(-uTime * 2.5, PI * 2.0);
          float angleDiff = mod(angle - sweepAngle + PI * 2.0, PI * 2.0);
          
          float sweep = smoothstep(PI * 0.5, 0.0, angleDiff);
          sweep *= smoothstep(0.15, 0.3, dist) * smoothstep(1.0, 0.7, dist);
          sweep *= 0.6;
          
          float ringFreq = 8.0;
          float rings = sin((dist * ringFreq - uTime * 1.5) * PI);
          rings = smoothstep(0.5, 1.0, rings);
          rings *= smoothstep(0.0, 0.3, normDist) * smoothstep(1.0, 0.6, normDist) * 0.3;
          
          float outerRing = smoothstep(0.88, 0.92, dist) * smoothstep(1.0, 0.96, dist);
          float pulse = sin(uTime * 3.0) * 0.2 + 0.8;
          outerRing *= pulse;
          
          float innerRing = smoothstep(0.28, 0.32, dist) * smoothstep(0.38, 0.34, dist) * 0.6;
          
          float centerDot = smoothstep(0.12, 0.08, dist);
          centerDot *= 0.9 + sin(uTime * 4.0) * 0.1;
          
          vec3 color = vec3(0.0);
          color += uPrimaryColor * grid;
          color += uSecondaryColor * sweep;
          color += mix(uPrimaryColor, uSecondaryColor, 0.5) * rings;
          color += uPrimaryColor * outerRing * 1.2;
          color += uPrimaryColor * innerRing;
          color += uSecondaryColor * centerDot;
          
          float edgeGlow = smoothstep(1.0, 0.85, dist) * smoothstep(0.7, 0.9, dist) * 0.4;
          color += uPrimaryColor * edgeGlow * pulse;
          
          float alpha = grid * 0.8 + sweep * 0.9 + rings * 0.6 + outerRing * 0.9 + innerRing * 0.7 + centerDot + edgeGlow * 0.5;
          alpha = clamp(alpha, 0.0, 1.0);
          alpha *= smoothstep(1.0, 0.95, dist);
          alpha *= uProgress;
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uTime: { value: 0 },
        uProgress: { value: 1.0 },
        uPrimaryColor: { value: primaryColor },
        uSecondaryColor: { value: secondaryColor },
        uRadius: { value: radius },
      },
      transparent: true,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    const disc = new Mesh(discGeometry, discMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.003;
    disc.renderOrder = 510;
    group.add(disc);

    const particleCount = 24;
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    const particleAngles = new Float32Array(particleCount);
    const particleSpeeds = new Float32Array(particleCount);
    const particleRadii = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      particleAngles[i] = Math.random() * Math.PI * 2;
      particleSpeeds[i] = 0.8 + Math.random() * 0.8;
      particleRadii[i] = 0.12 + Math.random() * 0.06;

      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0.01;
      positions[i * 3 + 2] = 0;

      const colorMix = Math.random();
      colors[i * 3] =
        primaryColor.r * (1 - colorMix) + secondaryColor.r * colorMix;
      colors[i * 3 + 1] =
        primaryColor.g * (1 - colorMix) + secondaryColor.g * colorMix;
      colors[i * 3 + 2] =
        primaryColor.b * (1 - colorMix) + secondaryColor.b * colorMix;
    }

    const particleGeo = new BufferGeometry();
    particleGeo.setAttribute(
      "position",
      new Float32BufferAttribute(positions, 3)
    );
    particleGeo.setAttribute("color", new Float32BufferAttribute(colors, 3));

    const particleMat = new PointsMaterial({
      size: 0.012,
      map: this._particleTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: true,
    });

    const particles = new Points(particleGeo, particleMat);
    particles.renderOrder = 501;
    group.add(particles);

    group.userData.disc = disc;
    group.userData.particles = particles;
    group.userData.particleAngles = particleAngles;
    group.userData.particleSpeeds = particleSpeeds;
    group.userData.particleRadii = particleRadii;

    this.scene.add(group);

    const visualData = {
      group,
      startTime: performance.now(),
    };
    this._placedVisuals.push(visualData);

    return visualData;
  }

  _updatePlacedVisuals(delta) {
    const now = performance.now();

    for (let i = this._placedVisuals.length - 1; i >= 0; i--) {
      const visual = this._placedVisuals[i];
      const elapsed = (now - visual.startTime) / 1000;

      let duration = 1.5;
      if (visual.scalingOut) {
        duration = visual.scaleOutDuration || 0.5;
      }

      if (elapsed >= duration) {
        this._disposePlacedVisual(visual);
        this._placedVisuals.splice(i, 1);
        continue;
      }

      const progress = elapsed / duration;
      const { disc, particles, particleAngles, particleSpeeds, particleRadii } =
        visual.group.userData;

      if (visual.scalingOut) {
        const scaleProgress = Math.min(1, progress * 2);
        const scale = 1 + scaleProgress * 2;
        visual.group.scale.set(scale, scale, scale);
      }

      if (disc?.material?.uniforms) {
        disc.material.uniforms.uTime.value = elapsed;
        disc.material.uniforms.uProgress.value = 1.0 - progress;
      }

      if (particles && particleAngles) {
        const positions = particles.geometry.attributes.position.array;
        const count = particleAngles.length;

        for (let i = 0; i < count; i++) {
          particleAngles[i] += delta * particleSpeeds[i];
          const angle = particleAngles[i];
          const radius = particleRadii[i];

          positions[i * 3] = Math.cos(angle) * radius;
          positions[i * 3 + 1] =
            0.008 + Math.sin(angle * 2 + elapsed * 3) * 0.004;
          positions[i * 3 + 2] = Math.sin(angle) * radius;
        }

        particles.geometry.attributes.position.needsUpdate = true;
        particles.material.opacity = (1 - progress) * 0.7;
      }
    }
  }

  scaleOutAllPlacedVisuals() {
    const now = performance.now();
    for (const visual of this._placedVisuals) {
      if (!visual.scalingOut) {
        visual.scalingOut = true;
        visual.startTime = now;
        visual.scaleOutDuration = 0.5;
      }
    }
  }

  disposeAllPlacedVisuals() {
    for (const visual of this._placedVisuals) {
      this._disposePlacedVisual(visual);
    }
    this._placedVisuals = [];
  }

  _disposePlacedVisual(visual) {
    const { disc, particles } = visual.group.userData;

    if (disc) {
      disc.geometry?.dispose();
      disc.material?.dispose();
    }
    if (particles) {
      particles.geometry?.dispose();
      particles.material?.dispose();
    }

    this.scene.remove(visual.group);
  }

  dispose() {
    if (this.reticle) {
      this.scene.remove(this.reticle);
      const { disc, particles } = this.reticle.userData || {};
      if (disc) {
        disc.geometry?.dispose();
        disc.material?.dispose();
      }
      if (particles) {
        particles.geometry?.dispose();
        particles.material?.dispose();
      }
      this.reticle = null;
    }

    this.disposeAllPlacedVisuals();

    if (this._particleTexture) {
      this._particleTexture.dispose();
      this._particleTexture = null;
    }
  }
}
