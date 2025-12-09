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
  MeshStandardMaterial,
  Mesh,
  Matrix4,
  Quaternion,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
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

    // Moving entropod (snake-like creature)
    this.sphere = null; // Head sphere (for compatibility)
    this.segments = []; // All segments including head
    this.segmentCount = 6; // Head + 5 body segments
    this.segmentSpacing = 0.12; // Distance between segment centers
    this.headRadius = 0.08;
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
    this._firstEntropyPlayed = false;

    // Path generation config
    this.config = {
      margin: 0.6, // Inset from walls
      minHeight: 0.8,
      maxHeight: 1.8,
      numControlPoints: 12,
      pathSegments: 100,
    };

    // Randomized path parameters (regenerated each spawn)
    this._pathVariation = {
      pattern: 0, // 0=figure8, 1=oval, 2=trefoil
      scale: 0.6,
      rotation: 0,
      heightAmp: 0.5,
      tension: 0.3,
      startOffset: 0,
    };

    // Portal state
    this.portal = null; // { handle, audio, position, phase, startTime, closeStartTime }
    this.portalOpenDuration = 1.0;
    this.portalHoldDuration = 3.0; // How long portal stays open
    this.portalCloseDuration = 0.8;
    this.vacuumRadius = 4.0; // Horizontal pull radius (xz plane)
    this.vacuumHeight = 6.0; // Vertical pull height (y axis)
    this.captureRadius = 0.15; // Capture threshold
    this.vacuumStrength = 3.0; // Pull force multiplier
    this._savedOnEnvironmentSelect = null; // Store original callback

    // Placement line VFX (from hand to hit point)
    this._placementLine = null;
    this._placementLineParticles = null;
    this._lineActiveColor = new Color(0x00ff88); // Green when can place
    this._lineInactiveColor = new Color(0x444444); // Grey when inactive
    this._lineParticleTexture = null;
    this._lineTime = 0;
    this._lineExtent = 0; // 0 = at hand, 1 = fully extended to hit point
    this._lineExtentTarget = 0; // What we're lerping towards
    this._lineExtentSpeed = 4.0; // Lerp speed

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

    // Switch from world call panel to HUD call panel (like panic minigame does)
    const wristUI = this.world?.aiManager?.wristUI;
    if (wristUI) {
      wristUI.switchToHUDCallPanel();
    }

    // Store bounds for path regeneration
    this._bounds = this._getEnvironmentBounds();
    if (!this._bounds) {
      this.logger.warn("No environment bounds available - using defaults");
    }

    // Reset scoring
    this.captureCount = 0;
    this.isEntropyActive = false;
    this._firstEntropyPlayed = false;
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

    // Save original callback and colors
    this._savedOnEnvironmentSelect = hitTestManager.onEnvironmentSelect;
    this._savedValidColor = hitTestManager._validColor;
    this._savedInvalidColor = hitTestManager._invalidColor;

    // Set our callback for portal placement
    hitTestManager.onEnvironmentSelect = (pose) => {
      this._onPortalPlacement(pose);
    };

    // Enable hit testing - stays enabled throughout minigame
    hitTestManager.setEnabled(true);

    // Start greyed out until entropy spawns
    this._setReticleActive(false);

    // Create placement line VFX
    this._createPlacementLineVFX();

    this.logger.log("Hit testing enabled for portal placement");
  }

  _setReticleActive(active) {
    const hitTestManager = this.world?.hitTestManager;
    if (!hitTestManager) return;

    if (active) {
      // Restore normal colors
      hitTestManager._validColor = this._savedValidColor || 0x00ff88;
      hitTestManager._invalidColor = this._savedInvalidColor || 0x666666;
    } else {
      // Grey out - both valid and invalid show as grey
      hitTestManager._validColor = 0x444444;
      hitTestManager._invalidColor = 0x444444;
    }
  }

  _createPlacementLineVFX() {
    if (this._placementLine) return;

    // Create particle texture
    if (!this._lineParticleTexture) {
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
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      this._lineParticleTexture = new CanvasTexture(canvas);
    }

    // Create line geometry
    const lineGeo = new BufferGeometry();
    const positions = new Float32Array(6);
    lineGeo.setAttribute("position", new Float32BufferAttribute(positions, 3));

    const lineMat = new LineBasicMaterial({
      color: this._lineActiveColor,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
    });

    this._placementLine = new Line(lineGeo, lineMat);
    this._placementLine.renderOrder = 500;
    this._placementLine.visible = false;
    this.world.scene.add(this._placementLine);

    // Create particles along the line
    const particleCount = 12;
    const particleGeo = new BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    const particleColors = new Float32Array(particleCount * 3);
    particleGeo.setAttribute(
      "position",
      new Float32BufferAttribute(particlePositions, 3)
    );
    particleGeo.setAttribute(
      "color",
      new Float32BufferAttribute(particleColors, 3)
    );

    const particleMat = new PointsMaterial({
      size: 0.015,
      map: this._lineParticleTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      blending: 2, // AdditiveBlending
      sizeAttenuation: true,
    });

    this._placementLineParticles = new Points(particleGeo, particleMat);
    this._placementLineParticles.renderOrder = 501;
    this._placementLineParticles.visible = false;
    this.world.scene.add(this._placementLineParticles);
  }

  _updatePlacementLineVFX(delta) {
    const hitTestManager = this.world?.hitTestManager;
    if (!hitTestManager || !this._placementLine) {
      return;
    }

    const hitPose = hitTestManager.lastHitPose?.right;
    const xrInputSystem = this.world?.xrInputSystem;

    // Get controller ray
    const ray = xrInputSystem?.getPreferredControllerRay?.();
    if (!ray) {
      this._placementLine.visible = false;
      this._placementLineParticles.visible = false;
      return;
    }

    const startPos = ray.position;
    let fullHitPos;

    if (hitPose) {
      const hitMatrix = new Matrix4().fromArray(hitPose.transform.matrix);
      fullHitPos = new Vector3();
      fullHitPos.setFromMatrixPosition(hitMatrix);
    } else {
      fullHitPos = startPos
        .clone()
        .add(ray.direction.clone().multiplyScalar(3.0));
    }

    // Determine target extent: 1 = fully extended when can place, 0 = retracted
    const canPlace = this.isEntropyActive && !this.portal;
    this._lineExtentTarget = canPlace ? 1.0 : 0.0;

    // Lerp extent towards target
    const extentDiff = this._lineExtentTarget - this._lineExtent;
    if (Math.abs(extentDiff) > 0.001) {
      this._lineExtent +=
        extentDiff * Math.min(1, this._lineExtentSpeed * delta);
    } else {
      this._lineExtent = this._lineExtentTarget;
    }

    // Calculate actual end position based on extent
    const hitPos = new Vector3().lerpVectors(
      startPos,
      fullHitPos,
      this._lineExtent
    );

    // Update line positions
    const linePositions =
      this._placementLine.geometry.attributes.position.array;
    linePositions[0] = startPos.x;
    linePositions[1] = startPos.y;
    linePositions[2] = startPos.z;
    linePositions[3] = hitPos.x;
    linePositions[4] = hitPos.y;
    linePositions[5] = hitPos.z;
    this._placementLine.geometry.attributes.position.needsUpdate = true;

    // Update line color based on state
    const lineColor = canPlace
      ? this._lineActiveColor
      : this._lineInactiveColor;
    this._placementLine.material.color.copy(lineColor);
    this._placementLine.visible = this._lineExtent > 0.01;

    // Update particles (only visible when extended)
    this._lineTime += delta;
    const particlePositions =
      this._placementLineParticles.geometry.attributes.position.array;
    const particleColors =
      this._placementLineParticles.geometry.attributes.color.array;
    const particleCount = particlePositions.length / 3;

    for (let i = 0; i < particleCount; i++) {
      // Scale t by extent so particles stay within the visible line
      const baseT = (i / particleCount + this._lineTime * 0.8) % 1.0;
      const t = baseT * this._lineExtent;
      particlePositions[i * 3] = startPos.x + (fullHitPos.x - startPos.x) * t;
      particlePositions[i * 3 + 1] =
        startPos.y + (fullHitPos.y - startPos.y) * t;
      particlePositions[i * 3 + 2] =
        startPos.z + (fullHitPos.z - startPos.z) * t;
      particleColors[i * 3] = lineColor.r;
      particleColors[i * 3 + 1] = lineColor.g;
      particleColors[i * 3 + 2] = lineColor.b;
    }

    this._placementLineParticles.geometry.attributes.position.needsUpdate = true;
    this._placementLineParticles.geometry.attributes.color.needsUpdate = true;
    this._placementLineParticles.visible = this._lineExtent > 0.01;
  }

  _disposePlacementLineVFX() {
    if (this._placementLine) {
      this._placementLine.geometry?.dispose();
      this._placementLine.material?.dispose();
      this.world.scene?.remove(this._placementLine);
      this._placementLine = null;
    }
    if (this._placementLineParticles) {
      this._placementLineParticles.geometry?.dispose();
      this._placementLineParticles.material?.dispose();
      this.world.scene?.remove(this._placementLineParticles);
      this._placementLineParticles = null;
    }
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

    // Grey out reticle while portal is active (but don't disable - keeps visuals)
    this._setReticleActive(false);

    const hitTestManager = this.world?.hitTestManager;
    hitTestManager?.scaleOutAllPlacedVisuals?.();
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

  _randomizePathVariation() {
    const v = this._pathVariation;
    v.pattern = Math.floor(Math.random() * 3); // 0, 1, or 2
    v.scale = 0.35 + Math.random() * 0.25; // 0.35 - 0.6
    v.rotation = Math.random() * Math.PI * 2; // 0 - 2π
    v.heightAmp = 0.3 + Math.random() * 0.5; // 0.3 - 0.8
    v.tension = 0.2 + Math.random() * 0.3; // 0.2 - 0.5
    v.startOffset = Math.random(); // 0 - 1 (where on path to start)

    const patterns = ["figure-8", "oval", "trefoil"];
    this.logger.log(
      `Path variation: ${patterns[v.pattern]}, scale=${v.scale.toFixed(2)}, ` +
        `rot=${((v.rotation * 180) / Math.PI).toFixed(0)}°`
    );
  }

  _startEntropy() {
    if (this.isEntropyActive) return;

    // Clean up any leftover portal from previous entropy
    if (this.portal) {
      this._disposePortal();
    }

    // Randomize and regenerate the flight path
    this._randomizePathVariation();
    this._disposePath();
    if (this._bounds) {
      this._createFlightPath(this._bounds);
    } else {
      this._createDefaultPath();
    }
    this._createSphere();

    // Apply start offset to distance traveled
    this.distanceTraveled = this._pathVariation.startOffset * this.pathLength;

    this.isEntropyActive = true;
    this.entropyStartTime = performance.now();

    // Make all segments visible
    for (const segment of this.segments) {
      segment.visible = true;
    }

    // Activate reticle (green when valid) for portal placement
    this._setReticleActive(true);

    // Notify UI
    const wristUI = this.world?.spatialUIManager;
    wristUI?.scoreUI?.setPanicking(() => this.isEntropyActive);

    // Trigger first entropod dialog via game state criteria
    if (!this._firstEntropyPlayed) {
      this._firstEntropyPlayed = true;
      gameState.setState({ firstEntropodSpawned: true });
    }

    this.logger.log("Entropy started - place a portal to capture!");
  }

  _endEntropy(captured) {
    if (!this.isEntropyActive) return;

    this.isEntropyActive = false;

    // Hide all segments until next entropy
    for (const segment of this.segments) {
      segment.visible = false;
    }

    // Grey out reticle until next entropy (but keep it visible)
    this._setReticleActive(false);

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

    // Trigger robot celebration - look at player, happy jumps, faces, voices
    this._triggerRobotCelebration();

    if (this.onMinigameComplete) {
      this.onMinigameComplete();
    }
    this.stop();
  }

  _triggerRobotCelebration() {
    const robotSystem = this.world?.robotSystem;
    if (!robotSystem) return;

    const player = this.world?.player;
    const playerPos = player?.head?.getWorldPosition?.(new Vector3());

    // Get all robot entities
    const robotEntities = robotSystem.robotEntities;
    if (!robotEntities) return;

    for (const [entityIndex] of robotEntities) {
      // Make robot look at player
      if (playerPos) {
        const lookTarget = robotSystem.robotStates?.get(entityIndex);
        if (lookTarget) {
          lookTarget.lookAtTarget = playerPos.clone();
          lookTarget.lookAtStartTime = performance.now();
          lookTarget.lookAtDuration = 4000; // 4 seconds
        }
      }

      // Set excited face
      robotSystem.setRobotFaceEmotion?.(entityIndex, "excited");

      // Play happy voice with slight random delay
      const voice = robotSystem.audioManager?.getVoice(entityIndex);
      if (voice) {
        setTimeout(() => voice.happy?.(), Math.random() * 300);
      }

      // Trigger happy bounce animation with staggered timing
      setTimeout(() => {
        robotSystem.interactionManager?.triggerSoloAnimation(
          entityIndex,
          "happyBounce"
        );
      }, 200 + Math.random() * 500);
    }

    // After celebration, resume normal wandering
    setTimeout(() => {
      for (const [entityIndex] of robotEntities) {
        robotSystem.setRobotFaceEmotion?.(entityIndex, "content");
        const state = robotSystem.robotStates?.get(entityIndex);
        if (state) {
          state.lookAtTarget = null;
        }
      }
    }, 4000);
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

    // Restore original hit test callback, colors, and disable
    const hitTestManager = this.world?.hitTestManager;
    if (hitTestManager) {
      hitTestManager.onEnvironmentSelect = this._savedOnEnvironmentSelect;
      hitTestManager._validColor = this._savedValidColor || 0x00ff88;
      hitTestManager._invalidColor = this._savedInvalidColor || 0x666666;
      hitTestManager.setEnabled(false);
    }

    // Clean up placement line VFX
    this._disposePlacementLineVFX();

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
    const v = this._pathVariation;
    const cosR = Math.cos(v.rotation);
    const sinR = Math.sin(v.rotation);

    for (let i = 0; i < numPoints; i++) {
      const t = i / numPoints;
      const angle = t * Math.PI * 2;

      let nx, nz;

      if (v.pattern === 0) {
        // Figure-8 (lemniscate)
        const denom = 1 + Math.sin(angle) * Math.sin(angle);
        nx = Math.sin(angle) / denom;
        nz = (Math.sin(angle) * Math.cos(angle)) / denom;
      } else if (v.pattern === 1) {
        // Oval/ellipse
        nx = Math.cos(angle) * 0.7;
        nz = Math.sin(angle);
      } else {
        // Trefoil (3-lobed clover)
        const r = 0.5 + 0.5 * Math.cos(3 * angle);
        nx = r * Math.cos(angle);
        nz = r * Math.sin(angle);
      }

      // Apply rotation
      const rx = nx * cosR - nz * sinR;
      const rz = nx * sinR + nz * cosR;

      const x = center.x + rx * halfW * v.scale;
      const z = center.z + rz * halfD * v.scale;
      const y = centerY + Math.sin(angle * 2) * yRange * v.heightAmp;

      points.push(new Vector3(x, Math.max(minY, Math.min(maxY, y)), z));
    }

    this.curve = new CatmullRomCurve3(points, true, "catmullrom", v.tension);
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
    // Get environment map from robot system
    const envMap = this.world?.robotSystem?.envMapLoader?.envMap || null;

    // Create metallic material for body segments
    const bodyMaterial = new MeshStandardMaterial({
      color: 0xffffff,
      metalness: 1.0,
      roughness: 0.0,
      envMap: envMap,
      envMapIntensity: 1.5,
    });

    // Create segments (head is first, followed by smaller body segments)
    this.segments = [];
    for (let i = 0; i < this.segmentCount; i++) {
      // Each segment gets progressively smaller
      const sizeFactor = 1 - (i / this.segmentCount) * 0.6;
      const radius = this.headRadius * sizeFactor;

      const geometry = new SphereGeometry(radius, 16, 16);
      const segment = new Mesh(geometry, bodyMaterial.clone());
      segment.frustumCulled = false;
      this.group.add(segment);
      this.segments.push(segment);
    }

    // Head is the first segment
    this.sphere = this.segments[0];

    // Position at start
    const startPos = this.curve.getPointAt(0);
    for (const segment of this.segments) {
      segment.position.copy(startPos);
    }
    this.distanceTraveled = 0;
  }

  _disposePath() {
    if (this.pathLine) {
      this.pathLine.geometry?.dispose();
      this.pathLine.material?.dispose();
      this.group.remove(this.pathLine);
      this.pathLine = null;
    }
    // Dispose all segments
    for (const segment of this.segments) {
      segment.geometry?.dispose();
      segment.material?.dispose();
      this.group.remove(segment);
    }
    this.segments = [];
    this.sphere = null;

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

    // Ensure hit testing stays enabled (other systems might disable it)
    const hitTestManager = this.world?.hitTestManager;
    if (hitTestManager && !hitTestManager.enabled) {
      hitTestManager.setEnabled(true);
      this._setReticleActive(this.isEntropyActive && !this.portal);
    }

    // Update placement line VFX
    this._updatePlacementLineVFX(deltaTime);

    const now = performance.now();

    // Check if it's time to start entropy (only if not already active)
    if (!this.isEntropyActive && now >= this.nextEntropyTime) {
      this._startEntropy();
    }

    // Update portal animation
    this._updatePortal(deltaTime, now);

    // Move entropod along path (with vacuum effect if portal active)
    if (
      this.sphere &&
      this.sphere.visible &&
      this.curve &&
      this.pathLength > 0
    ) {
      // Normal path movement
      this.distanceTraveled += this.speed * deltaTime;

      // Position each segment along the path, trailing behind the head
      for (let i = 0; i < this.segments.length; i++) {
        const segment = this.segments[i];
        const segmentDistance = this.distanceTraveled - i * this.segmentSpacing;
        const segT =
          (((segmentDistance % this.pathLength) + this.pathLength) %
            this.pathLength) /
          this.pathLength;
        const segPos = this.curve.getPointAt(segT);

        // Apply vacuum effect if portal is open (only affects visible segments)
        if (this.portal && this.portal.phase === "open") {
          const toPortal = new Vector3().subVectors(
            this.portal.position,
            segment.position
          );
          // Cylindrical check: horizontal distance (xz) and vertical distance (y)
          const horizDist = Math.sqrt(
            toPortal.x * toPortal.x + toPortal.z * toPortal.z
          );
          const vertDist = Math.abs(toPortal.y);

          if (
            horizDist < this.vacuumRadius &&
            vertDist < this.vacuumHeight / 2
          ) {
            const horizT = 1 - horizDist / this.vacuumRadius;
            const vertT = 1 - vertDist / (this.vacuumHeight / 2);
            const pullT = Math.min(horizT, vertT);
            const pullFactor = pullT * pullT;

            const targetPos = new Vector3().lerpVectors(
              segPos,
              this.portal.position,
              pullFactor
            );

            const moveSpeed = this.vacuumStrength * (0.5 + pullFactor * 2);
            segment.position.lerp(
              targetPos,
              Math.min(1, moveSpeed * deltaTime)
            );
          } else {
            segment.position.copy(segPos);
          }
        } else {
          segment.position.copy(segPos);
        }
      }

      // Orient head to look in direction of travel
      const headT = (this.distanceTraveled % this.pathLength) / this.pathLength;
      const tangent = this.curve.getTangentAt(headT);
      if (tangent) {
        // Create rotation to face tangent direction
        const up = new Vector3(0, 1, 0);
        const lookTarget = this.sphere.position.clone().add(tangent);
        this.sphere.lookAt(lookTarget);
      }

      // Check for capture (head proximity to portal)
      if (this.portal && this.portal.phase === "open") {
        const dist = this.sphere.position.distanceTo(this.portal.position);
        if (dist < this.captureRadius) {
          this._captureEntropod();
          return;
        }
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
          this._setReticleActive(true);
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

    // Hide all segments
    for (const segment of this.segments) {
      segment.visible = false;
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
