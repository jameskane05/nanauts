/**
 * XrInputSystem.js - XR HAND AND CONTROLLER INPUT MANAGEMENT
 * =============================================================================
 *
 * ROLE: ECS system that manages XR hand tracking and controller input. Creates
 * fingertip colliders for hand tracking, handles pinch gesture detection, and
 * provides debug visualization for joints and buttons.
 *
 * KEY RESPONSIBILITIES:
 * - Initialize XRInputManager when XR session starts
 * - Create sphere colliders on fingertips for physics interaction
 * - Detect pinch gestures (thumb + index < 2cm)
 * - Track hand presence changes and joint availability
 * - Provide debug visualizers for hand joints and controller buttons
 * - Fire haptic feedback via HapticManager
 *
 * HAND TRACKING:
 * Uses @iwsdk/xr-input XRInputManager. Creates colliders on index/thumb tips.
 * Handles Meta Quest hand tracking joint naming conventions with fallbacks.
 *
 * CONTROLLER FEATURES:
 * Disabled until intro completes (controllerFeaturesEnabled flag).
 * Button debug visualizers show press state.
 *
 * REGISTRATION: this.world.xrInputSystem = this (for AIManager access)
 *
 * KNOWN ISSUES:
 * - Large file (~1500 lines) - consider splitting hand vs controller logic
 * - Joint availability can be delayed after hand tracking starts
 * =============================================================================
 */

import {
  createSystem,
  Interactable,
  Transform,
  Mesh,
  PhysicsShape,
  PhysicsBody,
  PhysicsState,
  PhysicsShapeType,
} from "@iwsdk/core";
import { XRInputManager } from "@iwsdk/xr-input";
import {
  SphereGeometry,
  MeshBasicMaterial,
  Group,
  Vector3 as THREEVector3,
  Color,
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Box3,
  Quaternion,
  Euler,
} from "three";
import { Logger } from "../utils/Logger.js";
import { hapticManager } from "../utils/HapticManager.js";
import { uiAudio } from "../audio/UIAudio.js";
import { gameState } from "../gameState.js";

export class XrInputSystem extends createSystem({}) {
  init() {
    this.xrInput = null;
    this.fingertipColliders = new Map(); // Map: handSide_fingerType -> { entity, colliderMesh, jointName }
    this.handAdapters = { left: null, right: null };
    this.controllerAdapters = { left: null, right: null };
    this.pinchStates = { left: false, right: false };
    this.pinchThreshold = 0.02; // 2cm distance for pinch detection
    this.debugVisualizers = new Map(); // Map: handSide_jointName -> { mesh, joint }
    this.buttonDebugVisualizers = new Map(); // Map: buttonId -> { wireframe, mesh }
    this.debugEnabled = true; // Enable debug visualizers by default
    this.logger = new Logger("XrInputSystem", true);

    // Controller/reticle visibility - disabled until intro completes
    this.controllerFeaturesEnabled = false;

    // MicroGestures state (XR_META_hand_tracking_microgestures)
    // Tap gesture replaces pinch for more reliable hand input
    this.microgesturesSupported = { left: false, right: false };
    this.tapStates = { left: false, right: false };

    this._setupIntroCompleteListener();

    // Make system accessible from world
    this.world.xrInputSystem = this;
  }

  _setupIntroCompleteListener() {
    gameState.on("state:changed", (newState, oldState) => {
      if (newState.introPlayed && !oldState.introPlayed) {
        this.logger.log("Intro complete - enabling controller features");
        this.setControllerFeaturesEnabled(true);
      }
    });

    // Check initial state in case we debug spawned past intro
    const currentState = gameState.getState();
    if (currentState.introPlayed) {
      this.logger.log(
        "Initial state has introPlayed=true - enabling controller features"
      );
      this.setControllerFeaturesEnabled(true);
    }
  }

  setControllerFeaturesEnabled(enabled) {
    this.controllerFeaturesEnabled = enabled;
    this._updateControllerVisibility();
  }

  _updateControllerVisibility() {
    if (!this.xrInput) return;

    // Hide/show controller models and rays
    const xrOrigin = this.xrInput.xrOrigin;
    if (xrOrigin) {
      xrOrigin.traverse((child) => {
        // Hide controller models and ray visuals, but keep tracking active
        if (
          child.name?.includes("controller") ||
          child.name?.includes("ray") ||
          child.name?.includes("pointer") ||
          child.name?.includes("reticle")
        ) {
          child.visible = this.controllerFeaturesEnabled;
        }
      });
    }

    this.logger.log(
      `Controller features ${
        this.controllerFeaturesEnabled ? "enabled" : "disabled"
      }`
    );
  }

