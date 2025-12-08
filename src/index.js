/**
 * IWSDK Quest MR Application Entry Point
 *
 * Initialization flow:
 * 1. Platform detection (Quest-only, emulator bypass for dev)
 * 2. Loading screen while assets preload
 * 3. Start screen with START button
 * 4. User clicks START -> ENTERING_XR -> world.launchXR()
 * 5. BrowserStateSystem handles visibilityState -> XR_ACTIVE
 *
 * ============================================================================
 * DEBUG URL PARAMETERS
 * ============================================================================
 * ?gameState=<STATE>     - Skip to a specific game state (see debugSpawner.js)
 *                          e.g., ?gameState=PLAYING skips intro
 * ?introPlayed=true      - Mark intro as already played
 * ?semanticLabels=true   - Enable semantic label debug visualizations
 * ?navmeshDebug=true     - Enable navmesh debug visualizations (see robot.js)
 *
 * Combine params: ?gameState=PLAYING&navmeshDebug=true
 * ============================================================================
 */

// Build timestamp for deployment verification
console.log(`[Build] ${__BUILD_TIME__}`);

// Suppress "No back-facing camera" spam from IWSDK (runs every frame in emulator)
const _origError = console.error;
let _cameraErrorShown = false;
console.error = (...a) => {
  if (typeof a[0] === "string" && a[0].includes("back-facing")) {
    if (!_cameraErrorShown) {
      _cameraErrorShown = true;
      _origError.apply(console, a);
    }
    return;
  }
  _origError.apply(console, a);
};

import {
  AssetType,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
  World,
  CameraSource,
  CameraUtils,
  DomeGradient,
  SceneUnderstandingSystem,
  XRMesh,
} from "@iwsdk/core";
import * as horizonKit from "@pmndrs/uikit-horizon";
import { MicIcon } from "@pmndrs/uikit-lucide";
// Game state and platform detection
import { GAME_STATES, gameState } from "./gameState.js";
import {
  detectPlatform,
  applyPlatformDetection,
} from "./utils/PlatformDetection.js";

// UI screens
import { LoadingScreen } from "./ui/LoadingScreen.js";
import { UnsupportedScreen } from "./ui/UnsupportedScreen.js";
import { StartScreen } from "./ui/StartScreen.js";
import { OptionsMenu } from "./ui/OptionsMenu.js";

// Systems
import { BrowserStateSystem } from "./systems/BrowserStateSystem.js";
import { AudioSystem } from "./systems/AudioSystem.js";
import { AudioAmplitudeSystem } from "./systems/AudioAmplitudeSystem.js";
import { AnimatedUISystem } from "./systems/AnimatedUISystem.js";
import { SemanticLabelsSystem } from "./utils/SemanticEnvironmentLabels.js";
import { AIManager, AIManagerConfig } from "./ai/AIManager.js";
import { XrInputSystem } from "./ui/XrInputSystem.js";
import { RobotSpawnerSystem } from "./robot/RobotSpawnerSystem.js";
import { NavSurfacesSystem } from "./utils/NavSurfaces.js";
import { RobotSystem } from "./robot/RobotSystem.js";

// CSS imports for DOM-based screens
import "./styles/loadingScreen.css";
import "./styles/unsupportedScreen.css";

// Utils
import { Logger } from "./utils/Logger.js";
import { IS_EMULATOR } from "./ai/config.js";
import { createStarfield } from "./vfx/Starfield.js";

// VFX
import { VFXManager } from "./vfx/VFXManager.js";

// Hit testing
import { HitTestManager } from "./utils/HitTestManager.js";

const logger = new Logger("App", true);

// ============================================================================
// AIManager Configuration - toggle submodules for performance testing
// ============================================================================
// Check URL params for debug options
const urlParams = new URLSearchParams(window.location.search);
const enableSemanticLabels = urlParams.get("semanticLabels") === "true";
const isLocalhost =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

AIManagerConfig.enableVoicePanel = true;
AIManagerConfig.enableDebugVisualizer = enableSemanticLabels; // Off by default, enable with ?semanticLabels=true
AIManagerConfig.enableVoiceRecording = true;

// ============================================================================
// Step 1: Platform Detection
// ============================================================================

logger.log("Starting platform detection...");
const platform = detectPlatform();
applyPlatformDetection(gameState);

// If platform is not supported, show unsupported screen and stop
if (!platform.isSupported) {
  logger.log("Unsupported platform detected, showing blocking screen");
  new UnsupportedScreen();
  throw new Error("Unsupported platform - Meta Quest required");
}

logger.log("Platform supported, continuing initialization...");

