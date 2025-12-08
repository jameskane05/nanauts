import * as THREE from "three";

// Set to true to use raycasting, false for simple fixed offset
const USE_RAYCASTING = false;

const DEFAULT_SIZE = 0.35;
const BASE_OPACITY = 0.75;
const FADE_SPEED = 4.0;
const JUMP_FADE_OUT_SPEED = 6.0;
const JUMP_FADE_IN_SPEED = 12.0;
const Y_BELOW_ROBOT = 0.05;
const POSITION_LERP_SPEED = 15.0;
const MAX_RAYCAST_DIST = 3.0;
const FLOOR_OFFSET = 0.02;

export class BlobShadowVFX {
  constructor(renderer, scene, target, world, size = DEFAULT_SIZE) {
    this.scene = scene;
    this.target = target;
    this.world = world;

    this._targetPos = new THREE.Vector3();
    this._shadowTargetPos = new THREE.Vector3();
    this._currentPos = new THREE.Vector3();
    this._opacity = BASE_OPACITY;
    this._targetOpacity = BASE_OPACITY;
    this._hasValidPosition = false;
    this._isJumping = false;
    this._frozenPosition = new THREE.Vector3();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0;
    this.raycaster.far = MAX_RAYCAST_DIST;
    this.raycaster.firstHitOnly = true;
    this._rayDir = new THREE.Vector3(0, -1, 0);

    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, `rgba(0, 0, 0, ${BASE_OPACITY * 0.5})`);
    gradient.addColorStop(0.4, `rgba(0, 0, 0, ${BASE_OPACITY * 0.3})`);
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);

    const texture = new THREE.CanvasTexture(canvas);

    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = -1;
    this.baseScale = 1.0;
    scene.add(this.mesh);
  }

  update(deltaTime = 0.016, shouldRaycast = false, raycastMeshes = null) {
    if (!this.target) return;

    this.target.getWorldPosition(this._targetPos);

    // Don't update position while jumping - keep frozen or use landing position
    if (!this._isJumping) {
      if (USE_RAYCASTING) {
        // Raycast to find floor position (only when it's our turn)
        if (shouldRaycast && raycastMeshes && raycastMeshes.length > 0) {
          this.raycaster.set(this._targetPos, this._rayDir);
          const hits = this.raycaster.intersectObjects(raycastMeshes, false);

          if (hits.length > 0) {
            const hit = hits[0];
            this._shadowTargetPos.set(
              hit.point.x,
              hit.point.y + FLOOR_OFFSET,
              hit.point.z
            );
            this._hasValidPosition = true;
          }
        }

        // Always follow X/Z immediately, lerp Y toward raycast result
        if (this._hasValidPosition) {
          const lerpFactor = 1 - Math.exp(-POSITION_LERP_SPEED * deltaTime);
          this._currentPos.x = this._targetPos.x;
          this._currentPos.z = this._targetPos.z;
          this._currentPos.y +=
            (this._shadowTargetPos.y - this._currentPos.y) * lerpFactor;
          this.mesh.position.copy(this._currentPos);
        } else {
          this.mesh.position.set(
            this._targetPos.x,
            this._targetPos.y - 0.3,
            this._targetPos.z
          );
        }
      } else {
        // Simple mode: fixed offset below robot
        this.mesh.position.set(
          this._targetPos.x,
          this._targetPos.y - Y_BELOW_ROBOT,
          this._targetPos.z
        );
      }
    }
    // When jumping, position stays frozen (or at landing point if set)

    this.mesh.scale.setScalar(this.baseScale);

    // Fade opacity toward target
    if (this._opacity !== this._targetOpacity) {
      const delta = this._targetOpacity - this._opacity;
      const fadingIn = delta > 0;
      let fadeSpeed = FADE_SPEED;
      if (this._isJumping || this._targetOpacity === 0) {
        fadeSpeed = JUMP_FADE_OUT_SPEED;
      } else if (fadingIn) {
        fadeSpeed = JUMP_FADE_IN_SPEED;
      }
      const step = fadeSpeed * deltaTime;
      if (Math.abs(delta) < step) {
        this._opacity = this._targetOpacity;
      } else {
        this._opacity += Math.sign(delta) * step;
      }
      this.mesh.material.opacity = this._opacity;
    }

    this.mesh.visible = this._opacity > 0.01;
  }

  setJumping(isJumping) {
    this._isJumping = isJumping;
    this._targetOpacity = isJumping ? 0 : BASE_OPACITY;
  }

  setLandingPosition(x, y, z) {
    // Set shadow to appear at landing position before fading in
    this.mesh.position.set(x, y - Y_BELOW_ROBOT, z);
  }

  setOpacity(opacity) {
    this._opacity = opacity;
    this._targetOpacity = opacity;
    this.mesh.material.opacity = opacity;
  }

  dispose() {
    if (this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.mesh.geometry.dispose();
    this.mesh.material.map.dispose();
    this.mesh.material.dispose();
  }
}
