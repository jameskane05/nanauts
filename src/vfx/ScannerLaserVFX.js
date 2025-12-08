import {
  Group,
  Mesh,
  BufferGeometry,
  BufferAttribute,
  CylinderGeometry,
  SphereGeometry,
  MeshBasicMaterial,
  Vector3,
  Quaternion,
  AdditiveBlending,
} from "three";

/**
 * Scanner VFX that uses WebXR hit testing to draw accurate lasers against scene depth.
 * Rays emanate from the robot and terminate where they hit real-world surfaces.
 * Uses cylinder meshes for visible laser beams (Line is only 1px on most platforms).
 */
export class ScannerLaserVFX {
  constructor() {
    this.group = new Group();
    this.isActive = false;
    this.time = 0;

    // Laser configuration
    this.numLasers = 8;
    this.laserMaxLength = 2.0;
    this.sweepSpeed = 1.5;
    this.verticalOscillation = 0.3;
    this.laserRadius = 0.003; // Thin laser beams
    this.emitterOffset = new Vector3(0, 0, 0); // No offset - Antenna origin is emit point

    // Store hit test results
    this.hitPositions = new Array(this.numLasers).fill(null);
    this.laserEndpoints = new Array(this.numLasers).fill(null).map(() => new Vector3());

    // Create laser beams as cylinders
    this.lasers = [];
    this.hitDots = [];

    // Shared geometry (unit cylinder, scaled per-laser)
    const laserGeo = new CylinderGeometry(1, 1, 1, 6, 1);
    // Rotate so Y-axis becomes the length axis, origin at one end
    laserGeo.rotateX(Math.PI / 2);
    laserGeo.translate(0, 0, 0.5);

    const dotGeo = new SphereGeometry(0.02, 8, 8);

    for (let i = 0; i < this.numLasers; i++) {
      // Create laser beam mesh
      const laserMat = new MeshBasicMaterial({
        color: 0x00ff66,
        transparent: true,
        opacity: 0.85,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const laser = new Mesh(laserGeo.clone(), laserMat);
      laser.frustumCulled = false;
      this.lasers.push(laser);
      this.group.add(laser);

      // Create hit dot
      const dotMat = new MeshBasicMaterial({
        color: 0x00ffaa,
        transparent: true,
        opacity: 0.95,
        blending: AdditiveBlending,
        depthWrite: false,
      });
      const dot = new Mesh(dotGeo.clone(), dotMat);
      dot.visible = false;
      dot.frustumCulled = false;
      this.hitDots.push(dot);
      this.group.add(dot);
    }

    // Central emitter glow (small sphere at antenna tip)
    const emitterGeo = new SphereGeometry(0.012, 12, 12);
    this.emitter = new Mesh(emitterGeo, new MeshBasicMaterial({
      color: 0x00ffcc,
      transparent: true,
      opacity: 1,
      blending: AdditiveBlending,
      depthWrite: false,
    }));
    this.emitter.frustumCulled = false;
    this.group.add(this.emitter);

    this.group.visible = false;

    // Reusable vectors
    this._worldPosition = new Vector3();
    this._endPoint = new Vector3();
    this._direction = new Vector3();
    this._worldDirection = new Vector3();
    this._up = new Vector3(0, 1, 0);
    this._quaternion = new Quaternion();
    this._worldQuaternion = new Quaternion();
  }

  start() {
    this.isActive = true;
    this.time = 0;
    this.group.visible = true;
    // Reset all lasers to visible
    for (const laser of this.lasers) {
      laser.visible = true;
    }
  }

  stop() {
    this.isActive = false;
    this.group.visible = false;
    for (const dot of this.hitDots) {
      dot.visible = false;
    }
  }

  update(deltaTime) {
    if (!this.isActive) return;

    this.time += deltaTime;


    // Update emitter pulse and local position first
    const emitterPulse = 1 + Math.sin(this.time * 10) * 0.2;
    this.emitter.scale.setScalar(emitterPulse);
    this.emitter.position.copy(this.emitterOffset);
    
    // Get world position of emitter
    this.emitter.getWorldPosition(this._worldPosition);

    // Update each laser
    for (let i = 0; i < this.numLasers; i++) {
      const baseAngle = (i / this.numLasers) * Math.PI * 2;
      const angle = baseAngle + this.time * this.sweepSpeed;

      // Vertical oscillation
      const verticalAngle = Math.sin(this.time * 2 + i * 0.5) * this.verticalOscillation;

      // Direction in local space (relative to the group/face assembly)
      const dirX = Math.cos(angle) * Math.cos(verticalAngle);
      const dirY = Math.sin(verticalAngle);
      const dirZ = Math.sin(angle) * Math.cos(verticalAngle);

      // Calculate endpoint
      let length = this.laserMaxLength;
      let hitSomething = false;

      if (this.hitPositions[i]) {
        this._endPoint.set(
          this.hitPositions[i].x,
          this.hitPositions[i].y,
          this.hitPositions[i].z
        );
        length = this._endPoint.distanceTo(this._worldPosition);
        hitSomething = true;
      }

      // Position laser at emitter offset (local space)
      const laser = this.lasers[i];
      laser.position.copy(this.emitterOffset);

      // Orient laser to point in direction (local space)
      this._direction.set(dirX, dirY, dirZ).normalize();
      this._quaternion.setFromUnitVectors(new Vector3(0, 0, 1), this._direction);
      laser.quaternion.copy(this._quaternion);

      // Scale: radius on X/Y, length on Z
      const pulsingRadius = this.laserRadius * (1 + Math.sin(this.time * 15 + i * 2) * 0.3);
      laser.scale.set(pulsingRadius, pulsingRadius, length);

      // Pulse opacity
      laser.material.opacity = 0.6 + Math.sin(this.time * 8 + i) * 0.25;

      // Update hit dot (convert world hit position to local space)
      const dot = this.hitDots[i];
      if (hitSomething) {
        // Convert world position to local space of the group
        this.group.worldToLocal(this._endPoint.copy(this.hitPositions[i]));
        dot.position.copy(this._endPoint);
        dot.visible = true;
        dot.material.opacity = 0.8 + Math.sin(this.time * 12 + i) * 0.2;
        dot.scale.setScalar(1 + Math.sin(this.time * 10 + i) * 0.3);
      } else {
        dot.visible = false;
      }

      // Store world endpoint for external use
      if (hitSomething) {
        this.laserEndpoints[i].copy(this.hitPositions[i]);
      } else {
        // Calculate world endpoint from local direction
        this._direction.set(dirX, dirY, dirZ).multiplyScalar(length);
        this.group.localToWorld(this._direction.add(this.emitterOffset));
        this.laserEndpoints[i].copy(this._direction);
      }
    }
  }

  setHitPosition(laserIndex, position) {
    if (laserIndex >= 0 && laserIndex < this.numLasers) {
      this.hitPositions[laserIndex] = position;
    }
  }

  clearHitPositions() {
    for (let i = 0; i < this.numLasers; i++) {
      this.hitPositions[i] = null;
    }
  }

  getLaserRay(laserIndex) {
    const baseAngle = (laserIndex / this.numLasers) * Math.PI * 2;
    const angle = baseAngle + this.time * this.sweepSpeed;
    const verticalAngle = Math.sin(this.time * 2 + laserIndex * 0.5) * this.verticalOscillation;

    // Local direction
    const localDir = new Vector3(
      Math.cos(angle) * Math.cos(verticalAngle),
      Math.sin(verticalAngle),
      Math.sin(angle) * Math.cos(verticalAngle)
    );

    // Convert to world space direction (apply group's rotation)
    this.group.getWorldQuaternion(this._worldQuaternion);
    const direction = localDir.applyQuaternion(this._worldQuaternion);

    // Origin at emitter in world space
    const origin = this.emitterOffset.clone();
    this.group.localToWorld(origin);

    return { origin, direction };
  }

  setPosition(x, y, z) {
    this.group.position.set(x, y, z);
  }

  /**
   * Set the color of all laser beams and hit dots
   * @param {number} laserColor - Color for laser beams (hex)
   * @param {number} dotColor - Color for hit dots (hex)
   * @param {number} emitterColor - Color for emitter glow (hex)
   */
  setColor(laserColor, dotColor = null, emitterColor = null) {
    for (const laser of this.lasers) {
      laser.material.color.setHex(laserColor);
    }
    for (const dot of this.hitDots) {
      dot.material.color.setHex(dotColor || laserColor);
    }
    if (this.emitter) {
      this.emitter.material.color.setHex(emitterColor || laserColor);
    }
  }

  /**
   * Reset colors to default green
   */
  resetColor() {
    this.setColor(0x00ff66, 0x00ffaa, 0x00ffcc);
  }

  /**
   * Set to panic/alert mode (red)
   */
  setPanicMode() {
    this.setColor(0xff3333, 0xff6666, 0xff4444);
  }

  dispose() {
    for (const laser of this.lasers) {
      laser.geometry.dispose();
      laser.material.dispose();
    }
    for (const dot of this.hitDots) {
      dot.geometry.dispose();
      dot.material.dispose();
    }
    this.emitter.geometry.dispose();
    this.emitter.material.dispose();
  }
}