  update(delta, time) {
    window.systemTiming?.start("HandInput");

    // Initialize XRInputManager when XR becomes active
    const isXRActive =
      this.world.visibilityState.value !==
      this.world.VisibilityState?.NonImmersive;
    if (isXRActive && !this.xrInput && this.world.renderer?.xr) {
      try {
        this.xrInput = new XRInputManager({
          scene: this.world.scene,
          camera: this.world.camera,
        });
        this.world.scene.add(this.xrInput.xrOrigin);
        this.logger.log("XRInputManager initialized");

        // Initialize haptic manager with world reference
        hapticManager.init(this.world);
        this.logger.log("HapticManager initialized");
        this.logger.log("visualAdapters:", this.xrInput.visualAdapters);
        this.logger.log("hand adapters available:", {
          left: !!this.xrInput.visualAdapters?.hand?.left,
          right: !!this.xrInput.visualAdapters?.hand?.right,
        });

        // Subscribe to the PRIMARY adapter signals (visualAdapters.left/right are Signals)
        // These signals switch between hand/controller based on what's currently primary
        // Note: visualAdapters.hand.left/right are direct adapter objects, NOT signals
        if (this.xrInput.visualAdapters) {
          const leftSignal = this.xrInput.visualAdapters.left;
          const rightSignal = this.xrInput.visualAdapters.right;

          // Subscribe to the primary adapter signals
          if (leftSignal && typeof leftSignal.subscribe === "function") {
            leftSignal.subscribe((adapter) => {
              this.logger.log(
                `Left primary adapter changed:`,
                adapter?.constructor?.name
              );
              this._handlePrimaryAdapterChange("left", adapter);
            });
            // Check current value
            if (leftSignal.value) {
              this._handlePrimaryAdapterChange("left", leftSignal.value);
            }
          }

          if (rightSignal && typeof rightSignal.subscribe === "function") {
            rightSignal.subscribe((adapter) => {
              this.logger.log(
                `Right primary adapter changed:`,
                adapter?.constructor?.name
              );
              this._handlePrimaryAdapterChange("right", adapter);
            });
            // Check current value
            if (rightSignal.value) {
              this._handlePrimaryAdapterChange("right", rightSignal.value);
            }
          }

          // Also keep references to the actual hand adapters for fingertip tracking
          if (this.xrInput.visualAdapters.hand) {
            this.logger.log("Hand adapters available (for fingertip tracking)");
          }
        } else {
          this.logger.warn("visualAdapters not available");
        }

        // Enable grab pointers for hands
        this.xrInput.multiPointers.left.toggleSubPointer("grab", true);
        this.xrInput.multiPointers.right.toggleSubPointer("grab", true);

        // Also check WebXR session's inputSources directly (per MDN WebXR Inputs docs)
        // https://developer.mozilla.org/en-US/docs/Web/API/WebXR_Device_API/Inputs
        const session = this.world.renderer.xr.getSession();
        if (session && session.inputSources) {
          this.logger.log(
            `WebXR session has ${session.inputSources.length} input sources`
          );
          for (const inputSource of session.inputSources) {
            this.logger.log(
              `Input source: handedness=${
                inputSource.handedness
              }, targetRayMode=${
                inputSource.targetRayMode
              }, hasGamepad=${!!inputSource.gamepad}`
            );
            if (
              inputSource.handedness === "left" ||
              inputSource.handedness === "right"
            ) {
              // This is a controller - the visual adapter should handle it, but log for debugging
              this.logger.log(
                `Found ${inputSource.handedness} controller via WebXR inputSources`
              );
            }
          }
        }

        // Listen for input source changes on the WebXR session
        if (session) {
          session.addEventListener("inputsourceschange", (event) => {
            this.logger.log(
              `WebXR inputsourceschange: added=${event.added.length}, removed=${event.removed.length}`
            );
            for (const inputSource of event.added) {
              this.logger.log(
                `Input source added: handedness=${inputSource.handedness}, targetRayMode=${inputSource.targetRayMode}`
              );
            }
            for (const inputSource of event.removed) {
              this.logger.log(
                `Input source removed: handedness=${inputSource.handedness}`
              );
            }
          });
        }

        // Apply initial controller visibility (hidden until intro completes)
        this._updateControllerVisibility();
      } catch (error) {
        this.logger.error("Could not initialize XRInputManager:", error);
        this.logger.error("Error stack:", error.stack);
      }
    }

    // Update XRInputManager each frame (this is critical - it updates joint poses)
    if (this.xrInput && this.world.renderer?.xr) {
      this.xrInput.update(this.world.renderer.xr, delta, time);

      // After update, check if jointSpaces have been populated
      // Joints are updated via XRFrame.fillPoses, which happens during xrInput.update()
      if (this.xrInput.visualAdapters?.hand) {
        for (const side of ["left", "right"]) {
          const adapter = this.xrInput.visualAdapters.hand[side];
          if (adapter) {
            // Get current value (might be reactive source or direct value)
            const currentAdapter =
              adapter.value !== undefined ? adapter.value : adapter;
            if (currentAdapter && currentAdapter.jointSpaces) {
              const jointSpaces = currentAdapter.jointSpaces;
              // Check if joints are now available
              let hasJoints = false;
              if (jointSpaces instanceof Map) {
                hasJoints = jointSpaces.size > 0;
              } else if (Array.isArray(jointSpaces)) {
                hasJoints = jointSpaces.length > 0;
              } else {
                hasJoints = Object.keys(jointSpaces).length > 0;
              }

              // If we have a pending adapter for this side and joints are now available, create colliders
              if (hasJoints && this._pendingHandAdapters?.[side]) {
                console.debug(
                  `[XrInputSystem] Joints now available for ${side} hand after XR update`
                );
                delete this._pendingHandAdapters[side];
                // Update the stored adapter
                this.handAdapters[side] = currentAdapter;
                this.createFingertipColliders(side);
              }
            }
          }
        }
      }
    }

    // Poll primary adapter signals as fallback (in case subscribe didn't work)
    // visualAdapters.left/right are the signals that switch between hand/controller
    if (this.xrInput?.visualAdapters) {
      const leftSignal = this.xrInput.visualAdapters.left;
      const rightSignal = this.xrInput.visualAdapters.right;

      // Poll left primary adapter
      if (leftSignal?.value !== undefined) {
        const currentAdapter = leftSignal.value;
        const currentIsHand = currentAdapter?.jointSpaces !== undefined;
        const storedIsHand = this.handAdapters.left !== null;
        const storedIsController = this.controllerAdapters.left !== null;

        // Detect changes
        if (currentIsHand && !storedIsHand) {
          this._handlePrimaryAdapterChange("left", currentAdapter);
        } else if (!currentIsHand && currentAdapter && !storedIsController) {
          this._handlePrimaryAdapterChange("left", currentAdapter);
        } else if (!currentAdapter && (storedIsHand || storedIsController)) {
          this._handlePrimaryAdapterChange("left", null);
        }
      }

      // Poll right primary adapter
      if (rightSignal?.value !== undefined) {
        const currentAdapter = rightSignal.value;
        const currentIsHand = currentAdapter?.jointSpaces !== undefined;
        const storedIsHand = this.handAdapters.right !== null;
        const storedIsController = this.controllerAdapters.right !== null;

        // Detect changes
        if (currentIsHand && !storedIsHand) {
          this._handlePrimaryAdapterChange("right", currentAdapter);
        } else if (!currentIsHand && currentAdapter && !storedIsController) {
          this._handlePrimaryAdapterChange("right", currentAdapter);
        } else if (!currentAdapter && (storedIsHand || storedIsController)) {
          this._handlePrimaryAdapterChange("right", null);
        }
      }
    }

    // Retry creating colliders for pending hand adapters (joints may initialize later)
    if (this._pendingHandAdapters) {
      for (const [side, adapter] of Object.entries(this._pendingHandAdapters)) {
        const jointSpaces = adapter?.jointSpaces;
        if (
          jointSpaces &&
          (Array.isArray(jointSpaces)
            ? jointSpaces.length > 0
            : Object.keys(jointSpaces).length > 0)
        ) {
          console.debug(
            `[XrInputSystem] Retrying collider creation for ${side} hand - joints now available`
          );
          delete this._pendingHandAdapters[side];
          this.createFingertipColliders(side);
        }
      }
    }

    // Update fingertip colliders to follow hand joints
    this.updateFingertipColliders(delta, time);

    // Detect pinch gestures
    this.updatePinchDetection();

    // Update hit test manager if available
    if (this.world.hitTestManager) {
      const xrFrame = this.world.renderer?.xr?.getFrame?.();
      if (xrFrame) {
        this.world.hitTestManager.update(xrFrame, delta);
      }
      // Keep XR input in sync
      if (this.xrInput) {
        this.world.hitTestManager.setXRInput(this.xrInput);
      }
    }

    window.systemTiming?.end("HandInput");
  }

