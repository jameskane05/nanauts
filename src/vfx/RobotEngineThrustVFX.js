import {
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  AdditiveBlending,
  DoubleSide,
} from "three";

/**
 * Animated thrust rings emanating from robot's bottom
 * Creates a fusion propulsion drive visual effect
 * Scales with movement speed and jump phases
 */
export class RobotEngineThrustVFX {
  constructor(config = {}) {
    this.config = {
      ringCount: 5,
      // Size ranges - scales with intensity
      minBaseRadius: 0.02,
      maxBaseRadius: 0.04,
      minMaxRadius: 0.03,
      maxMaxRadius: 0.05,
      ringThickness: 0.006,
      // Opacity ranges (lower to prevent additive blowout when rings overlap)
      minOpacity: 0.4,
      maxOpacity: 0.6,
      // Speed ranges (kept calm - minimal variation with intensity)
      minEmitSpeed: 0.08,
      maxEmitSpeed: 0.12,
      // Distance ranges
      minEmitDistance: 0.03,
      maxEmitDistance: 0.05,
      // Colors
      primaryColor: 0x00ffff,
      secondaryColor: 0x0088ff,
      pulseSpeed: 4.0,
      ...config,
    };

    this.group = new Group();
    this.rings = [];
    this.time = 0;
    this.intensity = 0; // 0-1, scales everything
    this.targetIntensity = 0;
    this.isActive = true;

    // Jump boost state
    this.jumpBoost = 0;
    this.targetJumpBoost = 0;

    // Scale factor for animation speed compensation
    // When VFX is scaled down, animation should slow proportionally
    this.animationSpeedScale = 1.0;

    this._createRings();
  }

  _createRings() {
    const cfg = this.config;

    for (let i = 0; i < cfg.ringCount; i++) {
      // Half the rings use the robot's character color, half use cyan/blue
      let color;
      if (cfg.characterColor && i % 2 === 0) {
        color = cfg.characterColor;
      } else {
        color = i % 2 === 0 ? cfg.primaryColor : cfg.secondaryColor;
      }

      // Start with minimum size geometry
      const geometry = new RingGeometry(
        cfg.minBaseRadius - cfg.ringThickness / 2,
        cfg.minBaseRadius + cfg.ringThickness / 2,
        32
      );

      const material = new MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: true, // Enable depth test so panels (with depthTest:false) render on top
      });

      const ring = new Mesh(geometry, material);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0;
      // Each ring gets slightly different renderOrder for consistent layering
      // Lower index (closer to origin) renders first, higher index renders on top
      ring.renderOrder = -100 + i;
      ring.userData.phase = i / cfg.ringCount;
      ring.userData.baseColor = color;

