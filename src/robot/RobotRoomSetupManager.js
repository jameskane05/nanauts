/**
 * RobotRoomSetupManager.js - XR room capture and NavMesh initialization
 * =============================================================================
 *
 * ROLE: Manages the Meta Quest room capture flow and NavMesh initialization.
 * Handles prompting user for room setup when no spatial data is available.
 *
 * ROOM CAPTURE FLOW:
 *   1. Wait for XR session to become active
 *   2. Check if NavSurfaces exist (from Space Setup)
 *   3. If no surfaces after timeout, show room capture UI
 *   4. User confirms -> initiateRoomCapture() called
 *   5. Quest shows native room capture UI
 *   6. After return, verify surfaces appeared
 *   7. If success, initialize NavMesh
 *   8. If failure, show permanent error UI
 *
 * KEY METHODS:
 *   - update(): Called each frame to check room state
 *   - attemptRoomCapture(): Show room capture prompt
 *   - handleButtonPress(button): Handle A button for UI
 *   - isRoomReady(): Check if room is set up
 *
 * LIMITATIONS:
 *   - initiateRoomCapture() can only be called once per session (Quest API)
 *   - Room capture UI is native Quest UI, not customizable
 *
 * =============================================================================
 */
import { RoomCaptureUI } from "../ui/RoomCaptureUI.js";
import { gameState } from "../gameState.js";
import { Logger } from "../utils/Logger.js";

