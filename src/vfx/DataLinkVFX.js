/**
 * DataLinkVFX - Curved animated lines with particles between hand and robot antenna
 *
 * Creates a "data link" effect where energy lines with particles extend from both
 * endpoints and reach toward the other side as the player gets closer.
 *
 * Distance thresholds:
 * - 0.78m: Start showing lines extending from antenna
 * - 0.325m: Lines from both ends drawing toward each other
 * - 0.27m: Lines fully connect - triggers contact callback
 *
 * Includes procedural audio: buildup as player approaches, reward sound on connection.
 */

import {
  Group,
  Mesh,
  SphereGeometry,
  MeshBasicMaterial,
  Vector3,
  AdditiveBlending,
  Color,
  CatmullRomCurve3,
  BufferGeometry,
  Line,
  Points,
  PointsMaterial,
  Float32BufferAttribute,
  CanvasTexture,
} from "three";
import { DataLinkAudio } from "../audio/DataLinkAudio.js";

function createParticleTexture() {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

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

  return new CanvasTexture(canvas);
}

let _particleTexture = null;
function getParticleTexture() {
  if (!_particleTexture) {
    _particleTexture = createParticleTexture();
  }
  return _particleTexture;
}

class DataLinkParticle {
  constructor(fromAntenna, speed, color) {
    this.progress = fromAntenna ? 0 : 1;
    this.fromAntenna = fromAntenna;
    this.speed = speed;
    this.color = color;
    this.active = true;
  }

  update(deltaTime) {
    if (this.fromAntenna) {
      this.progress += deltaTime * this.speed;
      if (this.progress >= 1) this.active = false;
    } else {
      this.progress -= deltaTime * this.speed;
      if (this.progress <= 0) this.active = false;
    }
  }
}

export class DataLinkVFX {
  constructor(options = {}) {
    this.group = new Group();
    this.isActive = false;
    this.time = 0;

    // Configuration - distances in meters
    this.config = {
      maxDistance: options.maxDistance || 0.78, // Start showing
      midDistance: options.midDistance || 0.325, // Both ends extending
      contactDistance: options.contactDistance || 0.27, // 30% closer for completion
      numStrands: options.numStrands || 7, // More strands for football shape
      primaryColor: new Color(options.primaryColor || 0x00ffcc),
      secondaryColor: new Color(options.secondaryColor || 0x00ff66),
      pulseSpeed: options.pulseSpeed || 8.0,
      curveArcHeight: options.curveArcHeight || 0.06, // Base arc height
      maxParticles: options.maxParticles || 10,
      particleSpawnRate: options.particleSpawnRate || 8,
      rotationSpeed: options.rotationSpeed || 1.2, // Rotation around center axis
    };

    // State
    this.progress = 0;
    this.antennaPosition = new Vector3();
    this.handPosition = new Vector3();
    this.onContact = options.onContact || null;
    this.contactTriggered = false;

    // Curve and visual elements
    this.curve = null;
    this.strands = [];
    this.particles = [];
    this.lineMeshes = [];
    this.pointsMesh = null;
    this.antennaEmitter = null;
    this.handEmitter = null;

    // Particle spawn timer
    this._spawnTimer = 0;

    // Audio
    this.audio = new DataLinkAudio();
    this._audioStarted = false;

    this._createEmitters();
    this._createStrands();
    this._createParticleSystem();

    this.group.visible = false;

    // Reusable vectors
    this._midPoint = new Vector3();
    this._direction = new Vector3();
    this._perpendicular = new Vector3();
    this._tempVec = new Vector3();
  }

