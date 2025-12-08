/**
 * RobotSpawnerSystem.js - Portal-based robot spawning and goal placement
 * =============================================================================
 *
 * ROLE: ECS system handling robot spawning via animated portals. Creates the
 * dramatic entrance sequence where robots rise up through glowing portals.
 * Also handles goal marker placement for directing robot navigation.
 *
 * SPAWNING FLOW:
 *   1. User triggers spawn (controller trigger press on valid surface)
 *   2. Portal animation opens at hit point
 *   3. Multiple robots (configurable) rise up through portal sequentially
 *   4. Portal closes after all robots spawned
 *
 * MODES:
 *   - "spawning": First trigger creates spawn portal
 *   - "goal_placement": Subsequent triggers place navigation goal marker
 *
 * KEY METHODS:
 *   - spawnAtPose(pose): Create portal and spawn robots at given pose
 *   - placeGoalAtPose(pose): Place goal marker for robots to navigate to
 *   - preloadRobotModel(): Cache GLTF for instant spawning
 *
 * PORTAL ANIMATION: Uses stencil buffer for clean edge rendering. Portal is
 * ring geometry that scales up/down. Robots use custom rise animation.
 *
 * INTEGRATION:
 *   - Registers spawned robots with RobotSystem via world.robotSystem
 *   - Respects gameState.roomSetupRequired (won't spawn until room ready)
 *   - Supports debug auto-spawn via URL param ?gameState=ROBOTS_WANDERING
 *
 * KNOWN ISSUES:
 *   - Model cached globally, assumes all robots use same GLTF
 * =============================================================================
 */
import { createSystem } from "@iwsdk/core";
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  CircleGeometry,
  Vector3,
  Quaternion,
  Matrix4,
  EqualStencilFunc,
  KeepStencilOp,
  PlaneGeometry,
  ShaderMaterial,
  DoubleSide,
  AdditiveBlending,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  TextureLoader,
  Color,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Logger } from "../utils/Logger.js";
import { gameState, GAME_STATES } from "../gameState.js";
import { Robot } from "../components/Robot.js";
import {
  ROBOT_CHARACTERS,
  getCharacterByIndex,
} from "../data/robotCharacters.js";
import { PortalAudio } from "../audio/PortalAudio.js";

export class RobotSpawnerSystem extends createSystem({}) {
  init() {
    this.logger = new Logger("RobotSpawner", false);
    this.world.robotSpawnerSystem = this;

    this.enabled = false;
    this.portals = [];
    this.robots = [];
    this.gltfLoader = new GLTFLoader();

    // Cache models by character ID
    this.cachedModels = new Map(); // characterId -> scene

    // Portal animation settings (slower for more dramatic effect)
    this.portalMaxRadius = 0.3;
    this.portalOpenDuration = 3.6; // 3x longer for dramatic effect
    this.portalHoldDuration = 0.8;
    this.portalCloseDuration = 1.0;
    this.robotRiseDuration = 1.5;
    this.robotRiseHeight = 0.4;

    // Multi-robot spawn settings
    this.robotsPerPortal = 3;
    this.robotSpawnDelay = 2.0; // seconds between each robot spawn (enough to clear portal and not overlap)

    // Mode: 'spawning' (first trigger spawns portal) or 'goal_placement' (subsequent triggers place goal)
    this.mode = "spawning";
    this.initialPortalComplete = false;

    // Goal marker
    this.goalMarker = null;

    // Portal preview marker (blue reticle shown before dialog completes)
    this.portalPreview = null;
    this.portalPreviewPose = null;
    this._particleTexture = new TextureLoader().load(
      "./images/star-particle.png"
    );
    this._portalPreviewTime = 0;

    // Placement sound audio (separate from entrance audio)
    this._placementAudio = new PortalAudio();

    // Listen for intro completion to enable spawning
    this._setupGameStateListener();

    // Preload all robot models
    this._preloadRobotModels();

    // Debug auto-spawn flag
    this._debugAutoSpawnPending = false;
    this._debugAutoSpawnChecked = false;
  }