export class RobotRoomSetupManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotRoomSetupManager", true);

    // NavMesh initialization settings
    this.minSurfacesForInit = 1;
    this.lastInitAttemptLog = 0;
    this.initLogInterval = 3000;

    // Room capture state
    this.roomCaptureAttempted = false;
    this.roomCaptureWaitTime = 2000;
    this.xrActiveStartTime = null;
    this.roomCaptureUI = null;
    this.roomCaptureUIShown = false;
    this._roomCaptureInProgress = false;
    this._roomCaptureStartTime = null;
    this._sessionWaitLoggedOnce = false;
  }

  /**
   * Check if room is ready for robot navigation
   */
  isRoomReady() {
    return this.robotSystem.navMeshInitialized;
  }

  /**
   * Main update - called each frame from RobotSystem
   * Handles room capture flow and NavMesh initialization
   */
  update() {
    // Update room capture UI if shown
    if (this.roomCaptureUI) {
      this.roomCaptureUI.update();
    }

    // Verify room capture result after user returns from Quest setup
    this._verifyRoomCaptureResult();

    const state = gameState.getState();

    // Check for forced room setup state (debug mode)
    // This takes priority even if navmesh is already initialized
    if (state.roomSetupRequired === true && !this.roomCaptureUIShown) {
      this.attemptRoomCapture();
      return; // Don't proceed with normal flow while room capture is needed
    }

    // Try to initialize NavMesh if not already done
    if (!this.robotSystem.navMeshInitialized) {
      this.tryInitializeNavMesh();
    }

    // Hide room capture UI once navmesh is ready (and room capture is no longer required)
    if (
      this.roomCaptureUIShown &&
      this.robotSystem.navMeshInitialized &&
      state.roomSetupRequired !== true
    ) {
      this._hideRoomCaptureUI();
      this.roomCaptureUIShown = false; // Prevent calling again
    }
  }

  /**
   * Try to initialize NavMesh from available surfaces
   */
  tryInitializeNavMesh() {
    if (this.robotSystem.navMeshInitialized) {
      return;
    }

    const world = this.robotSystem.world;

    // Check if roomSetupRequired is true - block all surface detection until room capture completes
    const state = gameState.getState();

    if (state.roomSetupRequired === true) {
      if (!this.roomCaptureUIShown) {
        this.logger.log(
          "roomSetupRequired=true (forced) - showing room capture UI"
        );
        this.attemptRoomCapture();
      }
      return; // Always return while roomSetupRequired is true
    }

    // Only track time when actually in XR
    const session = world.renderer?.xr?.getSession?.();
    if (!session) {
      if (!this._sessionWaitLoggedOnce) {
        this._sessionWaitLoggedOnce = true;
        this.logger.log("tryInitializeNavMesh: No XR session yet, waiting...");
      }
      return;
    }

    const now = performance.now();
    const shouldLog = now - this.lastInitAttemptLog > this.initLogInterval;

    // Track when we started waiting for room data
    if (!this.xrActiveStartTime) {
      this.xrActiveStartTime = now;
      this.logger.log("XR session found - starting room data wait timer");
    }

    const navSurfacesSystem = world.navSurfacesSystem;
    if (!navSurfacesSystem) {
      if (shouldLog) {
        this.logger.log("NavSurfacesSystem not available yet");
        this.lastInitAttemptLog = now;
      }
      return;
    }

    const waitedTime = now - this.xrActiveStartTime;
    const surfaces = navSurfacesSystem.getAllSurfaces();

    // Wait minimum time before deciding room setup status
    const minWaitTime = 500;

    if (surfaces.length < this.minSurfacesForInit) {
      if (shouldLog) {
        this.logger.log(
          `Waiting for more surfaces. Have ${surfaces.length}, need ${this.minSurfacesForInit}`
        );
        this.lastInitAttemptLog = now;
      }

      // If waited long enough with no surfaces, try room capture
      // BUT skip if debug mode explicitly disabled room setup (emulator has delayed surface loading)
      const debugState = gameState.getDebugSpawnState?.();
      const debugSkipRoomCapture = debugState?.roomSetupRequired === false;

      if (
        !this.roomCaptureAttempted &&
        waitedTime > this.roomCaptureWaitTime &&
        !debugSkipRoomCapture
      ) {
        this.attemptRoomCapture();
      } else if (
        debugSkipRoomCapture &&
        waitedTime > this.roomCaptureWaitTime &&
        !this._debugWaitLoggedOnce
      ) {
        this._debugWaitLoggedOnce = true;
        this.logger.log(
          "Debug mode: roomSetupRequired=false, waiting longer for emulator surfaces..."
        );
      }
      return;
    }

    const firstSurface = navSurfacesSystem.getFirstSurface();
    if (!firstSurface) {
      if (shouldLog) {
        this.logger.log("No surfaces available yet");
        this.lastInitAttemptLog = now;
      }
      return;
    }

    // Wait minimum time before confirming room setup not required
    if (waitedTime < minWaitTime) {
      return;
    }

    // Surfaces found - room setup not required
    gameState.setState({ roomSetupRequired: false });
    this.logger.log(`Initializing navmesh with ${surfaces.length} surfaces`);
    this.robotSystem.initializeNavMesh();
  }

  /**
   * Show room capture UI prompt when no room data is found
   */
  attemptRoomCapture() {
    this.logger.log(
      "attemptRoomCapture called, roomCaptureUIShown:",
      this.roomCaptureUIShown
    );
    if (this.roomCaptureUIShown) return;

    const session = this.robotSystem.world.renderer?.xr?.getSession?.();
    this.logger.log("attemptRoomCapture session check:", !!session);
    if (!session) {
      this.logger.log("attemptRoomCapture: No XR session yet, waiting...");
      return;
    }

    this.roomCaptureUIShown = true;
    this.logger.log("attemptRoomCapture: session found, showing UI");

    const canInitiateRoomCapture =
      typeof session.initiateRoomCapture === "function";
    this.logger.log(
      `No room data found after ${this.roomCaptureWaitTime}ms - showing room capture UI (initiateRoomCapture available: ${canInitiateRoomCapture})`
    );
    this._showRoomCaptureUI();
  }

  /**
   * Create and show the room capture UI panel
   */
  async _showRoomCaptureUI() {
    if (!this.roomCaptureUI) {
      this.roomCaptureUI = new RoomCaptureUI(this.robotSystem.world, {
        onConfirm: () => this._confirmRoomCapture(),
      });
      await this.roomCaptureUI.initialize();

      // Register with UIStateManager if available
      const uiStateManager = this.robotSystem.world.aiManager?.uiStateManager;
      if (uiStateManager) {
        uiStateManager.registerRoomCaptureUI(this.roomCaptureUI);
      }
    }

    gameState.setState({ roomSetupRequired: true });
    this.roomCaptureUI.show();
  }

  /**
   * Hide the room capture UI
   */
  _hideRoomCaptureUI() {
    if (this.roomCaptureUI) {
      this.roomCaptureUI.hide();
    }

    // Only set state if not already false
    if (gameState.getState().roomSetupRequired !== false) {
      gameState.setState({ roomSetupRequired: false });
      this.logger.log("Room setup complete - UIStateManager will show next UI");
    }
  }

  /**
   * Handle A button press for room capture UI
   * @returns {boolean} True if button was consumed
   */
  handleButtonPress(button) {
    if (this.roomCaptureUI && this.roomCaptureUI.isVisible) {
      return this.roomCaptureUI.handleButtonPress(button);
    }
    return false;
  }

  /**
   * Initiate Meta Quest room capture after user confirms
   */
  _confirmRoomCapture() {
    if (this.roomCaptureAttempted) return;
    this.roomCaptureAttempted = true;

    if (this.roomCaptureUI) {
      this.roomCaptureUI.hide();
    }

    const session = this.robotSystem.world.renderer?.xr?.getSession?.();
    if (!session) {
      this.logger.warn("Cannot initiate room capture - no XR session");
      this._handleRoomCaptureFailed();
      return;
    }

    if (typeof session.initiateRoomCapture !== "function") {
      this.logger.warn(
        "initiateRoomCapture not available on session - user may need to set up Space manually"
      );
      this._handleRoomCaptureFailed();
      return;
    }

    this.logger.log("User confirmed - initiating room capture...");
    this._roomCaptureInProgress = true;

    session
      .initiateRoomCapture()
      .then(() => {
        this.logger.log(
          "Room capture initiated - waiting for user to complete setup..."
        );
        this._roomCaptureStartTime = performance.now();
      })
      .catch((error) => {
        this.logger.warn("Failed to initiate room capture:", error.message);
        this._roomCaptureInProgress = false;
        this._handleRoomCaptureFailed();
      });
  }

  /**
   * Verify room capture succeeded after user returns
   */
  _verifyRoomCaptureResult() {
    if (!this._roomCaptureInProgress) return;
    if (!this._roomCaptureStartTime) return;

    const elapsed = performance.now() - this._roomCaptureStartTime;

    // Wait at least 2 seconds after room capture initiated
    if (elapsed < 2000) return;

    const navSurfacesSystem = this.robotSystem.world.navSurfacesSystem;
    const surfaces = navSurfacesSystem?.getAllSurfaces() || [];

    if (surfaces.length >= this.minSurfacesForInit) {
      // Success!
      this.logger.log(
        `Room capture successful - ${surfaces.length} surfaces detected`
      );
      this._roomCaptureInProgress = false;
      gameState.setState({
        roomSetupRequired: false,
        roomCaptureFailed: false,
      });
    } else if (elapsed > 5000) {
      // Timeout - no surfaces after 5 seconds
      this.logger.warn(
        "Room capture appears to have failed - no surfaces after timeout"
      );
      this._roomCaptureInProgress = false;
      this._handleRoomCaptureFailed();
    }
  }

  /**
   * Handle room capture failure
   */
  _handleRoomCaptureFailed() {
    this.logger.warn("Room capture failed - showing failure UI");
    gameState.setState({
      roomSetupRequired: false,
      roomCaptureFailed: true,
    });

    this._showRoomCaptureFailedUI();
  }

  /**
   * Show room capture failed UI
   */
  async _showRoomCaptureFailedUI() {
    if (!this.roomCaptureUI) {
      this.roomCaptureUI = new RoomCaptureUI(this.robotSystem.world, {});
      await this.roomCaptureUI.initialize();
    }
    this.roomCaptureUI.showFailure();
  }

  dispose() {
    if (this.roomCaptureUI) {
      this.roomCaptureUI.hide();
      this.roomCaptureUI = null;
    }
  }
}
