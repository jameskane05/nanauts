/**
 * VFXManager - Central manager for all VFX effects
 *
 * Initialized once in index.js and made available to all systems via world.vfxManager.
 * Systems can request VFX effects (portals, particles, etc.) through this manager.
 */

import { Logger } from "../utils/Logger.js";
import { PortalVFX } from "./PortalVFX.js";
import { BlobShadowVFX } from "./BlobShadowVFX.js";
import { CalmBurstVFX } from "./CalmBurstVFX.js";

export class VFXManager {
  constructor(world) {
    this.world = world;
    this.scene = world.scene;
    this.renderer = world.renderer;
    this.logger = new Logger("VFXManager", true);

    // Active VFX instances
    this.activeEffects = new Map();
    this.effectIdCounter = 0;

    // Blob shadows that need per-frame updates
    this.blobShadows = new Map();
    this._shadowFrameCounter = 0;
    this._cachedRaycastMeshes = [];
    this._lastMeshCacheTime = 0;

    // Store reference on world for easy access
    world.vfxManager = this;

    this.logger.log("VFXManager initialized");
  }

  /**
   * Create a portal VFX at the given position/orientation
   * @param {Object} options - Portal configuration
   * @param {Vector3} options.position - World position
   * @param {Quaternion} options.quaternion - World orientation
   * @param {Object} options.config - PortalVFX config overrides
   * @returns {Object} Portal handle with id, vfx instance, and control methods
   */
  createPortal(options = {}) {
    const { position, quaternion, config = {} } = options;

    const portalVFX = new PortalVFX({
      maxRadius: config.maxRadius || 0.3,
      primaryColor: config.primaryColor || 0x00ffff,
      secondaryColor: config.secondaryColor || 0x0088ff,
      glowIntensity: config.glowIntensity || 1.2,
      scanLineSpeed: config.scanLineSpeed || 2.0,
      particleCount: config.particleCount || 60,
      particleSpeed: config.particleSpeed || 1.5,
      ...config,
    });

    if (position) {
      portalVFX.setPosition(position);
    }
    if (quaternion) {
      portalVFX.setQuaternion(quaternion);
    }

    portalVFX.addToScene(this.scene);

    const id = `portal_${this.effectIdCounter++}`;
    const handle = {
      id,
      vfx: portalVFX,
      setProgress: (p) => portalVFX.setProgress(p),
      update: (dt) => portalVFX.update(dt),
      getStencilRef: () => portalVFX.getStencilRef(),
      dispose: () => this.disposeEffect(id),
    };

    this.activeEffects.set(id, {
      type: "portal",
      vfx: portalVFX,
      handle,
    });

    this.logger.log(`Portal created: ${id}`);
    return handle;
  }

  /**
   * Create a blob shadow for an object
   * @param {Object} options - Shadow configuration
   * @param {Object3D} options.target - The object to attach shadow to
   * @param {number} options.size - Shadow size (default 0.35)
   * @returns {Object} Shadow handle with id, vfx instance, and control methods
   */
  createBlobShadow(options = {}) {
    const { target, size } = options;

    if (!target) {
      this.logger.warn("createBlobShadow: no target provided");
      return null;
    }

    const shadowVFX = new BlobShadowVFX(
      this.renderer,
      this.scene,
      target,
      this.world,
      size
    );

    const id = `blobShadow_${this.effectIdCounter++}`;
    const handle = {
      id,
      vfx: shadowVFX,
      target,
      render: (dt) => shadowVFX.update(dt),
      setOpacity: (o) => shadowVFX.setOpacity(o),
      setJumping: (j) => shadowVFX.setJumping(j),
      setLandingPosition: (x, y, z) => shadowVFX.setLandingPosition(x, y, z),
      dispose: () => this.disposeEffect(id),
    };

    this.activeEffects.set(id, {
      type: "blobShadow",
      vfx: shadowVFX,
      handle,
      target,
    });

    this.blobShadows.set(id, { vfx: shadowVFX, target, handle });

    this.logger.log(`Blob shadow created: ${id}`);
    return handle;
  }

  /**
   * Create a one-shot particle burst at a position (auto-disposes)
   */
  createCalmBurst(position, config = {}) {
    const id = `calmBurst_${this.effectIdCounter++}`;

    const burstVFX = new CalmBurstVFX({
      ...config,
      onComplete: () => {
        this.disposeEffect(id);
      },
    });

    burstVFX.setPosition(position);
    burstVFX.addToScene(this.scene);

    this.activeEffects.set(id, {
      type: "calmBurst",
      vfx: burstVFX,
    });

    return id;
  }

  /**
   * Dispose a specific effect by ID
   */
  disposeEffect(id) {
    const effect = this.activeEffects.get(id);
    if (effect) {
      // Blob shadows remove themselves from parent in dispose()
      if (effect.type === "blobShadow") {
        effect.vfx.dispose();
      } else {
        effect.vfx.removeFromScene(this.scene);
        effect.vfx.dispose();
      }
      this.activeEffects.delete(id);
      this.blobShadows.delete(id);
      this.logger.log(`Effect disposed: ${id}`);
    }
  }

  /**
   * Update all active effects (call each frame)
   */
  update(deltaTime) {
    // Update raycast mesh cache every 500ms
    const now = performance.now();
    if (now - this._lastMeshCacheTime > 500) {
      this._lastMeshCacheTime = now;
      const navSystem = this.world?.navSurfacesSystem;
      if (navSystem) {
        this._cachedRaycastMeshes = navSystem.getRaycastMeshes(true);
      }
    }

    // Round-robin: only one blob shadow raycasts per frame
    const shadowArray = Array.from(this.blobShadows.values());
    const shadowCount = shadowArray.length;
    const raycastIndex =
      shadowCount > 0 ? this._shadowFrameCounter % shadowCount : -1;
    this._shadowFrameCounter++;

    // Update all effects
    let shadowIdx = 0;
    for (const [id, effect] of this.activeEffects) {
      if (effect.type === "blobShadow") {
        const shouldRaycast = shadowIdx === raycastIndex;
        effect.vfx.update(deltaTime, shouldRaycast, this._cachedRaycastMeshes);
        shadowIdx++;
      } else if (effect.vfx.update) {
        effect.vfx.update(deltaTime);
      }
    }
  }

  /**
   * Dispose all effects and cleanup
   */
  dispose() {
    for (const [id, effect] of this.activeEffects) {
      effect.vfx.removeFromScene(this.scene);
      effect.vfx.dispose();
    }
    this.activeEffects.clear();
    this.blobShadows.clear();
    this.logger.log("VFXManager disposed");
  }
}

export default VFXManager;
