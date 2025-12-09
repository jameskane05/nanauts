/**
 * EntropodMinigame.js - Flight path chase minigame
 *
 * Creates a looping flight path that curves around the MR room,
 * staying within the bounds of detected scene understanding meshes.
 * Path distance scales with room size.
 *
 * Activated when gameState.entropodMinigame becomes true (set by dialog).
 */

import {
  Vector3,
  CatmullRomCurve3,
  BufferGeometry,
  LineBasicMaterial,
  Line,
  Group,
  SphereGeometry,
  MeshBasicMaterial,
  Mesh,
  Matrix4,
  Quaternion,
} from "three";
import { Logger } from "./utils/Logger.js";
import { gameState, GAME_STATES } from "./gameState.js";
import { PortalAudio } from "./audio/PortalAudio.js";

export class EntropodMinigame {
  constructor(world) {
    this.world = world;
    this.logger = new Logger("EntropodMinigame", true);

    this.isActive = false;
    this.group = new Group();
    this.group.name = "entropod-minigame";

    // Flight path
    this.curve = null;
    this.pathLine = null;
    this.pathLength = 0;

    // Moving sphere (entropod)
    this.sphere = null;
    this.distanceTraveled = 0;
    this.speed = 1.0; // meters per second

    // Scoring
    this.captureCount = 0;
    this.captureGoal = 3;
    this.isEntropyActive = false;
    this.entropyStartTime = 0;
    this.nextEntropyTime = 0;
    this.onScoreUpdate = null;
    this.onMinigameComplete = null;

    // Path generation config
    this.config = {
      margin: 0.4, // Inset from walls
      minHeight: 0.8,
      maxHeight: 1.8,
      numControlPoints: 12,
      pathSegments: 100,
    };

    // Portal state
    this.portal = null; // { handle, audio, position, phase, startTime, closeStartTime }
    this.portalOpenDuration = 1.0;
    this.portalHoldDuration = 3.0; // How long portal stays open
    this.portalCloseDuration = 0.8;
    this.vacuumRadius = 4.0; // Start pulling at 4m (debug)
    this.captureRadius = 0.15; // Capture threshold
    this.vacuumStrength = 3.0; // Pull force multiplier
    this._savedOnEnvironmentSelect = null; // Store original callback

    if (world?.scene) {
      world.scene.add(this.group);
    }

    // Listen for state changes
    this._onStateChange = this._onStateChange.bind(this);
    gameState.on("state:changed", this._onStateChange);

    // Register on world for access
    if (world) {
      world.entropodMinigame = this;
    }
  }

  _onStateChange(newState, oldState) {
    // Mark pending when entropodMinigame flag is set
    if (newState.entropodMinigame && !oldState.entropodMinigame) {
      this._pendingStart = true;
      this.logger.log("Entropod minigame requested");
    }
  }

  start() {
    if (this.isActive) return;

    const bounds = this._getEnvironmentBounds();
    if (!bounds) {
      this.logger.warn("No environment bounds available - using defaults");
      this._createDefaultPath();
    } else {
      this._createFlightPath(bounds);
    }

    // Reset scoring
    this.captureCount = 0;
    this.isEntropyActive = false;
    this._scheduleNextEntropy();

    // Show score panel in entropy mode
    this._setupScorePanel();

    // Enable hit testing for portal placement
    this._setupHitTesting();

    this.isActive = true;
    this.group.visible = true;
    this.logger.log("Entropod minigame started");
  }

  _setupHitTesting() {
    const hitTestManager = this.world?.hitTestManager;
    if (!hitTestManager) return;

    // Save original callback
    this._savedOnEnvironmentSelect = hitTestManager.onEnvironmentSelect;

    // Set our callback for portal placement
    hitTestManager.onEnvironmentSelect = (pose) => {
      this._onPortalPlacement(pose);
    };

    // Enable hit testing
    hitTestManager.setEnabled(true);
    this.logger.log("Hit testing enabled for portal placement");
  }