  _createEmitters() {
    const emitterGeo = new SphereGeometry(0.012, 12, 12);

    const antennaMat = new MeshBasicMaterial({
      color: this.config.primaryColor,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.antennaEmitter = new Mesh(emitterGeo.clone(), antennaMat);
    this.antennaEmitter.frustumCulled = false;
    this.group.add(this.antennaEmitter);

    const handMat = new MeshBasicMaterial({
      color: this.config.secondaryColor,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.handEmitter = new Mesh(emitterGeo.clone(), handMat);
    this.handEmitter.frustumCulled = false;
    this.group.add(this.handEmitter);
  }

  _createStrands() {
    for (let i = 0; i < this.config.numStrands; i++) {
      const isMainStrand = i === 0;
      const baseOpacity = isMainStrand ? 0.8 : 0.5;

      // Antenna-side line (primary color)
      const antennaGeometry = new BufferGeometry();
      const antennaPositions = new Float32Array(32 * 3);
      antennaGeometry.setAttribute(
        "position",
        new Float32BufferAttribute(antennaPositions, 3)
      );

      const antennaMaterial = new MeshBasicMaterial({
        color: this.config.primaryColor,
        transparent: true,
        opacity: baseOpacity,
        blending: AdditiveBlending,
        depthWrite: false,
      });

      const antennaLine = new Line(antennaGeometry, antennaMaterial);
      antennaLine.frustumCulled = false;
      antennaLine.visible = false;
      this.group.add(antennaLine);

      // Hand-side line (secondary color)
      const handGeometry = new BufferGeometry();
      const handPositions = new Float32Array(32 * 3);
      handGeometry.setAttribute(
        "position",
        new Float32BufferAttribute(handPositions, 3)
      );

      const handMaterial = new MeshBasicMaterial({
        color: this.config.secondaryColor,
        transparent: true,
        opacity: baseOpacity,
        blending: AdditiveBlending,
        depthWrite: false,
      });

      const handLine = new Line(handGeometry, handMaterial);
      handLine.frustumCulled = false;
      handLine.visible = false;
      this.group.add(handLine);

      // Distribute strands around the center axis (radial angle)
      const radialAngle = (i / this.config.numStrands) * Math.PI * 2;
      // Vary arc height - some pass through center (low arc), some curve more
      const arcMultiplier = 0.3 + Math.abs(Math.sin(radialAngle * 2)) * 0.7;

      this.strands.push({
        antennaLine,
        antennaGeometry,
        antennaMaterial,
        handLine,
        handGeometry,
        handMaterial,
        baseOpacity,
        radialAngle, // Angle around center axis
        arcMultiplier, // How curved this strand is (0.3 = nearly straight, 1.0 = full curve)
        phaseOffset: i * 0.8,
      });
      this.lineMeshes.push(antennaLine, handLine);
    }
  }

  _createParticleSystem() {
    const maxParticles = this.config.maxParticles * this.config.numStrands;
    const positions = new Float32Array(maxParticles * 3);
    const colors = new Float32Array(maxParticles * 3);
    const sizes = new Float32Array(maxParticles);

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setAttribute("size", new Float32BufferAttribute(sizes, 1));

    const material = new PointsMaterial({
      size: 0.015,
      map: getParticleTexture(),
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      vertexColors: true,
      sizeAttenuation: true,
    });

    this.pointsMesh = new Points(geometry, material);
    this.pointsMesh.frustumCulled = false;
    this.group.add(this.pointsMesh);
  }

  _buildCurve(strandIndex = 0) {
    const strand = this.strands[strandIndex];
    const radialAngle = strand?.radialAngle || 0;
    const arcMultiplier = strand?.arcMultiplier || 1.0;
    const phaseOffset = strand?.phaseOffset || 0;

    this._direction
      .copy(this.handPosition)
      .sub(this.antennaPosition)
      .normalize();

    // Create two perpendicular vectors to form a plane around the direction axis
    // This allows us to rotate around the center line
    const perpY = new Vector3(0, 1, 0);
    if (Math.abs(this._direction.y) > 0.9) {
      perpY.set(1, 0, 0);
    }
    const perpA = new Vector3()
      .crossVectors(perpY, this._direction)
      .normalize();
    const perpB = new Vector3()
      .crossVectors(this._direction, perpA)
      .normalize();

    // Rotate around center axis - add time-based rotation for spinning effect
    const rotatingAngle = radialAngle + this.time * this.config.rotationSpeed;

    // Combine the two perpendiculars based on the rotating angle
    this._perpendicular
      .copy(perpA)
      .multiplyScalar(Math.cos(rotatingAngle))
      .addScaledVector(perpB, Math.sin(rotatingAngle));

    // Add subtle wobble
    const wobble = Math.sin(this.time * 4 + phaseOffset) * 0.005;

    // Arc height varies by strand - some nearly straight, some curved
    const arcHeight = (this.config.curveArcHeight + wobble) * arcMultiplier;

    const p0 = this.antennaPosition.clone();
    const p3 = this.handPosition.clone();

    // Control points for smooth curve - football shape tapers at ends
    const p1 = new Vector3().lerpVectors(p0, p3, 0.35);
    p1.addScaledVector(this._perpendicular, arcHeight * 1.1);

    const p2 = new Vector3().lerpVectors(p0, p3, 0.65);
    p2.addScaledVector(this._perpendicular, arcHeight * 1.1);

    return new CatmullRomCurve3([p0, p1, p2, p3], false, "catmullrom", 0.5);
  }

  start() {
    this.isActive = true;
    this.time = 0;
    this.contactTriggered = false;
    this.particles = [];
    this._spawnTimer = 0;
    this._audioStarted = false;
    this.group.visible = true;
  }

  stop() {
    this.isActive = false;
    this.group.visible = false;
    this.progress = 0;
    this.contactTriggered = false;
    this.particles = [];
    this._audioStarted = false;

    // Stop audio
    this.audio.stop();

    for (const strand of this.strands) {
      strand.antennaLine.visible = false;
      strand.handLine.visible = false;
    }
  }

  updatePositions(antennaPos, handPos, deltaTime) {
    if (!this.isActive) return false;

    // Validate input positions
    if (
      !antennaPos ||
      !handPos ||
      !Number.isFinite(antennaPos.x) ||
      !Number.isFinite(handPos.x)
    ) {
      return false;
    }

    this.time += deltaTime;
    this.antennaPosition.copy(antennaPos);
    this.handPosition.copy(handPos);

    const distance = this.antennaPosition.distanceTo(this.handPosition);

    if (distance > this.config.maxDistance) {
      this.group.visible = false;
      this.progress = 0;
      // Stop audio when out of range
      if (this._audioStarted) {
        this.audio.stop();
        this._audioStarted = false;
      }
      return false;
    }

    this.group.visible = true;

    // Start audio when in range
    if (!this._audioStarted) {
      this.audio.start();
      this._audioStarted = true;
    }

    const range = this.config.maxDistance - this.config.contactDistance;
    // Ensure range is valid to prevent NaN/Infinity
    if (range <= 0) {
      this.progress = distance <= this.config.contactDistance ? 1 : 0;
    } else {
      this.progress = Math.max(
        0,
        Math.min(1, (this.config.maxDistance - distance) / range)
      );
    }

    this._updateEmitters();
    this._updateCurvedLines();
    this._updateParticles(deltaTime);

    // Update audio buildup based on progress
    this.audio.update(this.progress);

    if (distance <= this.config.contactDistance && !this.contactTriggered) {
      this.contactTriggered = true;
      // Play connection reward sound
      this.audio.playConnection();
      this.audio.stop();
      this._audioStarted = false;
      if (this.onContact) {
        this.onContact();
      }
      // Stop the VFX after contact
      this.stop();
      return true;
    }

    return false;
  }

  _updateEmitters() {
    this.antennaEmitter.position.copy(this.antennaPosition);
    this.handEmitter.position.copy(this.handPosition);

    const pulse = 1 + Math.sin(this.time * this.config.pulseSpeed) * 0.3;
    const emitterScale = 0.8 + this.progress * 0.5;
    this.antennaEmitter.scale.setScalar(emitterScale * pulse);
    this.handEmitter.scale.setScalar(emitterScale * pulse);

    this.antennaEmitter.material.opacity = 0.5 + this.progress * 0.5;
    this.handEmitter.material.opacity = 0.5 + this.progress * 0.5;
  }

  _updateCurvedLines() {
    // Lines extend from both ends toward the opposite end
    // Antenna line: starts at antenna, extends toward hand
    // Hand line: starts at hand, extends toward antenna
    const antennaLineProgress = Math.min(1, this.progress * 1.5);
    const handLineProgress = Math.max(0, (this.progress - 0.2) / 0.8);

    for (let i = 0; i < this.strands.length; i++) {
      const strand = this.strands[i];
      const curve = this._buildCurve(i);
      const numSegments = 24;
      const opacityMult = 0.5 + this.progress * 0.5;

      // Update antenna-side line (reaching toward hand)
      if (antennaLineProgress > 0.01) {
        strand.antennaLine.visible = true;
        const positions = strand.antennaGeometry.attributes.position.array;
        let idx = 0;

        for (let j = 0; j < numSegments; j++) {
          const t = (j / (numSegments - 1)) * antennaLineProgress;
          const point = curve.getPointAt(Math.min(1, t));
          positions[idx++] = point.x;
          positions[idx++] = point.y;
          positions[idx++] = point.z;
        }

        strand.antennaGeometry.attributes.position.needsUpdate = true;
        strand.antennaGeometry.setDrawRange(0, numSegments);
        strand.antennaMaterial.opacity = strand.baseOpacity * opacityMult;
      } else {
        strand.antennaLine.visible = false;
      }

      // Update hand-side line (reaching toward antenna)
      if (handLineProgress > 0.01) {
        strand.handLine.visible = true;
        const positions = strand.handGeometry.attributes.position.array;
        let idx = 0;

        for (let j = 0; j < numSegments; j++) {
          const t = 1 - (j / (numSegments - 1)) * handLineProgress;
          const point = curve.getPointAt(Math.max(0, t));
          positions[idx++] = point.x;
          positions[idx++] = point.y;
          positions[idx++] = point.z;
        }

        strand.handGeometry.attributes.position.needsUpdate = true;
        strand.handGeometry.setDrawRange(0, numSegments);
        strand.handMaterial.opacity = strand.baseOpacity * opacityMult;
      } else {
        strand.handLine.visible = false;
      }

      // Store curve for particles
      if (i === 0) this.curve = curve;
    }
  }

  _updateParticles(deltaTime) {
    if (!this.curve) return;

    // Spawn new particles
    this._spawnTimer += deltaTime;
    const spawnInterval = 1 / this.config.particleSpawnRate;

    while (
      this._spawnTimer >= spawnInterval &&
      this.particles.length < this.config.maxParticles * 2
    ) {
      this._spawnTimer -= spawnInterval;

      // Spawn from antenna side
      if (this.progress > 0.2) {
        const speed = 0.6 + Math.random() * 0.4;
        this.particles.push(
          new DataLinkParticle(true, speed, this.config.primaryColor)
        );
      }

      // Spawn from hand side (later in progress)
      if (this.progress > 0.4) {
        const speed = 0.6 + Math.random() * 0.4;
        this.particles.push(
          new DataLinkParticle(false, speed, this.config.secondaryColor)
        );
      }
    }

    // Update existing particles
    for (const particle of this.particles) {
      particle.update(deltaTime);
    }

    // Remove dead particles
    this.particles = this.particles.filter((p) => p.active);

    // Update particle mesh positions
    const positions = this.pointsMesh.geometry.attributes.position.array;
    const colors = this.pointsMesh.geometry.attributes.color.array;
    const sizes = this.pointsMesh.geometry.attributes.size.array;

    let idx = 0;
    for (const particle of this.particles) {
      const point = this.curve.getPointAt(
        Math.max(0, Math.min(1, particle.progress))
      );
      positions[idx * 3] = point.x;
      positions[idx * 3 + 1] = point.y;
      positions[idx * 3 + 2] = point.z;

      colors[idx * 3] = particle.color.r;
      colors[idx * 3 + 1] = particle.color.g;
      colors[idx * 3 + 2] = particle.color.b;

      // Pulse size
      const sizePulse =
        1 + Math.sin(this.time * 10 + particle.progress * 5) * 0.3;
      sizes[idx] = 0.012 * sizePulse;

      idx++;
    }

    // Zero out unused particle slots
    for (let i = idx; i < positions.length / 3; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;
      sizes[i] = 0;
    }

    this.pointsMesh.geometry.attributes.position.needsUpdate = true;
    this.pointsMesh.geometry.attributes.color.needsUpdate = true;
    this.pointsMesh.geometry.attributes.size.needsUpdate = true;
    this.pointsMesh.geometry.setDrawRange(0, this.particles.length);
  }

  resetContact() {
    this.contactTriggered = false;
  }

  getProgress() {
    return this.progress;
  }

  isVisible() {
    return this.group.visible;
  }

  dispose() {
    if (this.antennaEmitter) {
      this.antennaEmitter.geometry.dispose();
      this.antennaEmitter.material.dispose();
    }
    if (this.handEmitter) {
      this.handEmitter.geometry.dispose();
      this.handEmitter.material.dispose();
    }
    for (const strand of this.strands) {
      strand.antennaGeometry.dispose();
      strand.antennaMaterial.dispose();
      strand.handGeometry.dispose();
      strand.handMaterial.dispose();
    }
    if (this.pointsMesh) {
      this.pointsMesh.geometry.dispose();
      this.pointsMesh.material.dispose();
    }
    this.audio.dispose();
    this.group.clear();
  }
}

export default DataLinkVFX;