  _setupGameStateListener() {
    gameState.on("state:changed", (newState, oldState) => {
      this.logger.log(
        `State changed: currentState=${newState.currentState} (was ${oldState.currentState}), ` +
          `roomSetupRequired=${newState.roomSetupRequired} (was ${oldState.roomSetupRequired}), ` +
          `enabled=${this.enabled}`
      );

      // Enable spawning when entering PORTAL_PLACEMENT state AND room setup is done
      if (
        newState.currentState === GAME_STATES.PORTAL_PLACEMENT &&
        oldState.currentState !== GAME_STATES.PORTAL_PLACEMENT
      ) {
        if (newState.roomSetupRequired === false) {
          this.logger.log(
            "PORTAL_PLACEMENT state + room ready - robot spawning enabled"
          );
          this.enabled = true;
          if (this.world.hitTestManager) {
            this.world.hitTestManager.setEnabled(true);
          }
        } else {
          this.logger.log(
            `PORTAL_PLACEMENT state but room setup=${newState.roomSetupRequired} - spawning deferred`
          );
        }
      }

      // Enable spawning when room setup completes (if already in PORTAL_PLACEMENT)
      if (
        newState.roomSetupRequired === false &&
        oldState.roomSetupRequired !== false
      ) {
        this.logger.log(
          `Room setup complete! currentState=${newState.currentState}, enabled=${this.enabled}`
        );
        if (
          newState.currentState >= GAME_STATES.PORTAL_PLACEMENT &&
          !this.enabled
        ) {
          this.logger.log(
            "Room setup complete + PORTAL_PLACEMENT state - robot spawning enabled"
          );
          this.enabled = true;
          if (this.world.hitTestManager) {
            this.world.hitTestManager.setEnabled(true);
          }
        }
      }

      // Portal placement dialog completed - spawn at preview if one exists
      if (newState.portalPlacementPlayed && !oldState.portalPlacementPlayed) {
        this.logger.log("Portal placement dialog completed");
        if (
          this.portalPreviewPose &&
          !this.initialPortalComplete &&
          this.portals.length === 0
        ) {
          this.logger.log("Spawning portal at preview location");
          this._disposePortalPreview();
          if (this.world.hitTestManager) {
            this.world.hitTestManager.scaleOutAllPlacedVisuals();
          }
          this.spawnPortalAndRobots(this.portalPreviewPose);
          this.portalPreviewPose = null;
        }
      }
    });

    // Check initial state in case we debug spawned past intro
    const currentState = gameState.getState();
    this.logger.log(
      `Initial state check: currentState=${currentState.currentState}, ` +
        `roomSetupRequired=${currentState.roomSetupRequired}`
    );
    if (
      currentState.currentState >= GAME_STATES.PORTAL_PLACEMENT &&
      currentState.roomSetupRequired === false
    ) {
      this.logger.log(
        "Initial state has PORTAL_PLACEMENT+ and roomSetupRequired=false - robot spawning enabled"
      );
      this.enabled = true;
    }
  }

  async _preloadRobotModels() {
    const characters = Object.values(ROBOT_CHARACTERS);
    const loadPromises = characters.map(async (character) => {
      try {
        const gltf = await this.gltfLoader.loadAsync(character.modelUrl);
        this.cachedModels.set(character.id, gltf.scene);
        this.logger.log(
          `Model preloaded for ${character.name}: ${character.modelUrl}`
        );
      } catch (error) {
        this.logger.error(
          `Failed to preload model for ${character.name}:`,
          error
        );
      }
    });

    await Promise.all(loadPromises);
    this.logger.log(
      `All robot models preloaded (${this.cachedModels.size}/${characters.length})`
    );
  }

  spawnPortalAndRobots(pose) {
    const matrix = new Matrix4().fromArray(pose.transform.matrix);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);

    // Determine surface orientation from pose
    const surfaceNormal = new Vector3(0, 1, 0).applyQuaternion(quaternion);
    const isHorizontal = Math.abs(surfaceNormal.y) > 0.7;

    // Raise portal 0.15m along surface normal so tube emerges above floor
    // This helps avoid occlusion by the environment mesh
    const portalPosition = position
      .clone()
      .add(surfaceNormal.clone().multiplyScalar(0.02));

    this.logger.log(
      `Spawning portal with ${
        this.robotsPerPortal
      } robots at ${portalPosition.x.toFixed(2)}, ${portalPosition.y.toFixed(
        2
      )}, ${portalPosition.z.toFixed(2)} (raised 0.15m from hit)`
    );

    // Create portal VFX via the VFXManager
    // Don't pass quaternion - keep portal world-horizontal regardless of surface pitch
    const portalHandle = this.world.vfxManager?.createPortal({
      position: portalPosition,
      config: {
        maxRadius: this.portalMaxRadius,
        primaryColor: 0x00ffff,
        secondaryColor: 0x0088ff,
        glowIntensity: 1.2,
        scanLineSpeed: 2.0,
        particleCount: 60,
        particleSpeed: 1.5,
      },
    });

    if (!portalHandle) {
      this.logger.warn("VFXManager not available - portal VFX disabled");
    }

    // Create portal audio
    const portalAudio = new PortalAudio();
    portalAudio.setPosition(
      portalPosition.x,
      portalPosition.y,
      portalPosition.z
    );
    portalAudio.startEntrance();