  _handlePrimaryAdapterChange(side, adapter) {
    // Detect if the primary adapter is a hand or controller by checking for hand-specific properties
    // XRHandVisualAdapter has: jointSpaces, indexTip, thumbTip, pinchData
    // XRControllerVisualAdapter doesn't have these
    const isHand =
      adapter &&
      (adapter.jointSpaces !== undefined || adapter.indexTip !== undefined);
    const isController = adapter && !isHand;

    this.logger.log(
      `Primary adapter (${side}): ${
        isHand ? "HAND" : isController ? "CONTROLLER" : "NONE"
      }`
    );

    if (isHand) {
      this.handleHandAdapterChange(side, adapter);
      this.handleControllerAdapterChange(side, null);
    } else if (isController) {
      this.handleControllerAdapterChange(side, adapter);
      this.handleHandAdapterChange(side, null);
    } else {
      this.handleHandAdapterChange(side, null);
      this.handleControllerAdapterChange(side, null);
    }
  }

  handleHandAdapterChange(side, adapter) {
    const wasPresent = this.handAdapters[side] !== null;
    const isPresent = adapter !== null && adapter !== undefined;

    this.handAdapters[side] = adapter;

    if (isPresent && !wasPresent) {
      this.logger.log(`${side} hand appeared`);
      this.createFingertipColliders(side);
      this.notifyInputChange();
    } else if (!isPresent && wasPresent) {
      this.logger.log(`${side} hand disappeared`);
      this.destroyFingertipColliders(side);
      this.notifyInputChange();
    }
  }

  handleControllerAdapterChange(side, adapter) {
    const wasPresent = this.controllerAdapters[side] !== null;
    const isPresent = adapter !== null;

    this.controllerAdapters[side] = adapter;

    if ((isPresent && !wasPresent) || (!isPresent && wasPresent)) {
      this.logger.log(
        `${side} controller ${isPresent ? "appeared" : "disappeared"}`
      );
      this.notifyInputChange();
    }
  }

  notifyInputChange() {
    const hasHands = this.hasHands();
    const hasControllers = this.hasControllers();

    // Update gameState with current input mode
    // Prefer hands if detected, fall back to controllers
    const newInputMode = hasHands ? "hands" : "controllers";
    const currentState = gameState.getState();
    if (currentState.inputMode !== newInputMode) {
      this.logger.log(
        `Input mode changed: ${currentState.inputMode} -> ${newInputMode}`
      );
      gameState.setState({ inputMode: newInputMode });
    }

    // Notify AIManager about input changes
    const aiManager = this.world.aiManager;
    if (
      aiManager &&
      aiManager.inputHandler &&
      aiManager.inputHandler.handleInputSourceChange
    ) {
      aiManager.inputHandler.handleInputSourceChange(hasHands, hasControllers);
    }
  }

  hasHands() {
    return this.handAdapters.left !== null || this.handAdapters.right !== null;
  }

  hasControllers() {
    return (
      this.controllerAdapters.left !== null ||
      this.controllerAdapters.right !== null
    );
  }

  createFingertipColliders(side) {
    // Disabled for now - fingertip colliders are incomplete/experimental
    return;

    const adapter = this.handAdapters[side];

    if (!adapter) {
      this.logger.warn(`Cannot create colliders: ${side} hand adapter missing`);
      return;
    }

    // XRHandVisualAdapter uses jointSpaces, not a model property
    // Joints are updated via XRFrame.fillPoses during xrInput.update()
    // The visual implementation should have the model with joint bones
    const visual = adapter.visual;
    if (!visual || !visual.model) {
      if (!this._visualNotReadyLogged?.[side]) {
        console.debug(
          `[XrInputSystem] Visual or model not ready yet for ${side} hand, will retry`
        );
        this._visualNotReadyLogged = this._visualNotReadyLogged || {};
        this._visualNotReadyLogged[side] = true;
      }
      this._pendingHandAdapters = this._pendingHandAdapters || {};
      this._pendingHandAdapters[side] = adapter;
      return;
    }

    const jointSpaces = adapter.jointSpaces;
    if (!jointSpaces) {
      if (!this._jointSpacesMissingLogged?.[side]) {
        this.logger.warn(
          `Cannot create colliders: ${side} hand jointSpaces missing`
        );
        this._jointSpacesMissingLogged = this._jointSpacesMissingLogged || {};
        this._jointSpacesMissingLogged[side] = true;
      }
      // Store adapter reference to retry later
      this._pendingHandAdapters = this._pendingHandAdapters || {};
      this._pendingHandAdapters[side] = adapter;
      return;
    }

    // Check if jointSpaces is a Map
    if (jointSpaces instanceof Map) {
      if (jointSpaces.size === 0) {
        if (!this._emptyJointSpacesLogged?.[side]) {
          console.debug(
            `[XrInputSystem] jointSpaces Map is empty for ${side} hand - will retry`
          );
          this._emptyJointSpacesLogged = this._emptyJointSpacesLogged || {};
          this._emptyJointSpacesLogged[side] = true;
        }
        this._pendingHandAdapters = this._pendingHandAdapters || {};
        this._pendingHandAdapters[side] = adapter;
        return;
      }
    } else if (Array.isArray(jointSpaces)) {
      if (jointSpaces.length === 0) {
        if (!this._emptyJointSpacesLogged?.[side]) {
          console.debug(
            `[XrInputSystem] jointSpaces array is empty for ${side} hand - will retry`
          );
          this._emptyJointSpacesLogged = this._emptyJointSpacesLogged || {};
          this._emptyJointSpacesLogged[side] = true;
        }
        this._pendingHandAdapters = this._pendingHandAdapters || {};
        this._pendingHandAdapters[side] = adapter;
        return;
      }
    } else {
      // It's an object
      const keys = Object.keys(jointSpaces);
      if (keys.length === 0) {
        if (!this._emptyJointSpacesLogged?.[side]) {
          console.debug(
            `[XrInputSystem] jointSpaces object is empty for ${side} hand - will retry`
          );
          this._emptyJointSpacesLogged = this._emptyJointSpacesLogged || {};
          this._emptyJointSpacesLogged[side] = true;
        }
        this._pendingHandAdapters = this._pendingHandAdapters || {};
        this._pendingHandAdapters[side] = adapter;
        return;
      }
    }

    // Create debug visualizers only for pointer and thumb tips if debug enabled
    if (this.debugEnabled) {
      this.createTipDebugVisualizers(side, adapter);
    }

    // Hand joint names for index finger tip and thumb tip
    // These are standard WebXR hand joint names
    const jointNames = {
      index: "index-finger-tip",
      thumb: "thumb-tip",
    };

    // Helper function to get joint from jointSpaces (handles Map, object, or array)
    // WebXR hand joint indices (0-24):
    // 0: wrist
    // 1-4: thumb (1=metacarpal, 2=phalanx-proximal, 3=phalanx-distal, 4=tip)
    // 5-9: index (5=metacarpal, 6=phalanx-proximal, 7=phalanx-intermediate, 8=phalanx-distal, 9=tip)
    // 10-14: middle
    // 15-19: ring
    // 20-24: pinky
    const jointIndexMap = {
      wrist: 0,
      "thumb-metacarpal": 1,
      "thumb-phalanx-proximal": 2,
      "thumb-phalanx-distal": 3,
      "thumb-tip": 4,
      "index-finger-metacarpal": 5,
      "index-finger-phalanx-proximal": 6,
      "index-finger-phalanx-intermediate": 7,
      "index-finger-phalanx-distal": 8,
      "index-finger-tip": 9,
      "middle-finger-metacarpal": 10,
      "middle-finger-phalanx-proximal": 11,
      "middle-finger-phalanx-intermediate": 12,
      "middle-finger-phalanx-distal": 13,
      "middle-finger-tip": 14,
      "ring-finger-metacarpal": 15,
      "ring-finger-phalanx-proximal": 16,
      "ring-finger-phalanx-intermediate": 17,
      "ring-finger-phalanx-distal": 18,
      "ring-finger-tip": 19,
      "pinky-finger-metacarpal": 20,
      "pinky-finger-phalanx-proximal": 21,
      "pinky-finger-phalanx-intermediate": 22,
      "pinky-finger-phalanx-distal": 23,
      "pinky-finger-tip": 24,
    };

    const getJointSpace = (name) => {
      if (jointSpaces instanceof Map) {
        return jointSpaces.get(name);
      } else if (Array.isArray(jointSpaces)) {
        // jointSpaces is an array of XRJointSpace objects indexed by WebXR hand joint index
        const index = jointIndexMap[name];
        if (index !== undefined && jointSpaces[index]) {
          return jointSpaces[index];
        }
        // Fallback: try to find by name property if it exists
        return jointSpaces.find(
          (j) => j?.name === name || j?.jointName === name
        );
      } else {
        return jointSpaces[name];
      }
    };

    for (const [fingerType, jointName] of Object.entries(jointNames)) {
      // Get joint space from jointSpaces (handles Map, object, or array)
      let jointSpace = getJointSpace(jointName);

      if (!jointSpace) {
        this.logger.warn(
          `Joint ${jointName} not found in ${side} hand jointSpaces`
        );
        // Try alternative names
        const altNames = [
          `hand-${side}-${jointName}`,
          `${side}-${jointName}`,
          jointName.replace(/-/g, "_"),
        ];
        let found = false;
        for (const altName of altNames) {
          jointSpace = getJointSpace(altName);
          if (jointSpace) {
            console.debug(
              `[XrInputSystem] Found joint with alternative name: ${altName}`
            );
            this.createColliderForJoint(
              side,
              fingerType,
              jointName,
              jointSpace
            );
            found = true;
            break;
          }
        }
        if (!found) {
          continue;
        }
      } else {
        this.createColliderForJoint(side, fingerType, jointName, jointSpace);
      }
    }
  }