      this.group.add(ring);
      this.rings.push(ring);
    }
  }

  /**
   * Set thrust intensity based on robot state
   * @param {number} speed - Current speed (0 to ~1.4)
   * @param {number} maxSpeed - Max speed for normalization
   * @param {boolean} isJumping - Is robot in jump
   * @param {number} jumpProgress - 0-1 progress through jump (optional)
   * @param {boolean} isAscending - Is robot in ascent phase of jump
   */
  setIntensity(
    speed,
    maxSpeed = 1.4,
    isJumping = false,
    jumpProgress = 0,
    isAscending = false
  ) {
    const normalizedSpeed = Math.min(speed / maxSpeed, 1);

    // Base intensity: always visible at idle, scales up slightly with speed
    // Keep it chill - minimal variation between idle and moving
    const idleIntensity = 0.4;
    const speedBonus = Math.pow(normalizedSpeed, 1.5) * 0.25; // Subtle speed effect
    this.targetIntensity = idleIntensity + speedBonus;

    // Jump boost - extra thrust during jumps
    if (isJumping) {
      if (isAscending) {
        // Strong boost during ascent (thrusters firing hard)
        this.targetJumpBoost = 0.8 + jumpProgress * 0.2;
      } else {
        // Moderate boost during descent (counter-thrust)
        this.targetJumpBoost = 0.4 + (1 - jumpProgress) * 0.3;
      }
    } else {
      this.targetJumpBoost = 0;
    }

    // Smooth transitions
    const smoothing = 0.12;
    this.intensity += (this.targetIntensity - this.intensity) * smoothing;
    this.jumpBoost += (this.targetJumpBoost - this.jumpBoost) * smoothing;
  }

  update(deltaTime) {
    if (!this.isActive) return;

    // Scale animation speed to compensate for visual scaling
    this.time += deltaTime * this.animationSpeedScale;
    const cfg = this.config;

    // Combined intensity (base + jump boost), scaled by per-character maxScale
    const maxScale = this.maxScale ?? 1.0;
    const totalIntensity =
      Math.min(1, this.intensity + this.jumpBoost) * maxScale;

    // Interpolate all parameters based on intensity
    const baseRadius =
      cfg.minBaseRadius +
      (cfg.maxBaseRadius - cfg.minBaseRadius) * totalIntensity;
    const maxRadius =
      cfg.minMaxRadius + (cfg.maxMaxRadius - cfg.minMaxRadius) * totalIntensity;
    const emitSpeed =
      cfg.minEmitSpeed + (cfg.maxEmitSpeed - cfg.minEmitSpeed) * totalIntensity;
    const emitDistance =
      cfg.minEmitDistance +
      (cfg.maxEmitDistance - cfg.minEmitDistance) * totalIntensity;
    const baseOpacity =
      cfg.minOpacity + (cfg.maxOpacity - cfg.minOpacity) * totalIntensity;

    const cycleTime = emitDistance / emitSpeed;

    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i];
      const phase = ring.userData.phase;

      // Ring cycle progress (0-1)
      const progress = (this.time / cycleTime + phase) % 1;

      // Position: emit downward
      ring.position.y = -progress * emitDistance;

      // Scale: grow from baseRadius to maxRadius, then shrink at end of life
      let radiusScale = baseRadius + progress * (maxRadius - baseRadius);

      // Scale down at end of life (last 25% of cycle)
      let endOfLifeScale = 1;
      if (progress > 0.75) {
        const fadeProgress = (progress - 0.75) / 0.25; // 0 to 1 over last 25%
        endOfLifeScale = 1 - fadeProgress * 0.8; // Scale down to 20% of size
      }

      const scaleFromBase = (radiusScale / cfg.minBaseRadius) * endOfLifeScale;
      ring.scale.set(scaleFromBase, scaleFromBase, 1);

      // Opacity: fade in, hold, fade out
      let opacity;
      if (progress < 0.15) {
        opacity = (progress / 0.15) * baseOpacity;
      } else if (progress > 0.75) {
        const fadeProgress = (progress - 0.75) / 0.25;
        opacity = baseOpacity * (1 - fadeProgress);
      } else {
        opacity = baseOpacity;
      }

      // Pulse effect - more pronounced at higher intensity
      const pulseStrength = 0.1 + totalIntensity * 0.15;
      const pulse =
        1 -
        pulseStrength +
        pulseStrength *
          Math.sin(this.time * cfg.pulseSpeed * Math.PI * 2 + i * 0.5);
      opacity *= pulse;

      // Extra brightness boost during jump
      if (this.jumpBoost > 0.1) {
        opacity *= 1 + this.jumpBoost * 0.3;
      }

      ring.material.opacity = Math.max(0, Math.min(1, opacity));
    }
  }

  /**
   * Attach VFX to a robot's body (parent it)
   * @param {Object3D} robotBody - The robot's object3D to parent to
   * @param {number} robotScale - The robot's scale (to compensate)
   * @param {number} yOffset - Vertical offset for thruster position
   * @param {number} maxScale - Maximum intensity scale multiplier
   */
  attachTo(robotBody, robotScale = 0.5, yOffset = 0, maxScale = 1.0) {
    // Compensate for robot's scale so VFX appears at intended size
    const scaleCompensation = 1 / robotScale;
    this.group.scale.set(
      scaleCompensation,
      scaleCompensation,
      scaleCompensation
    );
    // Position relative to robot's local space (at thrust origin)
    this.group.position.set(0, yOffset, 0);
    this.maxScale = maxScale;
    robotBody.add(this.group);
  }

  getObject3D() {
    return this.group;
  }

  /**
   * Update thrust VFX from robot context - determines jump state from interaction/movement
   * @param {number} speed - Current movement speed
   * @param {number} maxSpeed - Max speed for normalization (typically 1.4)
   * @param {Object} squashState - From movementManager.getSquashState()
   * @param {Object} interactionState - From interactionManager.getState()
   * @param {Object} agent - navcat agent with offMeshAnimation
   * @param {number} deltaTime
   */
  updateFromContext(
    speed,
    maxSpeed,
    squashState,
    interactionState,
    agent,
    deltaTime
  ) {
    let isJumping = squashState?.isJumping || false;
    let jumpProgress = 0;
    let isAscending = false;

    const anim = interactionState?.currentAnimation;

    if (
      anim === "happy" ||
      anim === "happyLoop" ||
      anim === "happyBarrel" ||
      anim === "happyBounce"
    ) {
      isJumping = true;
      if (anim === "happyLoop") {
        const phase = interactionState.animationPhase;
        jumpProgress = interactionState.animationTimer / 2.2;
        isAscending = phase === 1 || (phase === 2 && jumpProgress < 0.6);
      } else if (anim === "happyBarrel") {
        const phase = interactionState.animationPhase;
        jumpProgress = interactionState.animationTimer / 2.5;
        isAscending = phase === 1 || phase === 2 || phase === 3;
      } else if (anim === "happyBounce") {
        const phase = interactionState.animationPhase;
        jumpProgress = interactionState.animationTimer / 1.4;
        isAscending = phase === 1;
      } else {
        jumpProgress = interactionState.animationTimer / 0.7;
        isAscending = jumpProgress < 0.4;
      }
    } else if (isJumping && agent?.offMeshAnimation) {
      const offMesh = agent.offMeshAnimation;
      const jTotalDist =
        Math.sqrt(
          Math.pow(offMesh.endPosition[0] - offMesh.startPosition[0], 2) +
            Math.pow(offMesh.endPosition[2] - offMesh.startPosition[2], 2)
        ) + Math.abs(offMesh.endPosition[1] - offMesh.startPosition[1]);
      const duration = Math.min(1.4, 0.75 + jTotalDist * 0.3);
      jumpProgress = Math.min(1, offMesh.t / duration);
      isAscending = jumpProgress < 0.4;
    }

    this.setIntensity(speed, maxSpeed, isJumping, jumpProgress, isAscending);
    this.update(deltaTime);
  }

  dispose() {
    this.isActive = false;

    for (const ring of this.rings) {
      ring.geometry.dispose();
      ring.material.dispose();
      this.group.remove(ring);
    }
    this.rings = [];

    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
