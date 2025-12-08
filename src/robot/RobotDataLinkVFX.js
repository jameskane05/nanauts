/**
 * RobotDataLinkVFX.js - Animated particle line between interacting robots
 * =============================================================================
 *
 * ROLE: Visual effect showing "data transfer" between robots during interaction
 * chat phases. Creates a curved line with particles traveling both directions.
 *
 * VISUAL: Cyan/blue particles (matching thruster colors) flow along a curved
 * arc between the AntennaTip meshes of two robots. Additive blending for glow.
 *
 * ARCHITECTURE:
 *   - RobotDataLinkVFX: Manager class, owns multiple DataLink instances
 *   - DataLink: Single connection between two antenna tips
 *   - DataLinkParticle: Individual particle traveling along curve
 *
 * KEY METHODS:
 *   - createLink(id, robotAGroup, robotBGroup): Start VFX between robots
 *   - update(deltaTime): Update all active links (spawn particles, animate)
 *   - removeLinkGraceful(id): Animated outro (lines retract over ~0.4s)
 *   - removeLink(id): Immediate cleanup (no animation)
 *
 * CURVE: CatmullRomCurve3 with control points for smooth arc. Updates each
 * frame to follow moving robots.
 *
 * PARTICLES:
 *   - Spawned periodically (spawnInterval)
 *   - Travel both directions (A→B cyan, B→A blue)
 *   - Variable speed (0.8-1.4) for natural feel
 *
 * CREATED BY: RobotInteractionManager during CHAT phases.
 *
 * NOTE: Built with native Three.js after three.signal-line proved incompatible
 * with modern Three.js ESM imports.
 * =============================================================================
 */
import {
  Vector3,
  CatmullRomCurve3,
  BufferGeometry,
  Line,
  Points,
  PointsMaterial,
  Float32BufferAttribute,
  AdditiveBlending,
  Color,
  CanvasTexture,
  ShaderMaterial,
} from "three";
import { getCharacterById } from "../data/robotCharacters.js";

// Generate circular particle texture
function createParticleTexture() {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Radial gradient: white center fading to transparent
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.3, "rgba(255,255,255,0.8)");
  gradient.addColorStop(0.7, "rgba(255,255,255,0.3)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new CanvasTexture(canvas);
  return texture;
}

// Shared particle texture (created once)
let _particleTexture = null;
function getParticleTexture() {
  if (!_particleTexture) {
    _particleTexture = createParticleTexture();
  }
  return _particleTexture;
}

class DataLinkParticle {
  constructor(forward, speed, color) {
    this.progress = 0; // 0-1 along the curve
    this.forward = forward; // true = A->B, false = B->A
    this.speed = speed;
    this.color = color;
    this.active = true;
  }

  update(deltaTime) {
    if (this.forward) {
      this.progress += deltaTime * this.speed;
      if (this.progress >= 1) {
        this.active = false;
      }
    } else {
      this.progress -= deltaTime * this.speed;
      if (this.progress <= 0) {
        this.active = false;
      }
    }
  }
}

class DataLink {
  constructor(scene, antennaTipA, antennaTipB, colorA, colorB) {
    this.scene = scene;
    this.antennaTipA = antennaTipA;
    this.antennaTipB = antennaTipB;

    // Draw animation state
    this.drawProgress = 0; // 0-1, how much of lines are drawn
    this.drawState = "intro"; // 'intro' | 'active' | 'outro' | 'done'
    this.drawDuration = 0.4; // seconds for intro/outro

    // Main beam
    this.particles = [];
    this.curve = null;
    this.lineMesh = null;
    this.pointsMesh = null;
    this.maxParticles = 12;

    // Secondary strands (2-4 thinner curves around main)
    this.strandCount = 2 + Math.floor(Math.random() * 3); // 2-4 strands
    this.strands = [];
    this.strandParticles = []; // Array of particle arrays, one per strand
    this.strandCurves = [];
    this.strandLineMeshes = [];
    this.strandPointsMeshes = [];
    this.maxStrandParticles = 6; // Fewer particles per strand

    // Track which strands draw from which direction (for intro/outro effect)
    // Main line + even strands: A→B, odd strands: B→A
    this.strandDrawFromB = []; // true = draw from B side

    // Temp vectors
    this._posA = new Vector3();
    this._posB = new Vector3();
    this._tempVec = new Vector3();
    this._perpVec = new Vector3();

    // Robot colors (from character themes)
    this.colorA = new Color(colorA); // Robot A's color (particles going A→B)
    this.colorB = new Color(colorB); // Robot B's color (particles going B→A)

    // Generate random strand properties (slightly different arc shapes)
    this.strandOffsets = [];
    for (let i = 0; i < this.strandCount; i++) {
      this.strandOffsets.push({
        arcScale: 0.7 + Math.random() * 0.6, // 0.7-1.3x main arc height
        lateralOffset: (Math.random() - 0.5) * 0.04, // ±0.02m sideways
        verticalOffset: (Math.random() - 0.5) * 0.02, // ±0.01m up/down
      });
      this.strandParticles.push([]);
      this.strandDrawFromB.push(i % 2 === 1); // Alternate directions
    }

    this._createGeometry();
  }