  createColliderForJoint(side, fingerType, jointName, jointSpace) {
    const key = `${side}_${fingerType}`;

    // XRJointSpace is not an Object3D - it's a reference to a joint
    // We need to find the actual joint transform in the hand model
    // The hand visual adapter should have a model with joint bones
    const adapter = this.handAdapters[side];
    if (!adapter) {
      this.logger.warn(`Cannot create collider: ${side} hand adapter missing`);
      return;
    }

    // Try to get the visual implementation which should have the model
    const visual = adapter.visual;
    if (!visual || !visual.model) {
      this.logger.warn(
        `Hand visual or model not available yet for ${side} hand`
      );
      // Store for retry later when visual is loaded
      this._pendingHandAdapters = this._pendingHandAdapters || {};
      this._pendingHandAdapters[side] = adapter;
      return;
    }

    // Find the joint bone in the hand model by name
    // Joint names in the model might match the jointName or be variations
    const model = visual.model;
    let actualObject3D = null;

    // Try to find joint by name in the model
    const jointVariations = [
      jointName,
      jointName.replace(/-/g, "_"),
      jointName.replace(/-/g, ""),
      `hand-${side}-${jointName}`,
      `${side}-${jointName}`,
    ];

    for (const variant of jointVariations) {
      actualObject3D = model.getObjectByName(variant);
      if (actualObject3D) {
        break;
      }
    }

    // If not found by name, try traversing to find bones that match
    if (!actualObject3D) {
      model.traverse((node) => {
        if (node.isBone || node.isObject3D) {
          const nodeName = node.name?.toLowerCase() || "";
          const searchName = jointName.toLowerCase();
          if (nodeName.includes(searchName) || searchName.includes(nodeName)) {
            // Prefer exact matches or matches containing "tip"
            if (
              nodeName === searchName ||
              (nodeName.includes("tip") && searchName.includes("tip"))
            ) {
              actualObject3D = node;
            }
          }
        }
      });
    }

    if (!actualObject3D) {
      if (!this._jointNotFoundLogged?.[`${side}_${jointName}`]) {
        this.logger.warn(
          `Could not find joint ${jointName} in hand model for ${side} hand`
        );
        this._jointNotFoundLogged = this._jointNotFoundLogged || {};
        this._jointNotFoundLogged[`${side}_${jointName}`] = true;
      }
      return;
    }
    // Create collider mesh - slightly larger for better interaction
    const colliderRadius = 0.015; // 1.5cm radius for better hit detection
    const colliderGeometry = new SphereGeometry(colliderRadius, 8, 8);
    const colliderMaterial = new MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.3, // Slightly visible for debugging - can set to 0.0 later
    });
    const colliderMesh = new Mesh(colliderGeometry, colliderMaterial);
    colliderMesh.name = `fingertip-${side}-${fingerType}`;

    // Make sure the mesh is visible to raycasters/pointer system
    colliderMesh.visible = true;
    colliderMesh.matrixAutoUpdate = true;

    // Create entity for collider
    const colliderEntity = this.world.createTransformEntity(colliderMesh);

    // Interactable component makes this mesh receive pointer events
    // But we also want it to trigger pointer events on OTHER objects it touches
    // The grab pointer system should handle this automatically via intersection detection
    colliderEntity.addComponent(Interactable);

    // Add physics collider (Kinematic so it follows hand joints but still detects collisions)
    // For Sphere, dimensions is [radius, 0, 0] per physics docs
    colliderEntity.addComponent(PhysicsShape, {
      shape: PhysicsShapeType.Sphere,
      dimensions: [colliderRadius, 0, 0], // 1.5cm radius sphere
    });
    colliderEntity.addComponent(PhysicsBody, {
      state: PhysicsState.Kinematic, // Follows hand joints but still has collision detection
    });

    // Attach collider to joint space (actualObject3D is the Object3D transform for the joint)
    actualObject3D.add(colliderMesh);

    // Store reference
    this.fingertipColliders.set(key, {
      entity: colliderEntity,
      colliderMesh: colliderMesh,
      joint: actualObject3D, // Store the actual Object3D
      jointName: jointName,
      side: side,
      fingerType: fingerType,
    });

    console.debug(
      `[XrInputSystem] Created ${side} ${fingerType} fingertip collider at joint ${jointName}`
    );
  }

  createTipDebugVisualizers(side, adapter) {
    // Only create debug visuals for pointer and thumb tips
    if (!adapter || !adapter.jointSpaces) {
      return;
    }

    const visual = adapter.visual;
    if (!visual || !visual.model) {
      return;
    }

    const model = visual.model;
    const tipJointNames = ["index-finger-tip", "thumb-tip"];
    const jointIndexMap = {
      "thumb-tip": 4,
      "index-finger-tip": 9,
    };

    for (const jointName of tipJointNames) {
      // Find joint bone in model
      let actualObject3D = null;
      const jointVariations = [
        jointName,
        jointName.replace(/-/g, "_"),
        jointName.replace(/-/g, ""),
        `hand-${side}-${jointName}`,
        `${side}-${jointName}`,
      ];

      for (const variant of jointVariations) {
        actualObject3D = model.getObjectByName(variant);
        if (actualObject3D) break;
      }

      if (!actualObject3D) {
        model.traverse((node) => {
          if (node.isBone || node.isObject3D) {
            const nodeName = node.name?.toLowerCase() || "";
            const searchName = jointName.toLowerCase();
            if (nodeName.includes(searchName) && searchName.includes("tip")) {
              actualObject3D = node;
            }
          }
        });
      }

      if (actualObject3D && actualObject3D.isObject3D) {
        // Determine color
        const color = jointName.includes("thumb") ? 0xff00ff : 0x00ff00; // Magenta for thumb, green for index

        const debugGeometry = new SphereGeometry(0.015, 8, 8); // 1.5cm radius
        const debugMaterial = new MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: 0.8,
        });
        const debugMesh = new Mesh(debugGeometry, debugMaterial);
        debugMesh.name = `debug-${side}-${jointName}`;

        actualObject3D.add(debugMesh);

        const key = `${side}_${jointName}`;
        this.debugVisualizers.set(key, {
          mesh: debugMesh,
          joint: actualObject3D,
          side: side,
          fingerType: jointName.includes("thumb") ? "thumb" : "index",
        });

        console.debug(
          `[XrInputSystem] Created debug visualizer for ${side} ${jointName}`
        );
      }
    }
  }

  createAllJointDebugVisualizers(side, adapter) {
    if (!adapter || !adapter.jointSpaces) {
      this.logger.warn(
        `Cannot create debug visualizers: adapter or jointSpaces missing`
      );
      return;
    }

    this.logger.log(`Creating debug visualizers for ${side} hand`);
    const jointSpaces = adapter.jointSpaces;
    this.logger.log(`Available joints:`, Object.keys(jointSpaces));

    // Standard WebXR hand joint names
    const allJointNames = [
      "wrist",
      "thumb-metacarpal",
      "thumb-phalanx-proximal",
      "thumb-phalanx-distal",
      "thumb-tip",
      "index-finger-metacarpal",
      "index-finger-phalanx-proximal",
      "index-finger-phalanx-intermediate",
      "index-finger-phalanx-distal",
      "index-finger-tip",
      "middle-finger-metacarpal",
      "middle-finger-phalanx-proximal",
      "middle-finger-phalanx-intermediate",
      "middle-finger-phalanx-distal",
      "middle-finger-tip",
      "ring-finger-metacarpal",
      "ring-finger-phalanx-proximal",
      "ring-finger-phalanx-intermediate",
      "ring-finger-phalanx-distal",
      "ring-finger-tip",
      "pinky-finger-metacarpal",
      "pinky-finger-phalanx-proximal",
      "pinky-finger-phalanx-intermediate",
      "pinky-finger-phalanx-distal",
      "pinky-finger-tip",
    ];

    // WebXR hand joint index mapping (same as above)
    const jointIndexMap = {
      wrist: 0,
      "thumb-metacarpal": 1,
      "thumb-phalanx-proximal": 2,
      "thumb-phalanx-distal": 3,
      "thumb-tip": 4,
      "index-finger-metacarpal": 5,
      "index-finger-phalanx-proximal": 6,
      "index-finger-phalanx-intermediate": 7,
      "index-finger-phalanx-distal": 8,
      "index-finger-tip": 9,
      "middle-finger-metacarpal": 10,
      "middle-finger-phalanx-proximal": 11,
      "middle-finger-phalanx-intermediate": 12,
      "middle-finger-phalanx-distal": 13,
      "middle-finger-tip": 14,
      "ring-finger-metacarpal": 15,
      "ring-finger-phalanx-proximal": 16,
      "ring-finger-phalanx-intermediate": 17,
      "ring-finger-phalanx-distal": 18,
      "ring-finger-tip": 19,
      "pinky-finger-metacarpal": 20,
      "pinky-finger-phalanx-proximal": 21,
      "pinky-finger-phalanx-intermediate": 22,
      "pinky-finger-phalanx-distal": 23,
      "pinky-finger-tip": 24,
    };

    // Get all available joints from jointSpaces (handles Map, object, or array)
    let availableJoints = [];
    if (jointSpaces instanceof Map) {
      availableJoints = Array.from(jointSpaces.keys());
    } else if (Array.isArray(jointSpaces)) {
      // If it's an array, use the joint index map to get names
      availableJoints = Object.keys(jointIndexMap);
    } else {
      availableJoints = Object.keys(jointSpaces);
    }

    this.logger.log(
      `Creating visualizers for ${availableJoints.length} joints`
    );

    let foundJoints = 0;
    for (const jointName of availableJoints) {
      let jointSpace;
      if (jointSpaces instanceof Map) {
        jointSpace = jointSpaces.get(jointName);
      } else if (Array.isArray(jointSpaces)) {
        // Use WebXR hand joint index mapping
        const index = jointIndexMap[jointName];
        if (index !== undefined && jointSpaces[index]) {
          jointSpace = jointSpaces[index];
        } else {
          // Fallback: try to find by name property
          jointSpace = jointSpaces.find(
            (j) => (j?.name || j?.jointName) === jointName
          );
        }
      } else {
        jointSpace = jointSpaces[jointName];
      }

      // XRJointSpace is not an Object3D - find the corresponding bone in the hand model
      const adapter = this.handAdapters[side];
      const visual = adapter?.visual;
      const model = visual?.model;

      if (!model) {
        continue;
      }

      // Find joint bone in model by matching jointName
      let actualObject3D = null;
      const jointVariations = [
        jointName,
        jointName.replace(/-/g, "_"),
        jointName.replace(/-/g, ""),
        `hand-${side}-${jointName}`,
        `${side}-${jointName}`,
      ];

      for (const variant of jointVariations) {
        actualObject3D = model.getObjectByName(variant);
        if (actualObject3D) break;
      }

      // If not found by name, traverse to find matching bones
      if (!actualObject3D) {
        model.traverse((node) => {
          if (node.isBone || node.isObject3D) {
            const nodeName = node.name?.toLowerCase() || "";
            const searchName = jointName.toLowerCase();
            if (
              nodeName.includes(searchName) ||
              searchName.includes(nodeName)
            ) {
              if (
                nodeName === searchName ||
                (nodeName.includes("tip") && searchName.includes("tip"))
              ) {
                actualObject3D = node;
              }
            }
          }
        });
      }

      if (actualObject3D && actualObject3D.isObject3D) {
        foundJoints++;
        this.logger.log(
          `Found joint bone: ${jointName} -> ${actualObject3D.name}`
        );
        // Determine finger type for color coding
        let fingerType = "other";
        let color = 0x888888; // Gray for other joints
        if (jointName.includes("thumb")) {
          fingerType = "thumb";
          color = 0xff00ff; // Magenta
        } else if (jointName.includes("index")) {
          fingerType = "index";
          color = 0x00ff00; // Green
        } else if (jointName.includes("middle")) {
          fingerType = "middle";
          color = 0x0000ff; // Blue
        } else if (jointName.includes("ring")) {
          fingerType = "ring";
          color = 0xffff00; // Yellow
        } else if (jointName.includes("pinky")) {
          fingerType = "pinky";
          color = 0xff8800; // Orange
        } else if (jointName === "wrist") {
          fingerType = "wrist";
          color = 0xffffff; // White
        }

        // Smaller spheres for non-tip joints
        const isTip = jointName.includes("tip");
        const radius = isTip ? 0.015 : 0.008; // 1.5cm for tips, 0.8cm for others

        const debugGeometry = new SphereGeometry(radius, 8, 8);
        const debugMaterial = new MeshBasicMaterial({
          color: color,
          transparent: true,
          opacity: isTip ? 0.8 : 0.5, // More opaque for tips
        });
        const debugMesh = new Mesh(debugGeometry, debugMaterial);
        debugMesh.name = `debug-${side}-${jointName}`;

        // Attach to joint space
        actualObject3D.add(debugMesh);

        // Store reference
        const key = `${side}_${jointName}`;
        this.debugVisualizers.set(key, {
          mesh: debugMesh,
          joint: actualObject3D,
          side: side,
          fingerType: fingerType,
        });
      } else {
        this.logger.log(`Joint space not valid Object3D: ${jointName}`);
      }
    }

    this.logger.log(
      `Created debug visualizers for ${side} hand: ${foundJoints}/${availableJoints.length} joints found`
    );
  }

  createJointDebugVisualizer(side, jointName, joint, fingerType) {
    // This is called for specific joints during collider creation
    // The full joint visualization is handled by createAllJointDebugVisualizers
    // But we can add special highlighting here if needed
  }

  findJointInModel(model, jointName) {
    // Try exact match first
    let joint = model.getObjectByName(jointName);
    if (joint) return joint;

    // Try variations of the joint name
    const variations = [
      jointName,
      jointName.replace(/-/g, "_"),
      jointName.replace(/-/g, ""),
      jointName.toLowerCase(),
      jointName.toUpperCase(),
    ];

    for (const variant of variations) {
      joint = model.getObjectByName(variant);
      if (joint) return joint;
    }

    // Try case-insensitive search
    model.traverse((node) => {
      if (node.name) {
        const nodeNameLower = node.name.toLowerCase();
        const searchNameLower = jointName.toLowerCase();
        // Check if node name contains the joint name or vice versa
        if (
          nodeNameLower.includes(searchNameLower) ||
          searchNameLower.includes(nodeNameLower)
        ) {
          // Prefer exact matches or matches that contain "tip"
          if (
            nodeNameLower === searchNameLower ||
            (nodeNameLower.includes("tip") && searchNameLower.includes("tip"))
          ) {
            joint = node;
          }
        }
      }
    });

    return joint;
  }

  destroyFingertipColliders(side) {
    const keysToRemove = [];
    for (const [key, data] of this.fingertipColliders.entries()) {
      if (data.side === side) {
        // Remove mesh from joint
        if (data.joint && data.colliderMesh) {
          data.joint.remove(data.colliderMesh);
        }

        // Remove entity (if world supports it)
        if (data.entity && typeof this.world.removeEntity === "function") {
          this.world.removeEntity(data.entity);
        }

        // Dispose geometry and material
        if (data.colliderMesh) {
          if (data.colliderMesh.geometry) data.colliderMesh.geometry.dispose();
          if (data.colliderMesh.material) data.colliderMesh.material.dispose();
        }

        keysToRemove.push(key);
      }
    }

    for (const key of keysToRemove) {
      this.fingertipColliders.delete(key);
    }

    // Remove debug visualizers
    const debugKeysToRemove = [];
    for (const [key, debugData] of this.debugVisualizers.entries()) {
      if (debugData.side === side) {
        // Remove mesh from joint
        if (debugData.joint && debugData.mesh) {
          debugData.joint.remove(debugData.mesh);
        }

        // Dispose geometry and material
        if (debugData.mesh) {
          if (debugData.mesh.geometry) debugData.mesh.geometry.dispose();
          if (debugData.mesh.material) debugData.mesh.material.dispose();
        }

        debugKeysToRemove.push(key);
      }
    }

    for (const key of debugKeysToRemove) {
      this.debugVisualizers.delete(key);
    }

    this.logger.log(
      `Destroyed ${side} hand fingertip colliders and debug visualizers`
    );
  }

  updateFingertipColliders(delta, time) {
    // Disabled - fingertip colliders are disabled
    return;
  }

  updatePinchDetection() {
    if (!this.xrInput) return;

    // Debug: Log gamepad availability once per second
    if (!this._lastGamepadLog || Date.now() - this._lastGamepadLog > 5000) {
      this._lastGamepadLog = Date.now();
      const state = gameState.getState();
      this.logger.log(
        `Gamepad check - inputMode: ${state.inputMode}, left: ${!!this.xrInput
          .gamepads?.left}, right: ${!!this.xrInput.gamepads
          ?.right}, microgestures: L=${this.microgesturesSupported.left} R=${
          this.microgesturesSupported.right
        }`
      );
    }

    // Try microgestures first (tap gesture), fall back to pinch
    let microgestureHandled = { left: false, right: false };
    try {
      microgestureHandled = this._updateMicrogestureDetection();
    } catch (e) {
      this.logger.warn("Microgesture detection error:", e);
    }

    // Microgestures (tap) handles hand input - no pinch fallback (too many false positives)
    // Controllers still use trigger via their own input path
  }

  _updateMicrogestureDetection() {
    const handled = { left: false, right: false };
    const session = this.world.renderer?.xr?.getSession?.();
    if (!session?.inputSources) return handled;

    // Debug log input sources once
    if (!this._inputSourcesLogged) {
      this._inputSourcesLogged = true;
      this.logger.log(`Raw WebXR inputSources: ${session.inputSources.length}`);
      for (const src of session.inputSources) {
        this.logger.log(
          `  - ${
            src.handedness
          }: hand=${!!src.hand}, gamepad=${!!src.gamepad}, targetRayMode=${
            src.targetRayMode
          }`
        );
        if (src.gamepad) {
          this.logger.log(
            `    gamepad buttons: ${src.gamepad.buttons?.length || 0}`
          );
        }
      }
    }

    for (const inputSource of session.inputSources) {
      // Check for hand input with gamepad (microgestures)
      // Some runtimes expose hand input without inputSource.hand but with gamepad
      const hasGamepad = !!inputSource.gamepad;
      const isHandInput =
        inputSource.hand || inputSource.targetRayMode === "tracked-pointer";

      // Skip if no gamepad at all
      if (!hasGamepad) continue;

      const side = inputSource.handedness;
      if (side !== "left" && side !== "right") continue;

      const gamepad = inputSource.gamepad;
      const buttons = gamepad.buttons;

      // XR_META_hand_tracking_microgestures exposes tap as additional button
      // Standard hand tracking: button 0 = select (pinch)
      // With microgestures: button indices vary by runtime, but tap is typically exposed
      // Button mapping (Meta Quest with microgestures):
      //   0: select/pinch
      //   1: squeeze (if supported)
      //   2+: microgestures (tap, swipes)
      // We detect microgesture support by checking for > 2 buttons on hand input

      this._checkMicrogestureSupport(side, buttons);

      // Log button states periodically to debug tap detection
      if (!this.microgesturesSupported[side]) continue;

      // Get the best available gesture button
      // Per oculus-hand.json: tap-thumb is button 9, pinch is button 0
      const tapButtonIndex = this._getTapButtonIndex(buttons);
      if (tapButtonIndex === -1) continue;

      const gestureButton = buttons[tapButtonIndex];
      const gestureValue = gestureButton?.value || 0;
      const gesturePressed = gestureButton?.pressed || gestureValue > 0.5;
      const wasPressed = this.tapStates[side];
      const gestureName = tapButtonIndex === 9 ? "tap-thumb" : "pinch";

      // Debounce: require gesture to be released for at least 200ms before re-triggering
      if (!this._lastGestureEnd) this._lastGestureEnd = {};
      const timeSinceLastEnd = Date.now() - (this._lastGestureEnd[side] || 0);
      const debounceOk = timeSinceLastEnd > 200;

      if (gesturePressed && !wasPressed && debounceOk) {
        this.logger.log(
          `${gestureName} START (${side}) btn[${tapButtonIndex}]=${gestureValue.toFixed(
            2
          )}`
        );
        this.tapStates[side] = true;
        this._handleSelectStart(side);
        handled[side] = true;
      } else if (!gesturePressed && wasPressed) {
        this.logger.log(`${gestureName} END (${side})`);
        this.tapStates[side] = false;
        this._lastGestureEnd[side] = Date.now();
        this._handleSelectEnd(side);
        handled[side] = true;
      } else if (this.microgesturesSupported[side]) {
        handled[side] = true;
      }
    }

    return handled;
  }

  _checkMicrogestureSupport(side, buttons) {
    // Require full oculus-hand profile with tap-thumb at index 9
    // Per: https://github.com/immersive-web/webxr-input-profiles/blob/main/packages/registry/profiles/oculus/oculus-hand.json
    const wasSupported = this.microgesturesSupported[side];
    const hasTapThumb = buttons.length >= 10;

    if (hasTapThumb) {
      this.microgesturesSupported[side] = true;
      if (!wasSupported) {
        this.logger.log(
          `Tap-thumb SUPPORTED on ${side} hand (${buttons.length} buttons, using button 9)`
        );
      }
    } else {
      this.microgesturesSupported[side] = false;
      if (wasSupported) {
        this.logger.log(
          `Tap-thumb NO LONGER supported on ${side} hand (only ${buttons.length} buttons)`
        );
      }
    }
  }

  _getTapButtonIndex(buttons) {
    // Per oculus-hand.json WebXR Input Profile:
    // https://github.com/immersive-web/webxr-input-profiles/blob/main/packages/registry/profiles/oculus/oculus-hand.json
    // Button mapping for Quest hand tracking:
    //   0: xr-standard-trigger (pinch) - DISABLED, too many false positives
    //   1-4: null (menu at 4 on left hand only)
    //   5: swipe-left
    //   6: swipe-right
    //   7: swipe-forward
    //   8: swipe-backward
    //   9: tap-thumb
    if (buttons.length >= 10) {
      return 9; // tap-thumb only
    }
    return -1; // No pinch fallback
  }

  _handleSelectStart(side) {
    // Only handle select for hands - controllers go through pollGamepadButtons
    const state = gameState.getState();
    if (state.inputMode !== "hands") {
      return;
    }

    // Try to answer call first (spatialUIManager intercept) - no haptic until confirmed
    const spatialUI = this.world.spatialUIManager;
    if (spatialUI?.handleButtonPress("a")) {
      hapticManager.pulse(side, 0.6, 40);
      uiAudio.press();
      this.logger.log(`Pinch (${side}) answered call`);
      return;
    }

    // Try room setup UI intercept
    if (this.world.robotSystem?.roomSetupManager?.handleButtonPress("a")) {
      hapticManager.pulse(side, 0.6, 40);
      uiAudio.press();
      this.logger.log(`Pinch (${side}) handled by room setup`);
      return;
    }

    // Only start voice recording when voiceInputEnabled
    if (!state.voiceInputEnabled) {
      return;
    }

    hapticManager.pulse(side, 0.6, 40);
    uiAudio.press();

    const aiManager = this.world.aiManager;
    if (aiManager?._handleRecordButtonDown) {
      this.logger.log(`Pinch (${side}) starting voice recording`);
      aiManager._handleRecordButtonDown();
    }
  }

  _handleSelectEnd(side) {
    // Only handle select for hands
    const state = gameState.getState();
    if (state.inputMode !== "hands") {
      return;
    }

    // Only handle voice recording release when voiceInputEnabled
    if (!state.voiceInputEnabled) {
      return;
    }

    hapticManager.pulse(side, 0.3, 20);
    uiAudio.release();

    const aiManager = this.world.aiManager;
    if (aiManager?._handleRecordButtonUp) {
      this.logger.log(`Pinch (${side}) ending voice recording`);
      aiManager._handleRecordButtonUp();
    }
  }

  getPinchState(side) {
    return this.pinchStates[side] || false;
  }

  getFingertipColliders() {
    return this.fingertipColliders;
  }

  visualizeButtonColliders(panelEntity, panelDocument) {
    if (!panelEntity || !panelDocument || !this.debugEnabled) return;

    // Button IDs to visualize
    const buttonIds = ["toggle-debug-btn", "record-btn"];

    const panelObject3D = panelEntity.object3D;
    if (!panelObject3D) {
      this.logger.log(`Panel has no object3D for button visualization`);
      return;
    }

    // Log all meshes in the panel for debugging
    const allMeshes = [];
    panelObject3D.traverse((node) => {
      if (node.isMesh) {
        allMeshes.push({
          name: node.name,
          id: node.userData?.id,
          type: node.type,
          parent: node.parent?.name,
        });
      }
    });
    this.logger.log(`Found ${allMeshes.length} meshes in panel:`, allMeshes);

    for (const buttonId of buttonIds) {
      // Skip if already visualized
      if (this.buttonDebugVisualizers.has(buttonId)) continue;

      const buttonElement = panelDocument.getElementById(buttonId);
      if (!buttonElement) {
        this.logger.log(`Button ${buttonId} not found in document`);
        continue;
      }

      // Try to find the button's 3D mesh in the panel's object3D hierarchy
      let buttonMesh = null;
      const searchId = buttonId.toLowerCase();

      panelObject3D.traverse((node) => {
        if (node.isMesh && !buttonMesh) {
          // Check various ways the button might be identified
          const nodeName = (node.name || "").toLowerCase();
          const nodeId = (node.userData?.id || "").toLowerCase();
          const nodeDataId = (node.userData?.elementId || "").toLowerCase();

          if (
            nodeName.includes(searchId) ||
            nodeId.includes(searchId) ||
            nodeDataId.includes(searchId) ||
            (nodeName.includes("button") &&
              node.parent?.name?.includes(searchId))
          ) {
            buttonMesh = node;
            this.logger.log(`Found button mesh for ${buttonId}:`, {
              name: node.name,
              id: node.userData?.id,
              type: node.type,
            });
          }
        }
      });

      if (buttonMesh) {
        // Get bounding box of the button mesh
        buttonMesh.updateMatrixWorld(true);
        const box = new Box3().setFromObject(buttonMesh);
        const size = box.getSize(new THREEVector3());
        const center = box.getCenter(new THREEVector3());

        // Create wireframe box around the button for visualization
        const wireframeGeometry = new BoxGeometry(size.x, size.y, size.z);
        const edges = new EdgesGeometry(wireframeGeometry);
        const wireframe = new LineSegments(
          edges,
          new LineBasicMaterial({ color: 0x00ffff, linewidth: 2 })
        );

        // Position wireframe at button center
        wireframe.position.copy(center);
        wireframe.rotation.copy(buttonMesh.rotation);

        // Add slight scale to make it visible
        wireframe.scale.multiplyScalar(1.02);

        // Add wireframe to scene root, not as child of UIKitML component
        // UIKitML components only allow UIKitML children
        this.world.scene.add(wireframe);

        // Update wireframe position/rotation each frame to follow button
        wireframe.userData.followTarget = buttonMesh;
        wireframe.userData.followOffset = new THREEVector3().subVectors(
          center,
          buttonMesh.getWorldPosition(new THREEVector3())
        );

        // Don't modify the UIKitML button mesh directly - create a separate collider entity instead
        // UIKitML manages its own meshes and we shouldn't interfere

        // Add pointer event handlers directly to the button mesh (this is safe)
        if (buttonMesh && !buttonMesh.userData.pointerHandlersAdded) {
          buttonMesh.onClick = () => {
            this.logger.log(`Button mesh clicked: ${buttonId}`);
            hapticManager.pulseBoth(0.7, 50);
            uiAudio.confirm();
            const buttonElement = panelDocument.getElementById(buttonId);
            if (buttonElement) {
              if (typeof buttonElement.click === "function") {
                buttonElement.click();
              } else if (buttonElement.dispatchEvent) {
                buttonElement.dispatchEvent(
                  new Event("click", { bubbles: true })
                );
              }
            }
          };

          buttonMesh.onPointerEnter = () => {
            this.logger.log(`Button mesh pointer enter: ${buttonId}`);
            hapticManager.pulseBoth(0.2, 15);
            uiAudio.hover();
          };

          buttonMesh.onPointerLeave = () => {
            this.logger.log(`Button mesh pointer leave: ${buttonId}`);
          };

          buttonMesh.userData.pointerHandlersAdded = true;
          this.logger.log(
            `Added pointer event handlers to button mesh ${buttonId}`
          );
        }

        // Create a separate collider mesh that follows the button (don't modify UIKitML mesh)
        const colliderGeometry = new BoxGeometry(
          size.x,
          size.y,
          Math.max(size.z, 0.01)
        );
        const colliderMaterial = new MeshBasicMaterial({
          color: 0xff00ff, // Magenta for button colliders
          transparent: true,
          opacity: 0.3, // More visible for debugging
        });
        const colliderMesh = new Mesh(colliderGeometry, colliderMaterial);
        colliderMesh.name = `button-collider-visual-${buttonId}`;
        colliderMesh.visible = true;
        colliderMesh.matrixAutoUpdate = true;

        // Add collider to scene root, not as child of UIKitML component
        this.world.scene.add(colliderMesh);

        // Store reference to button mesh for following
        colliderMesh.userData.followTarget = buttonMesh;

        // Create entity for the collider (separate from UIKitML button mesh)
        const colliderEntity = this.world.createTransformEntity(colliderMesh);
        colliderEntity.addComponent(Interactable);
        colliderEntity.addComponent(PhysicsShape, {
          shape: PhysicsShapeType.Box,
          dimensions: [size.x, size.y, Math.max(size.z, 0.01)],
        });
        colliderEntity.addComponent(PhysicsBody, {
          state: PhysicsState.Static,
        });

        this.logger.log(
          `Created separate collider entity for button ${buttonId}`
        );

        this.buttonDebugVisualizers.set(buttonId, {
          wireframe: wireframe,
          mesh: buttonMesh,
          colliderMesh: colliderMesh,
          colliderEntity: colliderEntity,
        });

        this.logger.log(
          `Created physics collider and debug visualizer for button ${buttonId}`,
          {
            size: size,
            center: center,
          }
        );
      } else {
        this.logger.log(`Could not find 3D mesh for button ${buttonId}`);
      }
    }
  }

  updateButtonColliderPositions(delta, time) {
    // Update wireframes and colliders to follow button meshes
    for (const [buttonId, data] of this.buttonDebugVisualizers.entries()) {
      if (data.wireframe && data.wireframe.userData.followTarget) {
        const target = data.wireframe.userData.followTarget;
        target.updateMatrixWorld(true);
        const worldPos = new THREEVector3();
        target.getWorldPosition(worldPos);
        data.wireframe.position.copy(worldPos);
        data.wireframe.rotation.copy(
          target.getWorldQuaternion(new Quaternion()).toEuler(new Euler())
        );
      }

      if (data.colliderMesh && data.colliderMesh.userData.followTarget) {
        const target = data.colliderMesh.userData.followTarget;
        target.updateMatrixWorld(true);
        const worldPos = new THREEVector3();
        target.getWorldPosition(worldPos);
        data.colliderMesh.position.copy(worldPos);
        data.colliderMesh.rotation.copy(
          target.getWorldQuaternion(new Quaternion()).toEuler(new Euler())
        );
      }
    }
  }

  updateButtonColliderVisualizers() {
    // This can be called from AIManager when panel is ready
    const aiManager = this.world.aiManager;
    if (
      aiManager &&
      aiManager.voicePanelEntity &&
      aiManager.voicePanelDocument
    ) {
      this.visualizeButtonColliders(
        aiManager.voicePanelEntity,
        aiManager.voicePanelDocument
      );
    }
  }
}