  _onPortalPlacement(pose) {
    // Don't place if portal already active
    if (this.portal) {
      this.logger.log("Portal already active - ignoring placement");
      return;
    }

    // Don't place if no entropy active
    if (!this.isEntropyActive) {
      this.logger.log("No entropy active - ignoring placement");
      return;
    }

    // Extract position from pose matrix
    const matrix = new Matrix4();
    matrix.fromArray(pose.transform.matrix);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);

    // Raise portal slightly above floor
    const portalPosition = position.clone();
    portalPosition.y += 0.15;

    this._spawnPortal(portalPosition);

    // Disable hit testing while portal is active
    const hitTestManager = this.world?.hitTestManager;
    if (hitTestManager) {
      hitTestManager.setEnabled(false);
      hitTestManager.scaleOutAllPlacedVisuals?.();
    }
  }

  _spawnPortal(position) {
    // Create portal VFX
    const portalHandle = this.world.vfxManager?.createPortal({
      position: position,
      config: {
        maxRadius: 0.4,
        primaryColor: 0xff00ff, // Magenta to match entropod
        secondaryColor: 0x8800ff,
        glowIntensity: 1.5,
        scanLineSpeed: 3.0,
        particleCount: 40,
        particleSpeed: 2.0,
      },
    });

    // Create portal audio
    const portalAudio = new PortalAudio();
    portalAudio.setPosition(position.x, position.y, position.z);
    portalAudio.startEntrance();

    this.portal = {
      handle: portalHandle,
      audio: portalAudio,
      position: position.clone(),
      phase: "opening",
      startTime: performance.now(),
      closeStartTime: 0,
    };

    this.logger.log(
      `Portal spawned at ${position.x.toFixed(2)}, ${position.y.toFixed(
        2
      )}, ${position.z.toFixed(2)}`
    );
  }

  async _setupScorePanel() {
    const wristUI = this.world?.spatialUIManager;
    if (!wristUI) return;

    // Set up callbacks
    this.onScoreUpdate = (current, total) => {
      wristUI.updateScoreDisplay(current, total);
      wristUI.scoreUI?.flashCalmed(() => this.isEntropyActive);
    };

    this.onMinigameComplete = () => {
      wristUI.hideScorePanel();
      this.logger.log("Entropod minigame complete!");
      gameState.setState({ entropodMinigameCompleted: true });
    };

    // Show the panel first, then set mode and update display
    await wristUI.showScorePanel();
    wristUI.scoreUI?.setMode("entropy");
    wristUI.updateScoreDisplay(this.captureCount, this.captureGoal);
  }

  _scheduleNextEntropy() {
    // Random delay 3-8 seconds before next entropy event
    const delay = 3000 + Math.random() * 5000;
    this.nextEntropyTime = performance.now() + delay;
  }

  _startEntropy() {
    if (this.isEntropyActive) return;

    // Clean up any leftover portal from previous entropy
    if (this.portal) {
      this._disposePortal();
    }

    this.isEntropyActive = true;
    this.entropyStartTime = performance.now();

    // Spawn sphere if not already created
    if (!this.sphere) {
      this._createSphere();
    }

    // Change sphere to magenta when capturable
    if (this.sphere?.material) {
      this.sphere.material.color.setHex(0xff00ff);
    }
    if (this.sphere) {
      this.sphere.visible = true;
    }

    // Always enable hit testing when entropy starts
    const hitTestManager = this.world?.hitTestManager;
    if (hitTestManager) {
      hitTestManager.setEnabled(true);
    }

    // Notify UI
    const wristUI = this.world?.spatialUIManager;
    wristUI?.scoreUI?.setPanicking(() => this.isEntropyActive);

    this.logger.log("Entropy started - place a portal to capture!");
  }

  _endEntropy(captured) {
    if (!this.isEntropyActive) return;

    this.isEntropyActive = false;

    // Hide sphere until next entropy
    if (this.sphere) {
      this.sphere.visible = false;
    }

    // Note: Don't disable hit testing here - portal closing will handle that
    // Hit testing re-enables when next entropy starts

    if (captured) {
      this.captureCount++;
      this.logger.log(`Captured! (${this.captureCount}/${this.captureGoal})`);

      if (this.onScoreUpdate) {
        this.onScoreUpdate(this.captureCount, this.captureGoal);
      }

      if (this.captureCount >= this.captureGoal) {
        this._completeMinigame();
        return;
      }
    }

    this._scheduleNextEntropy();
  }

  _completeMinigame() {
    this.logger.log("Minigame complete!");
    if (this.onMinigameComplete) {
      this.onMinigameComplete();
    }
    this.stop();
  }

  stop() {
    if (!this.isActive) return;

    this.logger.log("Stopping Entropod minigame");
    this.isActive = false;
    this.group.visible = false;
    this.isEntropyActive = false;

    // Reset score panel to panic mode for next use
    const wristUI = this.world?.spatialUIManager;
    wristUI?.scoreUI?.setMode("panic");

    // Clean up portal
    this._disposePortal();

    // Restore original hit test callback and disable
    const hitTestManager = this.world?.hitTestManager;
    if (hitTestManager) {
      hitTestManager.onEnvironmentSelect = this._savedOnEnvironmentSelect;
      hitTestManager.setEnabled(false);
    }

    this._disposePath();
  }

  _disposePortal() {
    if (!this.portal) return;

    if (this.portal.handle) {
      this.portal.handle.dispose();
    }
    if (this.portal.audio) {
      this.portal.audio.stop();
    }
    this.portal = null;
  }

  _getEnvironmentBounds() {
    const navSurfaces = this.world?.navSurfacesSystem;
    if (!navSurfaces?.environmentBounds) {
      return null;
    }

    const bounds = navSurfaces.environmentBounds;
    const min = bounds.min;
    const max = bounds.max;

    this.logger.log(
      `Environment bounds: (${min.x.toFixed(2)}, ${min.y.toFixed(
        2
      )}, ${min.z.toFixed(2)}) to (${max.x.toFixed(2)}, ${max.y.toFixed(
        2
      )}, ${max.z.toFixed(2)})`
    );

    return { min, max };
  }

  _createFlightPath(bounds) {
    const { min, max } = bounds;
    const margin = this.config.margin;

    const center = new Vector3((min.x + max.x) / 2, 0, (min.z + max.z) / 2);

    // Usable room dimensions (with margin from walls)
    const roomW = max.x - min.x - margin * 2;
    const roomD = max.z - min.z - margin * 2;
    const halfW = roomW / 2;
    const halfD = roomD / 2;

    const minY = Math.max(min.y + this.config.minHeight, this.config.minHeight);
    const maxY = Math.min(max.y - 0.3, this.config.maxHeight);
    const centerY = (minY + maxY) / 2;
    const yRange = (maxY - minY) / 2;

    this.logger.log(
      `Room: ${roomW.toFixed(1)}x${roomD.toFixed(1)}m, Y: ${minY.toFixed(
        1
      )}-${maxY.toFixed(1)}`
    );

    const points = [];
    const numPoints = this.config.numControlPoints;

    // Figure-8 pattern scaled to 60% of room size (leaves margin)
    const scale = 0.6;
    for (let i = 0; i < numPoints; i++) {
      const t = i / numPoints;
      const angle = t * Math.PI * 2;

      // Lemniscate (figure-8) in normalized coords
      const denom = 1 + Math.sin(angle) * Math.sin(angle);
      const nx = Math.sin(angle) / denom;
      const nz = (Math.sin(angle) * Math.cos(angle)) / denom;

      const x = center.x + nx * halfW * scale * 1.5;
      const z = center.z + nz * halfD * scale * 2;
      const y = centerY + Math.sin(angle * 2) * yRange * 0.5;

      points.push(new Vector3(x, Math.max(minY, Math.min(maxY, y)), z));
    }

    // Use lower tension to keep curve tighter to control points
    this.curve = new CatmullRomCurve3(points, true, "catmullrom", 0.3);
    this.pathLength = this.curve.getLength();

    this.logger.log(`Flight path: ${this.pathLength.toFixed(1)}m`);
    this._createPathLine();
  }

  _createDefaultPath() {
    const player = this.world?.player;
    let startPos = new Vector3(0, 1.2, -2);

    if (player?.head) {
      player.head.getWorldPosition(startPos);
      startPos.y = 1.2;
      startPos.z -= 2;
    }

    const controlPoints = [];
    const radius = 1.5;
    const numPoints = 8;

    for (let i = 0; i < numPoints; i++) {
      const t = i / numPoints;
      const angle = t * Math.PI * 2;
      const x = startPos.x + Math.sin(angle) * radius;
      const z = startPos.z + Math.cos(angle) * radius;
      const y = startPos.y + Math.sin(angle * 2) * 0.4;
      controlPoints.push(new Vector3(x, y, z));
    }

    this.curve = new CatmullRomCurve3(controlPoints, true, "catmullrom", 0.5);
    this.pathLength = this.curve.getLength();

    this.logger.log(`Default path created: ${this.pathLength.toFixed(2)}m`);
    this._createPathLine();
  }

  _createPathLine() {
    if (!this.curve) return;

    const points = this.curve.getPoints(this.config.pathSegments);
    const geometry = new BufferGeometry().setFromPoints(points);

    const material = new LineBasicMaterial({
      color: 0xffffff,
      linewidth: 2,
      transparent: true,
      opacity: 0.8,
    });

    this.pathLine = new Line(geometry, material);
    this.pathLine.frustumCulled = false;
    this.group.add(this.pathLine);

    this.logger.log("Path visualization created (white line)");
  }

  _createSphere() {
    const geometry = new SphereGeometry(0.08, 16, 16);
    const material = new MeshBasicMaterial({ color: 0xff0000 });
    this.sphere = new Mesh(geometry, material);
    this.sphere.frustumCulled = false;
    this.group.add(this.sphere);

    // Position at start
    const startPos = this.curve.getPointAt(0);
    this.sphere.position.copy(startPos);
    this.distanceTraveled = 0;
  }

  _disposePath() {
    if (this.pathLine) {
      this.pathLine.geometry?.dispose();
      this.pathLine.material?.dispose();
      this.group.remove(this.pathLine);
      this.pathLine = null;
    }
    if (this.sphere) {
      this.sphere.geometry?.dispose();
      this.sphere.material?.dispose();
      this.group.remove(this.sphere);
      this.sphere = null;
    }
    this.curve = null;
    this.pathLength = 0;
    this.distanceTraveled = 0;
  }

  getPointAtDistance(distance) {
    if (!this.curve || this.pathLength === 0) return null;
    const t = (distance % this.pathLength) / this.pathLength;
    return this.curve.getPointAt(t);
  }

  getTangentAtDistance(distance) {
    if (!this.curve || this.pathLength === 0) return null;
    const t = (distance % this.pathLength) / this.pathLength;
    return this.curve.getTangentAt(t);
  }

  update(deltaTime) {
    // Check if we should start (waiting for XR + scene understanding)
    if (this._pendingStart && !this.isActive) {
      const state = gameState.getState();
      const isXRActive = state.currentState >= GAME_STATES.XR_ACTIVE;
      const hasBounds =
        this.world?.navSurfacesSystem?.environmentBounds != null;

      if (isXRActive && hasBounds) {
        this._pendingStart = false;
        this.start();
      }
    }

    if (!this.isActive) return;

    const now = performance.now();

    // Check if it's time to start entropy (only if not already active)
    if (!this.isEntropyActive && now >= this.nextEntropyTime) {
      this._startEntropy();
    }

    // Update portal animation
    this._updatePortal(deltaTime, now);

    // Move sphere along path (with vacuum effect if portal active)
    if (
      this.sphere &&
      this.sphere.visible &&
      this.curve &&
      this.pathLength > 0
    ) {
      // Normal path movement
      this.distanceTraveled += this.speed * deltaTime;
      const t = (this.distanceTraveled % this.pathLength) / this.pathLength;
      const pathPos = this.curve.getPointAt(t);

      // Apply vacuum effect if portal is open
      if (this.portal && this.portal.phase === "open") {
        const toPortal = new Vector3().subVectors(
          this.portal.position,
          this.sphere.position
        );
        const dist = toPortal.length();

        if (dist < this.vacuumRadius) {
          // How much to pull: 0 at edge of vacuum, 1 at center
          // Using squared falloff for more dramatic pull near center
          const t = 1 - dist / this.vacuumRadius;
          const pullFactor = t * t; // Squared for acceleration toward center

          // Smoothly blend sphere position toward portal
          // At edge (pullFactor ~0): follow path normally
          // Near center (pullFactor ~1): move directly toward portal
          const targetPos = new Vector3().lerpVectors(
            pathPos,
            this.portal.position,
            pullFactor
          );

          // Move sphere toward target (smoothed by deltaTime)
          const moveSpeed = this.vacuumStrength * (0.5 + pullFactor * 2);
          this.sphere.position.lerp(
            targetPos,
            Math.min(1, moveSpeed * deltaTime)
          );

          // Check for capture
          if (dist < this.captureRadius) {
            this._captureEntropod();
            return;
          }
        } else {
          this.sphere.position.copy(pathPos);
        }
      } else {
        this.sphere.position.copy(pathPos);
      }
    }
  }

  _updatePortal(deltaTime, now) {
    if (!this.portal) return;

    const elapsed = (now - this.portal.startTime) / 1000;

    // Update VFX
    if (this.portal.handle) {
      this.portal.handle.update(deltaTime);
    }

    if (this.portal.phase === "opening") {
      const progress = Math.min(1, elapsed / this.portalOpenDuration);
      const eased = this._easeOutBack(progress);

      if (this.portal.handle) {
        this.portal.handle.setProgress(eased);
      }
      if (this.portal.audio) {
        this.portal.audio.updateEntrance(progress, eased);
      }

      if (progress >= 1) {
        this.portal.phase = "open";
        this.portal.openTime = now;
        this.logger.log("Portal fully open");
      }
    } else if (this.portal.phase === "open") {
      const openElapsed = (now - this.portal.openTime) / 1000;

      // Start closing after hold duration
      if (openElapsed >= this.portalHoldDuration) {
        this.portal.phase = "closing";
        this.portal.closeStartTime = now;
        this.logger.log("Portal closing");
      }
    } else if (this.portal.phase === "closing") {
      const closeElapsed = (now - this.portal.closeStartTime) / 1000;
      const progress = Math.min(1, closeElapsed / this.portalCloseDuration);

      if (this.portal.handle) {
        this.portal.handle.setProgress(1 - this._easeInCubic(progress));
      }

      if (progress >= 1) {
        this._disposePortal();

        // If entropy is still active (portal closed without capture), re-enable placement
        if (this.isEntropyActive) {
          const hitTestManager = this.world?.hitTestManager;
          if (hitTestManager) {
            hitTestManager.setEnabled(true);
          }
          // Reset entropy timer so player has time for another attempt
          this.entropyStartTime = performance.now();
          this.logger.log("Portal closed without capture - try again!");
        } else {
          this.logger.log("Portal closed");
        }
      }
    }
  }

  _captureEntropod() {
    this.logger.log("Entropod captured by portal!");

    // Hide the sphere
    if (this.sphere) {
      this.sphere.visible = false;
    }

    // Start portal closing immediately
    if (this.portal) {
      this.portal.phase = "closing";
      this.portal.closeStartTime = performance.now();
    }

    // Count as capture
    this._endEntropy(true);
  }

  _easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  _easeInCubic(t) {
    return t * t * t;
  }

  dispose() {
    gameState.off("state:changed", this._onStateChange);
    this.stop();
    if (this.world?.scene) {
      this.world.scene.remove(this.group);
    }
    this.group.clear();
  }
}

export default EntropodMinigame;