  startOutro() {
    if (this.drawState === "active") {
      this.drawState = "outro";
    }
  }

  isFullyDrawn() {
    return this.drawState === "active";
  }

  isDone() {
    return this.drawState === "done";
  }

  _createGeometry() {
    // Get initial positions
    this.antennaTipA.getWorldPosition(this._posA);
    this.antennaTipB.getWorldPosition(this._posB);

    // Create main curved path
    this._updateCurve();

    // Create main line geometry with gradient colors
    const linePoints = this.curve.getPoints(32);
    const lineGeometry = new BufferGeometry().setFromPoints(linePoints);

    // Add vertex colors for gradient effect (A color -> B color)
    const lineColors = new Float32Array(linePoints.length * 3);
    for (let i = 0; i < linePoints.length; i++) {
      const t = i / (linePoints.length - 1);
      lineColors[i * 3] = this.colorA.r * (1 - t) + this.colorB.r * t;
      lineColors[i * 3 + 1] = this.colorA.g * (1 - t) + this.colorB.g * t;
      lineColors[i * 3 + 2] = this.colorA.b * (1 - t) + this.colorB.b * t;
    }
    lineGeometry.setAttribute(
      "color",
      new Float32BufferAttribute(lineColors, 3)
    );

    this.lineMaterial = new ShaderMaterial({
      vertexShader: `
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        uniform float opacity;
        void main() {
          gl_FragColor = vec4(vColor, opacity);
        }
      `,
      uniforms: { opacity: { value: 0.4 } },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    this.lineMesh = new Line(lineGeometry, this.lineMaterial);
    this.lineMesh.renderOrder = -100;
    this.scene.add(this.lineMesh);

    // Create main points geometry for particles
    const positions = new Float32Array(this.maxParticles * 3);
    const colors = new Float32Array(this.maxParticles * 3);

    const pointsGeometry = new BufferGeometry();
    pointsGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(positions, 3)
    );
    pointsGeometry.setAttribute("color", new Float32BufferAttribute(colors, 3));

    const pointsMaterial = new PointsMaterial({
      size: 0.025,
      map: getParticleTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.pointsMesh = new Points(pointsGeometry, pointsMaterial);
    this.pointsMesh.renderOrder = -100; // Render early, before UI panels
    this.pointsMesh.frustumCulled = false; // Prevent culling when particles move
    this.scene.add(this.pointsMesh);

    // Create secondary strand geometries
    for (let s = 0; s < this.strandCount; s++) {
      // Strand line (thinner, more transparent) - use its own curve points
      const strandLinePoints = this.strandCurves[s]
        ? this.strandCurves[s].getPoints(24)
        : linePoints;
      const strandLineGeo = new BufferGeometry().setFromPoints(
        strandLinePoints
      );

      // Add vertex colors for gradient (same as main line)
      const strandLineColors = new Float32Array(strandLinePoints.length * 3);
      for (let i = 0; i < strandLinePoints.length; i++) {
        const t = i / (strandLinePoints.length - 1);
        strandLineColors[i * 3] = this.colorA.r * (1 - t) + this.colorB.r * t;
        strandLineColors[i * 3 + 1] =
          this.colorA.g * (1 - t) + this.colorB.g * t;
        strandLineColors[i * 3 + 2] =
          this.colorA.b * (1 - t) + this.colorB.b * t;
      }
      strandLineGeo.setAttribute(
        "color",
        new Float32BufferAttribute(strandLineColors, 3)
      );

      const strandLineMat = new ShaderMaterial({
        vertexShader: `
          attribute vec3 color;
          varying vec3 vColor;
          void main() {
            vColor = color;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vColor;
          uniform float opacity;
          void main() {
            gl_FragColor = vec4(vColor, opacity);
          }
        `,
        uniforms: { opacity: { value: 0.2 } },
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      });

      const strandLine = new Line(strandLineGeo, strandLineMat);
      strandLine.renderOrder = -100;
      this.scene.add(strandLine);
      this.strandLineMeshes.push(strandLine);

      // Strand particles (smaller)
      const strandPositions = new Float32Array(this.maxStrandParticles * 3);
      const strandColors = new Float32Array(this.maxStrandParticles * 3);
      const strandGeo = new BufferGeometry();
      strandGeo.setAttribute(
        "position",
        new Float32BufferAttribute(strandPositions, 3)
      );
      strandGeo.setAttribute(
        "color",
        new Float32BufferAttribute(strandColors, 3)
      );

      const strandPointsMat = new PointsMaterial({
        size: 0.015,
        map: getParticleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
        blending: AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });

      const strandPoints = new Points(strandGeo, strandPointsMat);
      strandPoints.renderOrder = -100; // Render early, before UI panels
      strandPoints.frustumCulled = false; // Prevent culling when particles move
      this.scene.add(strandPoints);
      this.strandPointsMeshes.push(strandPoints);
    }
  }

  _updateCurve() {
    // Force matrix update in case robot is mid-animation
    this.antennaTipA.updateWorldMatrix(true, false);
    this.antennaTipB.updateWorldMatrix(true, false);

    this.antennaTipA.getWorldPosition(this._posA);
    this.antennaTipB.getWorldPosition(this._posB);

    // Store exact endpoint copies - all curves MUST use these exact values
    const startPoint = this._posA.clone();
    const endPoint = this._posB.clone();

    // Calculate arc height based on distance
    const distance = startPoint.distanceTo(endPoint);
    const arcHeight = Math.max(0.08, distance * 0.35);

    // Direction from A to B (for lateral offsets)
    this._tempVec.subVectors(endPoint, startPoint).normalize();
    // Perpendicular in XZ plane
    const perpX = -this._tempVec.z;
    const perpZ = this._tempVec.x;

    // Midpoint for main curve
    const mid = new Vector3().lerpVectors(startPoint, endPoint, 0.5);
    mid.y += arcHeight;

    // Control points for smooth curve
    const ctrl1 = new Vector3().lerpVectors(startPoint, mid, 0.5);
    ctrl1.y += arcHeight * 0.3;
    const ctrl2 = new Vector3().lerpVectors(mid, endPoint, 0.5);
    ctrl2.y += arcHeight * 0.3;

    this.curve = new CatmullRomCurve3([
      startPoint.clone(),
      ctrl1,
      mid,
      ctrl2,
      endPoint.clone(),
    ]);

    // Update strand curves - SAME endpoints, slightly different arc properties
    this.strandCurves = [];
    for (let s = 0; s < this.strandCount; s++) {
      const offset = this.strandOffsets[s];
      const strandArcHeight = arcHeight * offset.arcScale;

      // Midpoint with offset
      const strandMid = new Vector3().lerpVectors(startPoint, endPoint, 0.5);
      strandMid.y += strandArcHeight;
      strandMid.x += perpX * offset.lateralOffset;
      strandMid.z += perpZ * offset.lateralOffset;
      strandMid.y += offset.verticalOffset;

      const strandCtrl1 = new Vector3().lerpVectors(startPoint, strandMid, 0.5);
      strandCtrl1.y += strandArcHeight * 0.3;
      strandCtrl1.x += perpX * offset.lateralOffset * 0.5;
      strandCtrl1.z += perpZ * offset.lateralOffset * 0.5;

      const strandCtrl2 = new Vector3().lerpVectors(strandMid, endPoint, 0.5);
      strandCtrl2.y += strandArcHeight * 0.3;
      strandCtrl2.x += perpX * offset.lateralOffset * 0.5;
      strandCtrl2.z += perpZ * offset.lateralOffset * 0.5;

      // Use exact same start/end points as main curve
      this.strandCurves.push(
        new CatmullRomCurve3([
          startPoint.clone(),
          strandCtrl1,
          strandMid,
          strandCtrl2,
          endPoint.clone(),
        ])
      );
    }
  }

  spawnParticle() {
    if (this.drawState !== "active") return;
    if (this.particles.length >= this.maxParticles) return;

    const forward = Math.random() > 0.5;
    const speed = 0.8 + Math.random() * 0.6;
    const color = forward ? this.colorA : this.colorB;

    const particle = new DataLinkParticle(forward, speed, color);
    particle.progress = forward ? 0 : 1;
    this.particles.push(particle);
  }

  spawnStrandParticle(strandIndex) {
    if (this.drawState !== "active") return;
    if (this.strandParticles[strandIndex].length >= this.maxStrandParticles)
      return;

    const forward = Math.random() > 0.5;
    const speed = 1.0 + Math.random() * 0.8;
    const color = forward ? this.colorA : this.colorB;

    const particle = new DataLinkParticle(forward, speed, color);
    particle.progress = forward ? 0 : 1;
    this.strandParticles[strandIndex].push(particle);
  }

  _getPartialCurvePoints(curve, numPoints, progress, fromEnd = false) {
    if (progress >= 1) {
      return curve.getPoints(numPoints);
    }
    if (progress <= 0) {
      return [];
    }

    const points = [];
    const pointCount = Math.max(2, Math.ceil(numPoints * progress));

    if (fromEnd) {
      // Draw from end (B) toward start (A)
      const startT = 1 - progress;
      for (let i = 0; i < pointCount; i++) {
        const t = startT + (progress * i) / (pointCount - 1);
        points.push(curve.getPoint(Math.min(1, t)));
      }
    } else {
      // Draw from start (A) toward end (B)
      for (let i = 0; i < pointCount; i++) {
        const t = (progress * i) / (pointCount - 1);
        points.push(curve.getPoint(t));
      }
    }
    return points;
  }

  update(deltaTime) {
    // Animate draw progress
    if (this.drawState === "intro") {
      this.drawProgress += deltaTime / this.drawDuration;
      if (this.drawProgress >= 1) {
        this.drawProgress = 1;
        this.drawState = "active";
      }
    } else if (this.drawState === "outro") {
      this.drawProgress -= deltaTime / this.drawDuration;
      if (this.drawProgress <= 0) {
        this.drawProgress = 0;
        this.drawState = "done";
      }
    }

    // Update curve positions (robots might move)
    this._updateCurve();

    // Eased progress for smoother animation
    const easedProgress =
      this.drawProgress < 0.5
        ? 2 * this.drawProgress * this.drawProgress
        : 1 - Math.pow(-2 * this.drawProgress + 2, 2) / 2;

    // Update main line geometry (draws from A)
    if (this.lineMesh) {
      const linePoints = this._getPartialCurvePoints(
        this.curve,
        32,
        easedProgress,
        false
      );
      if (linePoints.length >= 2) {
        this.lineMesh.geometry.setFromPoints(linePoints);
        // Update gradient colors
        const lineColors = new Float32Array(linePoints.length * 3);
        for (let i = 0; i < linePoints.length; i++) {
          const t = i / (linePoints.length - 1);
          lineColors[i * 3] = this.colorA.r * (1 - t) + this.colorB.r * t;
          lineColors[i * 3 + 1] = this.colorA.g * (1 - t) + this.colorB.g * t;
          lineColors[i * 3 + 2] = this.colorA.b * (1 - t) + this.colorB.b * t;
        }
        this.lineMesh.geometry.setAttribute(
          "color",
          new Float32BufferAttribute(lineColors, 3)
        );
        this.lineMesh.visible = true;
      } else {
        this.lineMesh.visible = false;
      }
    }

    // Update strand line geometries
    for (let s = 0; s < this.strandCount; s++) {
      if (this.strandLineMeshes[s] && this.strandCurves[s]) {
        const fromEnd = this.strandDrawFromB[s];
        const strandPoints = this._getPartialCurvePoints(
          this.strandCurves[s],
          24,
          easedProgress,
          fromEnd
        );
        if (strandPoints.length >= 2) {
          this.strandLineMeshes[s].geometry.setFromPoints(strandPoints);
          // Update gradient colors
          const strandColors = new Float32Array(strandPoints.length * 3);
          for (let i = 0; i < strandPoints.length; i++) {
            // For strands drawing from B, reverse the gradient
            const t = fromEnd
              ? 1 - i / (strandPoints.length - 1)
              : i / (strandPoints.length - 1);
            strandColors[i * 3] = this.colorA.r * (1 - t) + this.colorB.r * t;
            strandColors[i * 3 + 1] =
              this.colorA.g * (1 - t) + this.colorB.g * t;
            strandColors[i * 3 + 2] =
              this.colorA.b * (1 - t) + this.colorB.b * t;
          }
          this.strandLineMeshes[s].geometry.setAttribute(
            "color",
            new Float32BufferAttribute(strandColors, 3)
          );
          this.strandLineMeshes[s].visible = true;
        } else {
          this.strandLineMeshes[s].visible = false;
        }
      }
    }

    // Update main particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.update(deltaTime);
      if (!p.active) {
        this.particles.splice(i, 1);
      }
    }

    // Update strand particles
    for (let s = 0; s < this.strandCount; s++) {
      const particles = this.strandParticles[s];
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.update(deltaTime);
        if (!p.active) {
          particles.splice(i, 1);
        }
      }
    }

    // Update main points mesh
    if (this.pointsMesh && this.curve) {
      const positions = this.pointsMesh.geometry.attributes.position.array;
      const colors = this.pointsMesh.geometry.attributes.color.array;

      for (let i = 0; i < this.maxParticles; i++) {
        if (i < this.particles.length) {
          const p = this.particles[i];
          const pos = this.curve.getPoint(Math.max(0, Math.min(1, p.progress)));
          positions[i * 3] = pos.x;
          positions[i * 3 + 1] = pos.y;
          positions[i * 3 + 2] = pos.z;
          colors[i * 3] = p.color.r;
          colors[i * 3 + 1] = p.color.g;
          colors[i * 3 + 2] = p.color.b;
        } else {
          positions[i * 3] = 0;
          positions[i * 3 + 1] = -1000;
          positions[i * 3 + 2] = 0;
        }
      }

      this.pointsMesh.geometry.attributes.position.needsUpdate = true;
      this.pointsMesh.geometry.attributes.color.needsUpdate = true;
    }

    // Update strand points meshes
    for (let s = 0; s < this.strandCount; s++) {
      const pointsMesh = this.strandPointsMeshes[s];
      const curve = this.strandCurves[s];
      const particles = this.strandParticles[s];

      if (pointsMesh && curve) {
        const positions = pointsMesh.geometry.attributes.position.array;
        const colors = pointsMesh.geometry.attributes.color.array;

        for (let i = 0; i < this.maxStrandParticles; i++) {
          if (i < particles.length) {
            const p = particles[i];
            const pos = curve.getPoint(Math.max(0, Math.min(1, p.progress)));
            positions[i * 3] = pos.x;
            positions[i * 3 + 1] = pos.y;
            positions[i * 3 + 2] = pos.z;
            colors[i * 3] = p.color.r;
            colors[i * 3 + 1] = p.color.g;
            colors[i * 3 + 2] = p.color.b;
          } else {
            positions[i * 3] = 0;
            positions[i * 3 + 1] = -1000;
            positions[i * 3 + 2] = 0;
          }
        }

        pointsMesh.geometry.attributes.position.needsUpdate = true;
        pointsMesh.geometry.attributes.color.needsUpdate = true;
      }
    }
  }

  dispose() {
    if (this.lineMesh) {
      this.scene.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
      this.lineMesh.material.dispose();
    }
    if (this.pointsMesh) {
      this.scene.remove(this.pointsMesh);
      this.pointsMesh.geometry.dispose();
      this.pointsMesh.material.dispose();
    }
    // Dispose strand geometries
    for (const lineMesh of this.strandLineMeshes) {
      this.scene.remove(lineMesh);
      lineMesh.geometry.dispose();
      lineMesh.material.dispose();
    }
    for (const pointsMesh of this.strandPointsMeshes) {
      this.scene.remove(pointsMesh);
      pointsMesh.geometry.dispose();
      pointsMesh.material.dispose();
    }
    this.particles = [];
    this.strandParticles = [];
  }
}

export class RobotDataLinkVFX {
  constructor(scene) {
    this.scene = scene;
    this.activeLinks = new Map(); // interactionId -> DataLink
    this.spawnInterval = 0.12; // seconds between particle spawns
    this.lastSpawnTime = new Map();
  }