    // Track portal state for animation - now with multiple robots
    const portalData = {
      portalHandle: portalHandle,
      portalAudio: portalAudio,
      position: portalPosition.clone(),
      floorPosition: position.clone(), // Original hit position for robot targets
      quaternion: quaternion.clone(),
      surfaceNormal: surfaceNormal.clone(),
      isHorizontal: isHorizontal,
      startTime: performance.now(),
      phase: "opening",
      robots: [],
      robotsToSpawn: this.robotsPerPortal,
      robotsSpawned: 0,
      lastRobotSpawnTime: 0,
    };

    this.portals.push(portalData);

    // Dispose portal preview (blue reticle) and disable hit testing
    this._disposePortalPreview();
    if (this.world.hitTestManager) {
      this.world.hitTestManager.setEnabled(false);
      this.world.hitTestManager.scaleOutAllPlacedVisuals();
    }

    return portalData;
  }

  // Called externally with a pose (e.g., from EnvironmentPlacer callback)
  spawnAtPose(pose) {
    if (!this.enabled) {
      this.logger.log("Spawning not enabled yet");
      return null;
    }

    // Block spawning during room capture
    const state = gameState.getState();
    if (state.roomSetupRequired !== false) {
      this.logger.log("Spawning blocked - room setup required");
      return null;
    }

    if (this.mode === "spawning") {
      // Prevent multiple portals - only allow one initial portal
      if (this.portals.length > 0 || this.initialPortalComplete) {
        this.logger.log("Portal already spawning or complete - ignoring");
        return null;
      }

      // Check if dialog has completed
      if (!state.portalPlacementPlayed) {
        // Dialog still playing - place/update preview marker
        this._placePortalPreview(pose);
        return null;
      }

      // Dialog complete - spawn immediately (clear preview if exists)
      if (this.portalPreview) {
        this._disposePortalPreview();
      }
      if (this.world.hitTestManager) {
        this.world.hitTestManager.scaleOutAllPlacedVisuals();
      }
      return this.spawnPortalAndRobots(pose);
    } else if (this.mode === "goal_placement") {
      return this.placeGoal(pose);
    }
    return null;
  }

  placeGoal(pose) {
    const matrix = new Matrix4().fromArray(pose.transform.matrix);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);

    this.logger.log(
      `Placing goal at ${position.x.toFixed(2)}, ${position.y.toFixed(
        2
      )}, ${position.z.toFixed(2)}`
    );

    // Remove old goal marker if exists
    if (this.goalMarker) {
      this._disposeGoalMarker();
    }

    // Create goal marker
    this.goalMarker = this._createGoalMarker(position);
    this.world.scene.add(this.goalMarker);

    // Tell robot system about the goal
    const robotSystem = this.world.robotSystem;
    if (robotSystem) {
      robotSystem.setGoal([position.x, position.y, position.z]);
      this.logger.log("Goal set on RobotSystem");
    }

    return this.goalMarker;
  }

  _createGoalMarker(position) {
    const group = new Group();
    group.position.copy(position);

    // Outer ring
    const outerRing = new Mesh(
      new RingGeometry(0.15, 0.18, 32),
      new MeshBasicMaterial({
        color: 0xff6600,
        transparent: true,
        opacity: 0.9,
        side: 2,
      })
    );
    outerRing.rotation.x = -Math.PI / 2;
    outerRing.position.y = 0.005;
    group.add(outerRing);

    // Inner ring
    const innerRing = new Mesh(
      new RingGeometry(0.05, 0.08, 32),
      new MeshBasicMaterial({
        color: 0xffaa00,
        transparent: true,
        opacity: 0.9,
        side: 2,
      })
    );
    innerRing.rotation.x = -Math.PI / 2;
    innerRing.position.y = 0.006;
    group.add(innerRing);

    // Center dot
    const centerDot = new Mesh(
      new CircleGeometry(0.02, 16),
      new MeshBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 1.0,
      })
    );
    centerDot.rotation.x = -Math.PI / 2;
    centerDot.position.y = 0.007;
    group.add(centerDot);

    group.userData.outerRing = outerRing;
    group.userData.innerRing = innerRing;
    group.userData.centerDot = centerDot;
    group.userData.startTime = performance.now();

    return group;
  }

  _disposeGoalMarker() {
    if (!this.goalMarker) return;

    const { outerRing, innerRing, centerDot } = this.goalMarker.userData;
    [outerRing, innerRing, centerDot].forEach((mesh) => {
      if (mesh) {
        mesh.geometry?.dispose();
        mesh.material?.dispose();
      }
    });

    if (this.goalMarker.parent) {
      this.goalMarker.parent.remove(this.goalMarker);
    }
    this.goalMarker = null;
  }

  clearGoal() {
    this._disposeGoalMarker();
    this.logger.log("Goal cleared");
  }

  _placePortalPreview(pose) {
    const matrix = new Matrix4().fromArray(pose.transform.matrix);
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    matrix.decompose(position, quaternion, scale);

    this.logger.log(
      `Placing portal preview at ${position.x.toFixed(2)}, ${position.y.toFixed(
        2
      )}, ${position.z.toFixed(2)}`
    );

    // Store pose for later spawning
    this.portalPreviewPose = pose;

    // Create or update preview marker
    if (!this.portalPreview) {
      this._portalPreviewTime = 0;
      this.portalPreview = this._createPortalPreviewMarker(position);
      this.world.scene.add(this.portalPreview);

      // Play placement sound
      this._placementAudio.setPosition(position.x, position.y, position.z);
      this._placementAudio.playPlacement();
    } else {
      this.portalPreview.position.copy(position);
      this._placementAudio.setPosition(position.x, position.y, position.z);
    }
  }

  _createPortalPreviewMarker(position) {
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
          
          gl_FragColor = vec4(color, alpha);
        }
      `,
      uniforms: {
        uTime: { value: 0 },
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
    disc.renderOrder = 500;
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
    group.userData.startTime = performance.now();

    return group;
  }

  _disposePortalPreview() {
    if (!this.portalPreview) return;

    const { disc, particles } = this.portalPreview.userData;
    if (disc) {
      disc.geometry?.dispose();
      disc.material?.dispose();
    }
    if (particles) {
      particles.geometry?.dispose();
      particles.material?.dispose();
    }

    if (this.portalPreview.parent) {
      this.portalPreview.parent.remove(this.portalPreview);
    }
    this.portalPreview = null;
  }

  async _spawnRobot(portalData) {
    // Get character for this robot based on spawn index
    const robotIndex = portalData.robotsSpawned;
    const character = getCharacterByIndex(robotIndex);

    // Get the cached model for this character
    const cachedScene = this.cachedModels.get(character.id);
    if (!cachedScene) {
      this.logger.warn(`Model not loaded for ${character.name}`);
      return null;
    }

    const robotGroup = cachedScene.clone(true);
    robotGroup.scale.set(0.3, 0.3, 0.3);

    // Store character info on the group for later use
    robotGroup.userData.characterId = character.id;
    robotGroup.userData.characterName = character.name;

    // Apply stencil test to robot materials so they're hidden below the portal
    const stencilRef = portalData.portalHandle?.getStencilRef() || 1;
    robotGroup.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        materials.forEach((mat) => {
          mat.stencilWrite = false;
          mat.stencilRef = stencilRef;
          mat.stencilFunc = EqualStencilFunc;
          mat.stencilFail = KeepStencilOp;
          mat.stencilZFail = KeepStencilOp;
          mat.stencilZPass = KeepStencilOp;
        });
      }
    });

    // Position robot below the portal surface
    const startPos = portalData.position.clone();
    const offset = portalData.surfaceNormal
      .clone()
      .multiplyScalar(-this.robotRiseHeight);
    startPos.add(offset);

    // Offset each robot to avoid overlapping (wider spread)
    const spreadAngle = (robotIndex - 1) * 0.6;
    const spreadOffset = new Vector3(
      Math.sin(spreadAngle) * 0.3,
      0,
      Math.cos(spreadAngle) * 0.3
    );
    startPos.add(spreadOffset);

    robotGroup.position.copy(startPos);

    // Target position is 0.5m above floor (robot origin is mid-body)
    // Use floorPosition (original hit point) not raised portal position
    const targetPos = (portalData.floorPosition || portalData.position).clone();
    targetPos.y += 0.5;
    targetPos.add(spreadOffset);

    // Make robot look toward camera initially
    if (this.world.camera) {
      const lookTarget = this.world.camera.position.clone();
      lookTarget.y = robotGroup.position.y;
      robotGroup.lookAt(lookTarget);
    }

    this.world.scene.add(robotGroup);

    // Apply env map, face, and thrust VFX immediately so robot looks correct during rise animation
    let thrustVFX = null;
    if (this.world.robotSystem) {
      this.world.robotSystem.applyEnvMapToRobot(robotGroup);
      this.world.robotSystem.applyFaceToRobot(robotGroup);
      thrustVFX = this.world.robotSystem.createThrustVFXForRobot(robotGroup);
    }

    const robotData = {
      group: robotGroup,
      startPosition: startPos.clone(),
      targetPosition: targetPos,
      startTime: performance.now(),
      phase: "rising",
      portalData: portalData,
      robotIndex: robotIndex,
      thrustVFX: thrustVFX, // Pre-created during spawn
    };

    this.robots.push(robotData);
    portalData.robots.push(robotData);
    portalData.robotsSpawned++;

    this.logger.log(
      `Robot ${robotIndex + 1}/${portalData.robotsToSpawn} (${
        character.name
      }) spawned and rising from portal`
    );

    return robotData;
  }

  update(delta, time) {
    const now = performance.now();

    // Check for debug auto-spawn BEFORE enabled check
    // We want to set the pending flag early, then wait for enabled + room setup
    if (!this._debugAutoSpawnChecked) {
      this._debugAutoSpawnChecked = true;
      const debugState = gameState.getDebugSpawnState();
      if (debugState?.spawnRobotsImmediately) {
        this._debugAutoSpawnPending = true;
        this.logger.log(
          "Debug auto-spawn pending - waiting for room setup + navmesh surface"
        );
      }
      if (debugState?.spawnPortalImmediately) {
        this._debugPortalPending = true;
        this._debugPortalOffset = debugState.debugPortalOffset || {
          x: 0,
          y: 0,
          z: -2,
        };
        this.logger.log(
          "Debug portal spawn pending - waiting for room setup + navmesh"
        );
      }
    }

    // Handle debug auto-spawn when conditions are met:
    // - enabled (intro played + room setup done)
    // - have robot model cached
    // - room setup confirmed complete
    if (this._debugAutoSpawnPending) {
      const currentState = gameState.getState();

      // Log conditions periodically for debugging
      if (!this._lastDebugLog || now - this._lastDebugLog > 2000) {
        this._lastDebugLog = now;
        this.logger.log(
          `Debug auto-spawn waiting: enabled=${this.enabled}, ` +
            `modelsLoaded=${this.cachedModels.size}, ` +
            `roomSetup=${currentState.roomSetupRequired}, ` +
            `introPlayed=${currentState.introPlayed}`
        );
      }

      if (
        this.enabled &&
        this.cachedModels.size > 0 &&
        currentState.roomSetupRequired === false
      ) {
        const navSurfacesSystem = this.world.navSurfacesSystem;
        // Prefer floor over tables for debug spawn
        const floorSurface = navSurfacesSystem?.getFloorSurface();
        const spawnSurface =
          floorSurface || navSurfacesSystem?.getFirstSurface();

        if (!spawnSurface) {
          this.logger.log("Debug auto-spawn: waiting for navmesh surface");
        } else if (this.portals.length > 0) {
          this.logger.log("Debug auto-spawn: portals already exist");
        } else if (this.initialPortalComplete) {
          this.logger.log("Debug auto-spawn: initial portal already complete");
        } else {
          this._debugAutoSpawnPending = false;
          this.logger.log(
            `Debug auto-spawn: spawning robots on ${
              floorSurface ? "floor" : "first surface"
            }`
          );
          // Disable hit testing since robots are spawning directly
          if (this.world.hitTestManager) {
            this.world.hitTestManager.setEnabled(false);
          }
          this._debugSpawnRobots(spawnSurface);
        }
      }
    }

    // Handle debug portal spawn - spawns portal in front of player, robots come through normally
    if (this._debugPortalPending) {
      const currentState = gameState.getState();

      if (
        this.enabled &&
        this.cachedModels.size > 0 &&
        currentState.roomSetupRequired === false
      ) {
        if (this.portals.length > 0 || this.initialPortalComplete) {
          this._debugPortalPending = false;
        } else if (this.world.camera) {
          this._debugPortalPending = false;

          // Get camera position and forward direction
          const camPos = this.world.camera.position.clone();
          const camDir = new Vector3(0, 0, -1).applyQuaternion(
            this.world.camera.quaternion
          );
          camDir.y = 0;
          camDir.normalize();

          // Calculate spawn position using offset
          const offset = this._debugPortalOffset;
          const spawnPos = new Vector3(
            camPos.x + camDir.x * Math.abs(offset.z) + offset.x,
            offset.y, // Floor level
            camPos.z + camDir.z * Math.abs(offset.z)
          );

          this.logger.log(
            `Debug portal spawn: creating portal at ${spawnPos.x.toFixed(
              2
            )}, ${spawnPos.y.toFixed(2)}, ${spawnPos.z.toFixed(2)}`
          );

          // Create a fake pose for spawnPortalAndRobots
          const quaternion = new Quaternion(); // Identity = floor facing up
          const matrix = new Matrix4().compose(
            spawnPos,
            quaternion,
            new Vector3(1, 1, 1)
          );
          const fakePose = {
            transform: {
              matrix: matrix.toArray(),
            },
          };

          this.spawnPortalAndRobots(fakePose);
        }
      }
    }

    // Early exit if spawner not enabled yet
    if (!this.enabled) return;

    // Update goal marker animation
    if (this.goalMarker) {
      const elapsed = (now - this.goalMarker.userData.startTime) / 1000;
      const pulse = 0.7 + 0.3 * Math.sin(elapsed * 3);
      const { outerRing, innerRing } = this.goalMarker.userData;
      if (outerRing) outerRing.material.opacity = pulse;
      if (innerRing) innerRing.material.opacity = pulse * 0.8;
    }

    // Update portal preview animation
    if (this.portalPreview) {
      this._portalPreviewTime += delta;
      const { disc, particles, particleAngles, particleSpeeds, particleRadii } =
        this.portalPreview.userData;

      if (disc?.material?.uniforms?.uTime) {
        disc.material.uniforms.uTime.value = this._portalPreviewTime;
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
            0.008 + Math.sin(angle * 2 + this._portalPreviewTime * 3) * 0.004;
          positions[i * 3 + 2] = Math.sin(angle) * radius;
        }

        particles.geometry.attributes.position.needsUpdate = true;
      }
    }

    // Update portals
    for (let i = this.portals.length - 1; i >= 0; i--) {
      const portalData = this.portals[i];
      const elapsed = (now - portalData.startTime) / 1000;

      // Update the PortalVFX animation
      if (portalData.portalHandle) {
        portalData.portalHandle.update(delta);
      }

      if (portalData.phase === "opening") {
        const progress = Math.min(1, elapsed / this.portalOpenDuration);
        const eased = this._easeOutBack(progress);

        // Update PortalVFX progress
        if (portalData.portalHandle) {
          portalData.portalHandle.setProgress(eased);
        }

        // Update portal audio
        if (portalData.portalAudio) {
          portalData.portalAudio.updateEntrance(
            "opening",
            progress,
            portalData.robotsSpawned
          );
        }

        if (progress >= 1) {
          portalData.phase = "holding";
          portalData.holdStartTime = now;
        }
      } else if (portalData.phase === "holding") {
        const holdElapsed = (now - portalData.holdStartTime) / 1000;
        const holdProgress = Math.min(1, holdElapsed / this.portalHoldDuration);

        // Update portal audio
        if (portalData.portalAudio) {
          portalData.portalAudio.updateEntrance(
            "holding",
            holdProgress,
            portalData.robotsSpawned
          );
        }

        if (holdElapsed >= this.portalHoldDuration) {
          portalData.phase = "spawning";
          portalData.lastRobotSpawnTime = now;
          this._spawnRobot(portalData);

          // Set robotsActive NOW so HUD panel fades out before world panel appears
          gameState.setState({ robotsActive: true });

          // Move call panel to hover above portal (professor watches robots emerge)
          // Delay slightly to let HUD fade start first
          const wristUI = this.world.aiManager?.wristUI;
          if (wristUI) {
            setTimeout(() => {
              wristUI.setCallPanelWorldTarget(
                portalData.position,
                portalData.surfaceNormal,
                { heightOffset: 1.5, floatAmplitude: 0.02, floatSpeed: 0.8 }
              );
              this.logger.log("Call panel moved to hover above portal");
            }, 300); // 300ms delay - HUD fade is 500ms
          }
        }
      } else if (portalData.phase === "spawning") {
        // Spawn additional robots with delay
        const timeSinceLastSpawn = (now - portalData.lastRobotSpawnTime) / 1000;
        if (
          portalData.robotsSpawned < portalData.robotsToSpawn &&
          timeSinceLastSpawn >= this.robotSpawnDelay
        ) {
          portalData.lastRobotSpawnTime = now;
          this._spawnRobot(portalData);
        }

        // Update portal audio
        const spawnProgress =
          portalData.robotsSpawned / portalData.robotsToSpawn;
        if (portalData.portalAudio) {
          portalData.portalAudio.updateEntrance(
            "spawning",
            spawnProgress,
            portalData.robotsSpawned
          );
        }

        // Check if all robots are done emerging
        const allComplete = portalData.robots.every(
          (r) => r.phase === "complete"
        );
        if (
          allComplete &&
          portalData.robotsSpawned >= portalData.robotsToSpawn
        ) {
          portalData.phase = "closing";
          portalData.closeStartTime = now;

          // Mark robots as active and enable voice input
          if (!this.initialPortalComplete) {
            this.initialPortalComplete = true;

            // Store portal position for later use as goal destination
            const portalPos = portalData.position;

            // Robots start in gathered mode (stationary, looking at player)
            // Voice input enabled later by ambassadorPresentation dialog onComplete
            gameState.setState({
              portalSpawnPosition: {
                x: portalPos.x,
                y: portalPos.y,
                z: portalPos.z,
              },
              robotBehavior: "gathered",
            });
            this.logger.log(
              `Robots active - portal position stored at (${portalPos.x.toFixed(
                2
              )}, ${portalPos.y.toFixed(2)}, ${portalPos.z.toFixed(2)})`
            );
          }
        }
      } else if (portalData.phase === "closing") {
        const closeElapsed = (now - portalData.closeStartTime) / 1000;
        const progress = Math.min(1, closeElapsed / this.portalCloseDuration);

        // Animate portal closing
        if (portalData.portalHandle) {
          portalData.portalHandle.setProgress(1 - this._easeInCubic(progress));
        }

        // Update portal audio
        if (portalData.portalAudio) {
          portalData.portalAudio.updateEntrance(
            "closing",
            progress,
            portalData.robotsSpawned
          );
        }

        if (progress >= 1) {
          portalData.phase = "complete";
          this._disposePortal(portalData);
          this.portals.splice(i, 1);
        }
      }
    }

    // Update robots
    for (const robotData of this.robots) {
      if (robotData.phase === "complete") continue;

      const elapsed = (now - robotData.startTime) / 1000;
      const progress = Math.min(1, elapsed / this.robotRiseDuration);
      const eased = this._easeOutCubic(progress);

      // Lerp position from below surface to surface
      robotData.group.position.lerpVectors(
        robotData.startPosition,
        robotData.targetPosition,
        eased
      );

      // Track to camera
      if (this.world.camera) {
        const lookTarget = this.world.camera.position.clone();
        lookTarget.y = robotData.group.position.y;
        robotData.group.lookAt(lookTarget);
      }

      // Update thruster VFX during spawn animation
      if (robotData.thrustVFX) {
        const deltaTime = Math.min(
          (now - (robotData.lastUpdateTime || robotData.startTime)) / 1000,
          0.1
        );
        robotData.thrustVFX.setIntensity(0, 1.4, false, 0, false);
        robotData.thrustVFX.update(deltaTime);
        robotData.lastUpdateTime = now;
      }

      if (progress >= 1) {
        robotData.phase = "complete";
        this.logger.log(
          `Robot ${(robotData.robotIndex || 0) + 1} emergence complete`
        );

        // Hand off to RobotSystem for crowd simulation
        this._handoffToRobotSystem(robotData);
      }
    }
  }

  _handoffToRobotSystem(robotData) {
    const robotSystem = this.world.robotSystem;
    if (!robotSystem) {
      this.logger.warn("RobotSystem not available for handoff");
      return;
    }

    // Create an entity for the robot with the Robot component
    const robotEntity = this.world.createTransformEntity(robotData.group);
    robotEntity.addComponent(Robot);

    // Register with RobotSystem, passing pre-created thrustVFX
    robotSystem.registerRobot(robotEntity, { thrustVFX: robotData.thrustVFX });

    // Store reference for cleanup
    robotData.entity = robotEntity;

    const pos = robotData.group.position;
    this.logger.log(
      `Robot handed off to RobotSystem at position (${pos.x.toFixed(
        2
      )}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}), navMeshInitialized: ${
        robotSystem.navMeshInitialized
      }`
    );
  }

  /**
   * Debug spawn robots directly at a surface (no portal animation)
   * Used for ?gameState=ROBOTS_WANDERING debug mode
   */
  async _debugSpawnRobots(surface) {
    // Prefer spawning near player instead of at surface center
    let position = new Vector3(
      surface.center[0],
      surface.center[1],
      surface.center[2]
    );

    // Try to spawn near player position (1.5m in front)
    if (this.world.camera) {
      const camPos = this.world.camera.position;
      const camDir = new Vector3(0, 0, -1);
      camDir.applyQuaternion(this.world.camera.quaternion);
      camDir.y = 0;
      camDir.normalize();

      // 1.5m in front of player, on the floor surface
      const nearPlayer = new Vector3(
        camPos.x + camDir.x * 1.5,
        surface.center[1], // Use surface Y height
        camPos.z + camDir.z * 1.5
      );

      this.logger.log(
        `Debug spawn: placing robots near player at (${nearPlayer.x.toFixed(
          2
        )}, ${nearPlayer.y.toFixed(2)}, ${nearPlayer.z.toFixed(2)})`
      );
      position = nearPlayer;
    }

    // Enable occlusion debug visualization (disabled by default)
    // Set DEBUG_OCCLUSION_VIS=true in URL params to enable
    const debugOcclusionVis =
      new URLSearchParams(window.location.search).get("DEBUG_OCCLUSION_VIS") ===
      "true";
    if (debugOcclusionVis) {
      const navSurfaces = this.world.navSurfacesSystem;
      if (navSurfaces) {
        navSurfaces.enableDebugOcclusionVisualization();
      }
    }

    for (let i = 0; i < this.robotsPerPortal; i++) {
      // Get character and model for this robot
      const character = getCharacterByIndex(i);
      const cachedScene = this.cachedModels.get(character.id);
      if (!cachedScene) {
        this.logger.warn(
          `Model not loaded for ${character.name} in debug spawn`
        );
        continue;
      }

      const robotGroup = cachedScene.clone(true);
      robotGroup.scale.set(0.3, 0.3, 0.3);
      robotGroup.userData.characterId = character.id;
      robotGroup.userData.characterName = character.name;

      // Spread robots to avoid overlapping (wider spread)
      const spreadAngle = (i - 1) * 0.6;
      const offsetX = Math.sin(spreadAngle) * 0.3;
      const offsetZ = Math.cos(spreadAngle) * 0.3;

      robotGroup.position.set(
        position.x + offsetX,
        position.y,
        position.z + offsetZ
      );

      // Face camera
      if (this.world.camera) {
        const lookTarget = this.world.camera.position.clone();
        lookTarget.y = robotGroup.position.y;
        robotGroup.lookAt(lookTarget);
      }

      this.world.scene.add(robotGroup);

      // Apply env map and face immediately so robot looks correct
      const robotSystem = this.world.robotSystem;
      if (robotSystem) {
        robotSystem.applyEnvMapToRobot(robotGroup);
        robotSystem.applyFaceToRobot(robotGroup);
      }

      // Create entity and hand off to RobotSystem
      const robotEntity = this.world.createTransformEntity(robotGroup);
      robotEntity.addComponent(Robot);

      // Register with RobotSystem (manual tracking since no ECS queries)
      if (robotSystem) {
        robotSystem.registerRobot(robotEntity);
      }

      const robotData = {
        group: robotGroup,
        entity: robotEntity,
        phase: "complete",
        robotIndex: i,
      };
      this.robots.push(robotData);

      this.logger.log(
        `Debug spawned robot ${i + 1}/${this.robotsPerPortal} (${
          character.name
        })`
      );
    }

    // Mark portal as complete and set game state
    // Check if debug state wants wandering mode - otherwise default to gathered
    const debugState = gameState.getDebugSpawnState();
    const targetBehavior = debugState?.robotBehavior || "gathered";

    this.initialPortalComplete = true;
    gameState.setState({
      robotsActive: true,
      portalSpawnPosition: {
        x: position.x,
        y: position.y,
        z: position.z,
      },
      robotBehavior: targetBehavior,
    });

    this.logger.log(`Debug spawn: robotBehavior set to "${targetBehavior}"`);

    // Disable environment placement
    if (this.world.hitTestManager) {
      this.world.hitTestManager.setEnabled(false);
    }

    // Show nametags for debug spawn (normally shown during intro dialog)
    const robotSystemRef = this.world.robotSystem;
    if (robotSystemRef?.characterManager) {
      for (const [entityIndex] of robotSystemRef.robotEntities) {
        robotSystemRef.characterManager.showNameTag(entityIndex);
      }
      this.logger.log("Debug spawn: nametags shown");
    }

    const wristUI = this.world.aiManager?.wristUI;

    // Start panic minigame if debug state requests it (uses HUD call panel, not world)
    if (debugState?.startPanicMinigame && robotSystemRef) {
      this.logger.log("Debug spawn: starting panic minigame");
      robotSystemRef.startPanicMinigame(wristUI);
    } else if (wristUI) {
      // Move call panel to hover above robots (professor watches them)
      const surfaceNormal = new Vector3(0, 1, 0); // Assume floor for debug spawn
      wristUI.setCallPanelWorldTarget(position, surfaceNormal, {
        heightOffset: 1.5,
        floatAmplitude: 0.02,
        floatSpeed: 0.8,
      });
      this.logger.log("Debug spawn: call panel moved to hover above robots");
    }
  }

  _easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  _easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  _easeInCubic(t) {
    return t * t * t;
  }

  _disposePortal(portalData) {
    // Dispose the PortalVFX via handle
    if (portalData.portalHandle) {
      portalData.portalHandle.dispose();
      portalData.portalHandle = null;
    }

    // Stop and dispose portal audio
    if (portalData.portalAudio) {
      portalData.portalAudio.stop();
      portalData.portalAudio.dispose();
      portalData.portalAudio = null;
    }

    // Remove stencil testing from robots after portal closes
    for (const robotData of portalData.robots) {
      if (robotData.group) {
        robotData.group.traverse((child) => {
          if (child.isMesh && child.material) {
            const materials = Array.isArray(child.material)
              ? child.material
              : [child.material];
            materials.forEach((mat) => {
              mat.stencilWrite = false;
              mat.stencilRef = 0;
              mat.stencilFunc = 519; // AlwaysStencilFunc
            });
          }
        });
      }
    }
  }
}