// ============================================================================
// Step 2: Show Loading Screen
// ============================================================================

gameState.setState({ currentState: GAME_STATES.LOADING });

const loadingScreen = new LoadingScreen({
  onComplete: () => {
    logger.log("Loading complete, transitioning to start screen");
  },
});

// Register loading tasks
loadingScreen.registerTask("world");
loadingScreen.registerTask("systems");

// Make loading screen globally accessible for other modules
window.loadingScreen = loadingScreen;

// ============================================================================
// Step 3: Create IWSDK World (with manual XR entry via 'none')
// ============================================================================

const assets = {
  // Audio assets will be added here as the game develops
  // Example:
  // music1: { url: '/audio/music/track.mp3', type: AssetType.Audio, priority: 'background' },
};

logger.log("Creating IWSDK World...");

World.create(document.getElementById("scene-container"), {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveAR,
    offer: "none", // Manual launch only - user clicks START
    features: {
      handTracking: true,
      anchors: { required: true },
      hitTest: true,
      planeDetection: { required: true },
      meshDetection: { required: true },
      layers: true,
    },
  },
  features: {
    locomotion: false,
    grabbing: true,
    physics: true,
    sceneUnderstanding: true,
    camera: !IS_EMULATOR,
    spatialUI: {
      kits: [horizonKit, { MicIcon }],
    },
  },
})
  .then(async (world) => {
    logger.log("IWSDK World created");

    // Store world reference in game state
    gameState.setWorld(world);

    const { camera } = world;
    camera.position.set(0, 1, 0.5);

    // Set dark space background using IWSDK's DomeGradient component
    const levelRoot = world.activeLevel.value;
    if (levelRoot) {
      // Remove existing DomeGradient if any, then add dark space gradient
      if (levelRoot.hasComponent(DomeGradient)) {
        levelRoot.removeComponent(DomeGradient);
      }
      levelRoot.addComponent(DomeGradient, {
        sky: [0.008, 0.012, 0.03, 1.0], // Very dark blue-black
        equator: [0.02, 0.02, 0.04, 1.0], // Slightly lighter
        ground: [0.005, 0.005, 0.01, 1.0], // Near black
        intensity: 1.0,
      });
    }

    // Create starfield background for pre-XR screen (Star Wars crawl style)
    const starfield = createStarfield(world.scene);

    // Animate starfield - runs when starfieldActive is true
    let starfieldActive = true;
    let lastStarfieldTime = performance.now();
    function animateStarfield() {
      if (!starfieldActive) return;
      const now = performance.now();
      const delta = (now - lastStarfieldTime) / 1000;
      lastStarfieldTime = now;
      starfield.animate(delta);
      requestAnimationFrame(animateStarfield);
    }
    animateStarfield();

    // Helper to enable/disable starfield
    function setStarfieldEnabled(enabled) {
      if (enabled && !starfieldActive) {
        starfieldActive = true;
        starfield.setVisible(true);
        lastStarfieldTime = performance.now();
        animateStarfield();
        // Re-add dark space gradient
        if (levelRoot && !levelRoot.hasComponent(DomeGradient)) {
          levelRoot.addComponent(DomeGradient, {
            sky: [0.008, 0.012, 0.03, 1.0],
            equator: [0.02, 0.02, 0.04, 1.0],
            ground: [0.005, 0.005, 0.01, 1.0],
            intensity: 1.0,
          });
        }
        logger.log("Starfield enabled");
      } else if (!enabled && starfieldActive) {
        starfieldActive = false;
        starfield.setVisible(false);
        // Remove dark space gradient for AR/MR passthrough
        if (levelRoot && levelRoot.hasComponent(DomeGradient)) {
          levelRoot.removeComponent(DomeGradient);
        }
        logger.log("Starfield disabled");
      }
    }

    // Handle starfield visibility based on game state
    gameState.on("state:changed", (newState, oldState) => {
      // Disable starfield when entering XR
      if (newState.currentState === GAME_STATES.ENTERING_XR) {
        setStarfieldEnabled(false);
      }
      // Re-enable starfield when XR paused (visible-blurred = system UI showing)
      else if (
        newState.currentState === GAME_STATES.XR_PAUSED &&
        newState.xrPauseReason === "blurred"
      ) {
        setStarfieldEnabled(true);
      }
      // Re-enable starfield when returning to start screen (XR session ended)
      else if (
        newState.currentState === GAME_STATES.START_SCREEN &&
        oldState.currentState !== GAME_STATES.LOADING
      ) {
        setStarfieldEnabled(true);
      }
      // Disable starfield when resuming from pause
      else if (
        oldState.currentState === GAME_STATES.XR_PAUSED &&
        newState.currentState >= GAME_STATES.XR_ACTIVE
      ) {
        setStarfieldEnabled(false);
      }
    });

    // Complete world loading task
    loadingScreen.completeTask("world");

    // ============================================================================
    // Step 4: Initialize Camera (if not in emulator)
    // ============================================================================

    if (!IS_EMULATOR) {
      const cameraEntity = world.createEntity();
      cameraEntity.addComponent(CameraSource, {
        facing: "back",
        width: 1920,
        height: 1080,
        frameRate: 30,
      });
      world.globals.cameraEntity = cameraEntity;

      CameraUtils.getDevices()
        .then(() => logger.log("Cameras ready"))
        .catch((error) => logger.warn("Camera unavailable:", error));
    } else {
      logger.log("Emulator mode: camera initialization skipped");
    }

    // ============================================================================
    // Step 5: Register Systems
    // ============================================================================

    world
      .registerSystem(BrowserStateSystem) // Syncs IWSDK visibilityState to gameState
      .registerSystem(AudioSystem) // Criteria-based audio playback
      .registerSystem(AudioAmplitudeSystem) // Audio amplitude analysis for haptics/visuals
      .registerSystem(AnimatedUISystem); // Ambient UI animations

    // Conditionally register SemanticLabelsSystem based on URL param
    if (enableSemanticLabels) {
      world.registerSystem(SemanticLabelsSystem);
      logger.log("Semantic labels enabled via URL parameter");
    }

    // Scene understanding - creates XRMesh entities from room scan
    world.registerComponent(XRMesh).registerSystem(SceneUnderstandingSystem, {
      configData: { showWireFrame: false },
    });

    world
      .registerSystem(AIManager)
      .registerSystem(XrInputSystem)
      .registerSystem(NavSurfacesSystem) // Detects floor/table surfaces for navigation + occlusion
      .registerSystem(RobotSystem) // Robot crowd simulation
      .registerSystem(RobotSpawnerSystem); // Portal and robot spawning

    logger.log("Systems registered");

    // Initialize VFX Manager (available to all systems via world.vfxManager)
    const vfxManager = new VFXManager(world);
    logger.log("VFXManager initialized");

    // Hit test manager - created when XR becomes active
    let hitTestManagerInitialized = false;

    const initHitTestManager = () => {
      if (hitTestManagerInitialized || world.hitTestManager) return;

      world.hitTestManager = new HitTestManager(world, null);
      hitTestManagerInitialized = true;

      // Connect to robot spawner if available
      connectRobotSpawner();
    };

    const initHitTestSources = () => {
      if (!world.hitTestManager) return;

      const xrSession = world.renderer?.xr?.getSession?.();
      if (xrSession) {
        world.hitTestManager.initializeHitTestSources(xrSession);
      }
    };

    // Connect robot spawner to hit test manager trigger
    let robotSpawnerConnected = false;
    const connectRobotSpawner = () => {
      if (robotSpawnerConnected) return;

      const robotSpawner = world.robotSpawnerSystem;
      const robotSystem = world.robotSystem;

      if (world.hitTestManager && robotSpawner) {
        world.hitTestManager.onEnvironmentSelect = (pose) => {
          robotSpawner.spawnAtPose(pose);
        };

        // Connect goal reached callback to clear goal marker
        if (robotSystem) {
          robotSystem.onGoalReached(() => {
            robotSpawner.clearGoal();
            logger.log("Goal reached - marker cleared");
          });
        }

        // Enable hitTestManager if spawner is already enabled (handles race condition
        // where spawner's state listener fires before hitTestManager is created)
        if (robotSpawner.enabled) {
          world.hitTestManager.setEnabled(true);
        }

        robotSpawnerConnected = true;
        logger.log("Robot spawner connected to HitTestManager");
      }
    };

    gameState.on("state:changed", (newState, oldState) => {
      // Create HitTestManager when XR becomes active (or any XR state like PORTAL_PLACEMENT from debug spawn)
      const enteringXR =
        newState.currentState >= GAME_STATES.XR_ACTIVE &&
        oldState.currentState < GAME_STATES.XR_ACTIVE;

      if (enteringXR) {
        initHitTestManager();
        // If intro already played (debug spawn), init sources immediately
        if (newState.introPlayed) {
          initHitTestSources();
          connectRobotSpawner();
        }
      }

      // Initialize hit test sources when intro completes (normal flow)
      if (newState.introPlayed && !oldState.introPlayed) {
        initHitTestSources();
        connectRobotSpawner();
      }
    });

    // Debug spawn state is now automatically merged during XR_ACTIVE transition
    // in gameState.setState() - no separate listener needed
    if (gameState.hasDebugSpawn()) {
      logger.log(
        "Debug spawn detected, will be merged when XR starts:",
        gameState.getDebugSpawnState()
      );
    }

    // ============================================================================
    // Step 6: Set up Start Screen handler (BEFORE completing loading)
    // ============================================================================

    // Keep references to start screen and options menu
    let startScreen = null;
    let optionsMenu = null;

    const initializeStartScreen = async () => {
      logger.log("Initializing start screen and options menu...");

      // Create options menu (hidden by default)
      optionsMenu = new OptionsMenu({
        onBack: () => {
          logger.log("Returning from options to start screen");
          if (startScreen) startScreen.show();
        },
      });
      await optionsMenu.initialize();

      // Create start screen
      startScreen = new StartScreen({
        onStart: () => {
          logger.log("User clicked START, launching XR...");
          launchXR(world);
        },
        onOptions: () => {
          logger.log("Opening options menu...");
          if (optionsMenu) optionsMenu.show();
        },
      });
      await startScreen.initialize();

      // Store references for debugging
      window.startScreen = startScreen;
      window.optionsMenu = optionsMenu;
    };

    // Listen for state changes to show/hide start screen
    let startScreenInitialized = false;
    gameState.on("state:changed", async (newState, oldState) => {
      // Initialize start screen on first transition to START_SCREEN
      if (
        newState.currentState === GAME_STATES.START_SCREEN &&
        !startScreenInitialized
      ) {
        startScreenInitialized = true;
        await initializeStartScreen();
        return;
      }

      // Show start screen when XR paused (visible-blurred = system UI)
      if (
        newState.currentState === GAME_STATES.XR_PAUSED &&
        newState.xrPauseReason === "blurred" &&
        startScreen
      ) {
        startScreen.setMode("paused");
        startScreen.show();
      }

      // Show start screen when returning from XR (session ended)
      // Only show if currentState actually changed TO START_SCREEN (not just any state update)
      if (
        newState.currentState === GAME_STATES.START_SCREEN &&
        oldState.currentState !== GAME_STATES.START_SCREEN &&
        oldState.currentState !== GAME_STATES.LOADING &&
        startScreen
      ) {
        startScreen.setMode("reenter");
        startScreen.show();
      }

      // Hide start screen when resuming XR from pause
      if (
        oldState.currentState === GAME_STATES.XR_PAUSED &&
        newState.currentState >= GAME_STATES.XR_ACTIVE &&
        startScreen
      ) {
        startScreen.hide();
      }
    });

    // Complete systems loading task - this will trigger state change to START_SCREEN
    loadingScreen.completeTask("systems");

    // Make world globally accessible for debugging
    window.world = world;

    // ============================================================================
    // Performance Stats (FPS monitor) - localhost only
    // ============================================================================

    if (isLocalhost) {
      import("three/examples/jsm/libs/stats.module.js").then(
        ({ default: Stats }) => {
          import("./utils/StatsSystem.js").then(({ StatsSystem }) => {
            world.registerSystem(StatsSystem);
          });

          const stats = new Stats();
          stats.showPanel(0); // 0: FPS, 1: MS per frame, 2: MB memory
          stats.dom.style.cssText =
            "position:fixed;top:0;left:0;z-index:10000;";
          document.body.appendChild(stats.dom);
          window.stats = stats;
        }
      );
    }
  })
  .catch((error) => {
    logger.error("Failed to create World:", error);
    loadingScreen.hide();
  });

// ============================================================================
// XR Session Launch
// ============================================================================

/**
 * Launch the XR session using IWSDK's world.launchXR()
 * BrowserStateSystem will handle the state transition when visibilityState changes
 * @param {World} world - The IWSDK World instance
 */
async function launchXR(world) {
  try {
    // Set state to ENTERING_XR - BrowserStateSystem will transition to XR_ACTIVE
    // when visibilityState becomes 'visible'
    gameState.setState({ currentState: GAME_STATES.ENTERING_XR });

    logger.log("Calling world.launchXR()...");

    // Use IWSDK's launchXR method
    await world.launchXR();

    logger.log("world.launchXR() called successfully");
    // Note: State transition to XR_ACTIVE is handled by BrowserStateSystem
    // when it receives visibilityState === 'visible'
  } catch (error) {
    logger.error("Failed to launch XR:", error);

    // Return to start screen on failure
    gameState.setState({ currentState: GAME_STATES.START_SCREEN });
  }
}