  createLink(interactionId, robotAGroup, robotBGroup) {
    // Find antenna tips
    let antennaTipA = null;
    let antennaTipB = null;

    robotAGroup.traverse((child) => {
      if (child.name.includes("AntennaTip")) antennaTipA = child;
    });
    robotBGroup.traverse((child) => {
      if (child.name.includes("AntennaTip")) antennaTipB = child;
    });

    if (!antennaTipA || !antennaTipB) {
      console.warn("RobotDataLinkVFX: Could not find AntennaTip meshes");
      return null;
    }

    // Get robot colors from character data
    const charIdA = robotAGroup.userData?.characterId || "";
    const charIdB = robotBGroup.userData?.characterId || "";
    const charA = getCharacterById(charIdA);
    const charB = getCharacterById(charIdB);

    // Use primaryColor from character appearance, fallback to cyan/blue
    const colorA = charA?.appearance?.primaryColor ?? 0x00ffff;
    const colorB = charB?.appearance?.primaryColor ?? 0x0088ff;

    const link = new DataLink(
      this.scene,
      antennaTipA,
      antennaTipB,
      colorA,
      colorB
    );
    this.activeLinks.set(interactionId, link);
    this.lastSpawnTime.set(interactionId, 0);

    return link;
  }

  update(deltaTime) {
    const toRemove = [];

    for (const [id, link] of this.activeLinks) {
      link.update(deltaTime);

      // Clean up links that finished outro
      if (link.isDone()) {
        toRemove.push(id);
        continue;
      }

      // Only spawn particles when link is fully active
      if (!link.isFullyDrawn()) {
        continue;
      }

      // Spawn new particles periodically
      let lastTime = this.lastSpawnTime.get(id) || 0;
      lastTime += deltaTime;
      if (lastTime >= this.spawnInterval) {
        link.spawnParticle();
        // Also spawn on random strand
        if (link.strandCount > 0 && Math.random() > 0.3) {
          const strandIdx = Math.floor(Math.random() * link.strandCount);
          link.spawnStrandParticle(strandIdx);
        }
        lastTime = 0;
      }
      this.lastSpawnTime.set(id, lastTime);
    }

    // Dispose finished links
    for (const id of toRemove) {
      this._disposeLink(id);
    }
  }

  // Start graceful outro animation
  removeLinkGraceful(interactionId) {
    const link = this.activeLinks.get(interactionId);
    if (link) {
      link.startOutro();
    }
  }

  // Immediate removal (skips outro)
  removeLink(interactionId) {
    this._disposeLink(interactionId);
  }

  _disposeLink(interactionId) {
    const link = this.activeLinks.get(interactionId);
    if (link) {
      link.dispose();
      this.activeLinks.delete(interactionId);
      this.lastSpawnTime.delete(interactionId);
    }
  }

  removeAllLinks() {
    for (const [id] of this.activeLinks) {
      this._disposeLink(id);
    }
  }

  // Graceful removal of all links
  removeAllLinksGraceful() {
    for (const [, link] of this.activeLinks) {
      link.startOutro();
    }
  }

  dispose() {
    this.removeAllLinks();
  }
}
