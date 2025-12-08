/**
 * RobotFaceManager.js - Facial expressions and head rotation
 * =============================================================================
 *
 * ROLE: Controls robot facial expressions via pixel grid rendering to canvas,
 * and manages head rotation for look-at behavior and scanning animations.
 *
 * FACE TEXTURE: Dynamically rendered from pixel grid data in robotFaceData.js.
 * Each emotion is a 24x24 grid of pixels rendered to a canvas texture.
 *
 * EMOTIONS (RobotEmotion enum):
 *   CONTENT, EXCITED, SAD, ANGRY, CURIOUS, ACKNOWLEDGE, AWE, FEAR, THINKING
 *
 * HEAD ROTATION MODES:
 *   - lookAtPosition(worldPos): Smooth slerp to face a world position
 *   - lookAtWithBodyOverflow(): Returns body rotation when head hits limits
 *   - setRandomLookTarget(): Pick random direction within limits
 *   - startScanRotation(duration): Continuous pan during scanning
 *   - stopScanRotation(): Smoothly return to forward
 *
 * KEY STATE:
 *   - currentQuat/targetQuat: Quaternion-based rotation (smooth slerp)
 *   - isScanning: When true, uses continuous rotation instead of look-at
 *   - currentTurnLead: Head leads body rotation during turns
 *
 * ROTATION LIMITS:
 *   - maxYaw: ±45° left/right
 *   - minPitch/maxPitch: -20° to +25° up/down
 *
 * MESH TARGETING: Looks for "Screen" material and "Face_Assembly" parent.
 *
 * COORDINATE SYSTEM: Robot forward is -Y. Head rotates around Z for yaw.
 * =============================================================================
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  MathUtils,
  Vector3,
  Quaternion,
  SRGBColorSpace,
  LinearFilter,
} from "three";
import {
  RobotEmotion,
  EMOTION_GROUPS,
  EYES,
  MOUTHS,
  EMOTION_PARTS,
  TALK_MOUTHS,
  EYE_GRID_SIZE,
  MOUTH_GRID_WIDTH,
  MOUTH_GRID_HEIGHT,
  FACE_GRID_SIZE,
} from "../data/robotFaceData.js";
import { Logger } from "../utils/Logger.js";

export { RobotEmotion, EMOTION_GROUPS };

const CANVAS_SIZE = 256; // Texture resolution
const PIXEL_SIZE = Math.floor(CANVAS_SIZE / FACE_GRID_SIZE);

// Reusable axis vectors (avoid per-frame allocations)
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

// Pre-rendered piece cache (shared across all instances)
const pieceCache = {
  eyes: new Map(), // eyeName -> canvas
  mouths: new Map(), // mouthName -> canvas
  initialized: false,
};

function initPieceCache() {
  if (pieceCache.initialized) return;

  // Pre-render all eyes (12x12 grid each)
  for (const [name, grid] of Object.entries(EYES)) {
    const canvas = document.createElement("canvas");
    canvas.width = EYE_GRID_SIZE * PIXEL_SIZE;
    canvas.height = EYE_GRID_SIZE * PIXEL_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    for (let y = 0; y < EYE_GRID_SIZE; y++) {
      const row = grid[y];
      for (let x = 0; x < EYE_GRID_SIZE; x++) {
        if (row[x] === "#") {
          ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
        }
      }
    }
    pieceCache.eyes.set(name, canvas);
  }

  // Pre-render all mouths (24x12 grid each)
  for (const [name, grid] of Object.entries(MOUTHS)) {
    const canvas = document.createElement("canvas");
    canvas.width = MOUTH_GRID_WIDTH * PIXEL_SIZE;
    canvas.height = MOUTH_GRID_HEIGHT * PIXEL_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    for (let y = 0; y < MOUTH_GRID_HEIGHT; y++) {
      const row = grid[y];
      for (let x = 0; x < MOUTH_GRID_WIDTH; x++) {
        if (row[x] === "#") {
          ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
        }
      }
    }
    pieceCache.mouths.set(name, canvas);
  }

  pieceCache.initialized = true;
}

export class RobotFaceManager {
  constructor(robotGroup) {
    this.robotGroup = robotGroup;
    this.faceMesh = null; // The mesh with Screen material
    this.faceAssembly = null; // The parent group to rotate (whole face case)
    this.faceMaterial = null;
    this.currentEmotion = RobotEmotion.CONTENT;
    this.faceColor = "#ffffff"; // Current face pixel color (default white)

    // Canvas for rendering pixel faces
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext("2d");
    this.canvasTexture = null;

    // Per-robot vertical scale (Baud has portrait screen, others landscape)
    this.verticalScale = 1.0;
    this._detectRobotType();

    // Initialize shared piece cache (only runs once)
    initPieceCache();

    this.logger = new Logger("RobotFaceManager", false);

    // Face rotation state - using quaternions for smooth 3D rotation
    this.currentQuat = new Quaternion();
    this.targetQuat = new Quaternion();
    this.baseQuat = new Quaternion(); // Original rotation (forward-facing)
    this.rotationSpeed = 3.0; // Base slerp speed multiplier

    // Arc motion - ease in/out for more natural movement
    this.arcEaseIn = 0.3; // Slow start (0-1, higher = more easing)
    this.arcEaseOut = 0.4; // Slow end (0-1, higher = more easing)
    this._rotationProgress = 1.0; // 0-1 progress toward target
    this._lastTargetQuat = new Quaternion(); // Track target changes

    // Flag to disable secondary motion when looking at specific target
    this._isLookingAtTarget = false;
    this.minPitch = MathUtils.degToRad(-20); // Max look down
    this.maxPitch = MathUtils.degToRad(25); // Max look up
    this.maxYaw = MathUtils.degToRad(45); // Max left/right rotation (±45°)

    // Reusable vectors for calculations
    this._targetPos = new Vector3();
    this._facePos = new Vector3();
    this._lookDir = new Vector3();
    this._tempQuat = new Quaternion();
    this._tempLookVec = new Vector3(); // For updateLookTarget

    // Scanning rotation state
    this.isScanning = false;
    this.scanStartTime = 0;
    this.scanRotations = 2; // Number of full rotations during scan
    this.scanDuration = 0; // Will be set when scan starts
    this.scanYaw = 0; // Current scan rotation angle

    // Turn-leading behavior (yaw)
    this.turnLeadMultiplier = 0.7; // How much the head leads body turns (radians per radian/sec)
    this.maxTurnLead = MathUtils.degToRad(35); // Max lead angle
    this.currentTurnLead = 0; // Current applied lead offset
    this.turnLeadSmoothing = 10.0; // How fast the lead responds (faster than body)
    this._prevRobotYaw = 0; // Track robot's previous Y rotation
    this._robotTurnRate = 0; // Smoothed turn rate

    // Velocity-based head pitch (bob back on accel, forward on decel)
    this.velocityPitchMultiplier = 0.08; // Pitch per unit of acceleration
    this.maxVelocityPitch = MathUtils.degToRad(12); // Max pitch from velocity
    this.currentVelocityPitch = 0; // Current applied velocity pitch
    this._prevSpeed = 0; // Track previous speed for acceleration calc
    this._smoothedAccel = 0; // Smoothed acceleration value

    // Velocity-based head position lag (head trails behind on accel)
    this.velocityPosMultiplier = 0.012; // Position offset per unit of acceleration
    this.maxVelocityPosOffset = 0.025; // Max position lag in meters
    this.currentVelocityPosOffset = 0; // Current applied position offset (local Z)
    this._baseHeadPosition = null; // Store original head position

    // Follow-through overshoot (spring physics for face rotation)
    this.overshootAmount = 1.12; // Overshoot by 12%
    this.overshootSpring = 150; // Spring stiffness
    this.overshootDamping = 0.82; // Damping factor
    this._overshootVelocity = new Quaternion(); // Angular velocity
    this._wasAtTarget = true; // Track when we just reached target

    this._findFaceMesh();
  }

  _detectRobotType() {
    if (!this.robotGroup) return;
    // Check for robot name in hierarchy
    let robotName = "";
    this.robotGroup.traverse((child) => {
      const name = child.name?.toLowerCase() || "";
      if (name.includes("baud")) robotName = "baud";
      else if (name.includes("blit")) robotName = "blit";
      else if (name.includes("modem")) robotName = "modem";
    });
    // Baud has portrait screen (taller), others have landscape (shorter)
    if (robotName === "baud") {
      this.verticalScale = 1.15; // Slightly taller
    } else if (robotName === "blit" || robotName === "modem") {
      this.verticalScale = 0.85; // Slightly shorter
    }
  }

  _findFaceMesh() {
    if (!this.robotGroup) return;

    this.logger.log("RobotFaceManager: Scanning model hierarchy...");
    this.robotGroup.traverse((child) => {
      if (child.children && child.children.length > 0) {
        this.logger.log(
          `  Node "${child.name}" has ${child.children.length} children:`,
          child.children.map((c) => c.name)
        );
      }
    });

    this.robotGroup.traverse((child) => {
      if (!child.isMesh || this.faceMaterial) return;

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      for (const mat of materials) {
        this.logger.log(
          `RobotFaceManager: Found material "${mat.name}" on mesh "${child.name}"`
        );
        const matNameLower = mat.name?.toLowerCase() || "";
        if (matNameLower === "screen" || matNameLower === "screen1_mat") {
          // Check if this mesh is part of the face/head, not the body/tie section
          // Walk up the hierarchy looking for face/head indicators
          let isFaceMesh = false;
          let isBodyMesh = false;
          let faceParent = null;

          // Check mesh name first
          const meshNameLower = child.name?.toLowerCase() || "";
          if (
            meshNameLower.includes("body") ||
            meshNameLower.includes("middle") ||
            meshNameLower.includes("tie")
          ) {
            isBodyMesh = true;
          }

          // Check parent hierarchy
          let parent = child.parent;
          while (parent && parent !== this.robotGroup) {
            const parentNameLower = parent.name?.toLowerCase() || "";
            if (
              parentNameLower.includes("face") ||
              parentNameLower.includes("head")
            ) {
              isFaceMesh = true;
              faceParent = parent;
              break;
            }
            if (
              parentNameLower.includes("body") ||
              parentNameLower.includes("middle")
            ) {
              isBodyMesh = true;
              break;
            }
            parent = parent.parent;
          }

          // Skip if this is clearly a body/tie mesh, not a face mesh
          if (isBodyMesh && !isFaceMesh) {
            this.logger.log(
              `RobotFaceManager: Skipping body mesh "${child.name}" with Screen material`
            );
            continue;
          }

          this.faceMesh = child;
          this.faceAssembly = faceParent;
          this.logger.log(
            `RobotFaceManager: Found Screen material on face mesh "${child.name}"`
          );

          if (faceParent) {
            this.logger.log(
              `RobotFaceManager: Found face assembly parent "${faceParent.name}"`
            );
          } else if (child.parent && child.parent !== this.robotGroup) {
            this.faceAssembly = child.parent;
            this.logger.log(
              `RobotFaceManager: Using parent "${child.parent.name}" as face assembly`
            );
          }

          // Clone the material and create canvas texture
          this.faceMaterial = mat.clone();
          this.faceMesh.material = this.faceMaterial;

          // Create the canvas texture (UVs now cover full texture space)
          this.canvasTexture = new CanvasTexture(this.canvas);
          this.canvasTexture.colorSpace = SRGBColorSpace;
          this.canvasTexture.flipY = true;
          this.canvasTexture.minFilter = LinearFilter;
          this.canvasTexture.magFilter = LinearFilter;

          // Apply to both map and emissiveMap for glow effect
          this.faceMaterial.map = this.canvasTexture;
          this.faceMaterial.emissiveMap = this.canvasTexture;
          this.faceMaterial.emissive.setHex(0xffffff); // Required for emissiveMap to show
          this.faceMaterial.needsUpdate = true;

          // Render initial emotion
          this._renderFace(this.currentEmotion);
          return;
        }
      }
    });

    if (!this.faceMaterial) {
      this.logger.warn("RobotFaceManager: Could not find Screen material");
    }
  }

  _renderFace(emotion) {
    const parts = EMOTION_PARTS[emotion];
    if (!parts) {
      this.logger.warn(`RobotFaceManager: No parts data for "${emotion}"`);
      return;
    }

    if (!EYES[parts.leftEye] || !EYES[parts.rightEye] || !MOUTHS[parts.mouth]) {
      this.logger.warn(`RobotFaceManager: Missing part for "${emotion}"`);
      return;
    }

    this._renderParts(parts.leftEye, parts.rightEye, parts.mouth);
  }

  _renderParts(leftEyeName, rightEyeName, mouthName) {
    // Clear to transparent first (so color tint only affects drawn pixels)
    this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Scale and center the face content
    const scale = 0.6;
    const pixelSizeX = PIXEL_SIZE * scale;
    const pixelSizeY = PIXEL_SIZE * scale * this.verticalScale;
    const faceWidth = FACE_GRID_SIZE * pixelSizeX;
    const faceHeight = FACE_GRID_SIZE * pixelSizeY;
    const offsetX = (CANVAS_SIZE - faceWidth) / 2;
    const offsetY = (CANVAS_SIZE - faceHeight) / 2 + 15; // Shift down slightly

    // Destination sizes for scaled pieces
    const eyeDestW = EYE_GRID_SIZE * pixelSizeX;
    const eyeDestH = EYE_GRID_SIZE * pixelSizeY;
    const mouthDestW = MOUTH_GRID_WIDTH * pixelSizeX;
    const mouthDestH = MOUTH_GRID_HEIGHT * pixelSizeY;

    // Use imageSmoothingEnabled = false for crisp pixel art
    this.ctx.imageSmoothingEnabled = false;

    // Draw left eye from cache
    const leftEyeCanvas = pieceCache.eyes.get(leftEyeName);
    if (leftEyeCanvas) {
      this.ctx.drawImage(
        leftEyeCanvas,
        0,
        0,
        leftEyeCanvas.width,
        leftEyeCanvas.height,
        offsetX,
        offsetY,
        eyeDestW,
        eyeDestH
      );
    }

    // Draw right eye from cache
    const rightEyeCanvas = pieceCache.eyes.get(rightEyeName);
    if (rightEyeCanvas) {
      this.ctx.drawImage(
        rightEyeCanvas,
        0,
        0,
        rightEyeCanvas.width,
        rightEyeCanvas.height,
        offsetX + eyeDestW,
        offsetY,
        eyeDestW,
        eyeDestH
      );
    }

    // Draw mouth from cache
    const mouthCanvas = pieceCache.mouths.get(mouthName);
    if (mouthCanvas) {
      this.ctx.drawImage(
        mouthCanvas,
        0,
        0,
        mouthCanvas.width,
        mouthCanvas.height,
        offsetX,
        offsetY + eyeDestH,
        mouthDestW,
        mouthDestH
      );
    }

    // Apply color tint if not white (only affects drawn pixels, not transparent areas)
    if (this.faceColor !== "#ffffff") {
      this.ctx.globalCompositeOperation = "source-atop";
      this.ctx.fillStyle = this.faceColor;
      this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      this.ctx.globalCompositeOperation = "source-over";
    }

    // Draw black background BEHIND the pixels (destination-over draws under existing content)
    this.ctx.globalCompositeOperation = "destination-over";
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    this.ctx.globalCompositeOperation = "source-over";

    if (this.canvasTexture) {
      this.canvasTexture.needsUpdate = true;
    }
  }

  /**
   * Set the face pixel color and re-render
   * @param {string} color - CSS color string (e.g. "#ff0000", "rgb(255,0,0)")
   */
  setFaceColor(color) {
    if (this.faceColor === color) return;
    this.faceColor = color;
    // Re-render with new color
    const parts = EMOTION_PARTS[this.currentEmotion];
    if (parts) {
      this._renderParts(parts.leftEye, parts.rightEye, parts.mouth);
    }
  }

  /**
   * Get the current face color
   * @returns {string} Current face color
   */
  getFaceColor() {
    return this.faceColor;
  }

  // Set individual face parts (for eye movement animations)
  setEyes(leftEyeName, rightEyeName = leftEyeName) {
    if (!EYES[leftEyeName] || !EYES[rightEyeName]) {
      this.logger.warn(
        `RobotFaceManager: Unknown eye "${leftEyeName}" or "${rightEyeName}"`
      );
      return;
    }
    // Get current mouth from emotion
    const parts = EMOTION_PARTS[this.currentEmotion];
    const mouthName = parts?.mouth || "neutral";
    this._renderParts(leftEyeName, rightEyeName, mouthName);
  }

  setMouth(mouthName) {
    if (!MOUTHS[mouthName]) {
      this.logger.warn(`RobotFaceManager: Unknown mouth "${mouthName}"`);
      return;
    }
    // Get current eyes from emotion
    const parts = EMOTION_PARTS[this.currentEmotion];
    const leftEyeName = parts?.leftEye || "squareL";
    const rightEyeName = parts?.rightEye || "squareR";
    this._renderParts(leftEyeName, rightEyeName, mouthName);
  }

  /**
   * Update eyes based on movement - eyes lead motion (Lasseter anticipation)
   * @param {number} turnRate - Current turn rate (rad/s, positive = turning right)
   * @param {number} speed - Current movement speed
   * @param {number} deltaTime
   */
  updateEyesForMotion(turnRate, speed, deltaTime) {
    if (!this.canvasTexture) return;

    // Initialize eye motion state if needed
    if (!this._eyeMotionState) {
      this._eyeMotionState = {
        currentLookX: 0, // -1 = left, 0 = center, 1 = right
        targetLookX: 0,
        overrideActive: false,
        overrideTimer: 0,
      };
    }
    const state = this._eyeMotionState;

    // Eyes anticipate turns - look in turn direction before body follows
    const turnThreshold = 0.5; // rad/s before eyes react
    const maxLook = 1.0;

    if (Math.abs(turnRate) > turnThreshold) {
      // Look in direction of turn (anticipation)
      state.targetLookX =
        Math.sign(turnRate) * Math.min(maxLook, Math.abs(turnRate) / 2);
      state.overrideActive = true;
      state.overrideTimer = 0.3; // Hold for 300ms after turn stops
    } else if (state.overrideTimer > 0) {
      state.overrideTimer -= deltaTime;
      if (state.overrideTimer <= 0) {
        state.targetLookX = 0;
        state.overrideActive = false;
      }
    }

    // Smooth eye movement (slower for visible transitions at low res)
    const eyeLerp = 1 - Math.exp(-6 * deltaTime);
    state.currentLookX += (state.targetLookX - state.currentLookX) * eyeLerp;

    // Always apply eye look based on current smooth value
    // This ensures transitions pass through center
    this._applyEyeLook(state.currentLookX, 0);
  }

  /**
   * Update eyes for jump phases - eyes lead vertical motion
   * @param {string} phase - 'anticipation', 'ascent', 'apex', 'descent', 'landing', 'none'
   * @param {number} progress - Jump progress 0-1
   */
  updateEyesForJump(phase, progress) {
    if (!this.canvasTexture) return;

    switch (phase) {
      case "anticipation":
        // Eyes widen in anticipation, look slightly up
        this._applyEyeLook(0, 0.5);
        break;
      case "ascent":
        // Eyes look up, wide with excitement
        this.setEyes("wideL", "wideR");
        break;
      case "apex":
        // Peak - bug out eyes for excitement
        this.setEyes("bugOutL", "bugOutR");
        break;
      case "descent":
        // Eyes start looking down toward landing
        this._applyEyeLook(0, -0.5);
        break;
      case "landing":
        // Squint on impact
        this.setEyes("squintL", "squintR");
        break;
      default:
        // Reset to emotion default
        this._renderFace(this.currentEmotion);
    }
  }

  /**
   * Apply directional eye look (internal helper)
   * Uses wider center zone to ensure smooth transitions pass through center
   * @param {number} lookX - -1 to 1 (left to right)
   * @param {number} lookY - -1 to 1 (down to up)
   */
  _applyEyeLook(lookX, lookY) {
    let leftEye, rightEye;

    // Thresholds for eye positions (wider center zone for smooth transitions)
    const sideThreshold = 0.5; // Must exceed this to look left/right
    const vertThreshold = 0.4;

    // Determine eye type based on look direction
    if (Math.abs(lookY) > Math.abs(lookX) && Math.abs(lookY) > vertThreshold) {
      // Vertical look dominates
      if (lookY > vertThreshold) {
        leftEye = "lookUpL";
        rightEye = "lookUpR";
      } else if (lookY < -vertThreshold) {
        leftEye = "lookDownL";
        rightEye = "lookDownR";
      }
    } else if (Math.abs(lookX) > sideThreshold) {
      // Horizontal look
      if (lookX > sideThreshold) {
        leftEye = "lookRightL";
        rightEye = "lookRightR";
      } else if (lookX < -sideThreshold) {
        leftEye = "lookLeftL";
        rightEye = "lookLeftR";
      }
    }

    // Default to current emotion's eyes when in center zone
    if (!leftEye || !rightEye) {
      const parts = EMOTION_PARTS[this.currentEmotion];
      leftEye = parts?.leftEye || "squareL";
      rightEye = parts?.rightEye || "squareR";
    }

    // Get current mouth from emotion
    const parts = EMOTION_PARTS[this.currentEmotion];
    const mouthName = parts?.mouth || "neutral";
    this._renderParts(leftEye, rightEye, mouthName);
  }

  /**
   * Reset eyes to current emotion default
   */
  resetEyes() {
    this._renderFace(this.currentEmotion);
    if (this._eyeMotionState) {
      this._eyeMotionState.currentLookX = 0;
      this._eyeMotionState.targetLookX = 0;
      this._eyeMotionState.overrideActive = false;
    }
  }

  /**
   * Flash pupils briefly - gives a "focusing" or "alert" look
   * @param {number} duration - How long to show pupils (ms), default 200
   */
  flashPupils(duration = 200) {
    if (!this.canvasTexture) return;

    // Show square eyes with pupils
    this.setEyes("squarePupilL", "squarePupilR");

    // Revert after duration
    setTimeout(() => {
      this._renderFace(this.currentEmotion);
    }, duration);
  }

  /**
   * Show tiny dot pupils (shock/surprise moment)
   * @param {number} duration - How long to show dots (ms), default 150
   */
  flashDotPupils(duration = 150) {
    if (!this.canvasTexture) return;

    this.setEyes("dotL", "dotR");

    setTimeout(() => {
      this._renderFace(this.currentEmotion);
    }, duration);
  }

  /**
   * Quick eye shape change for expressiveness
   * @param {string} type - 'widen', 'squint', 'xEyes', 'pupils'
   * @param {number} duration - How long to hold (ms)
   */
  quickEyeChange(type, duration = 200) {
    if (!this.canvasTexture) return;

    switch (type) {
      case "widen":
        this.setEyes("wideL", "wideR");
        break;
      case "squint":
        this.setEyes("squintL", "squintR");
        break;
      case "xEyes":
        this.setEyes("xEyeL", "xEyeR");
        break;
      case "pupils":
        this.setEyes("squarePupilL", "squarePupilR");
        break;
      case "dots":
        this.setEyes("dotL", "dotR");
        break;
      case "bugOut":
        this.setEyes("bugOutL", "bugOutR");
        break;
    }

    if (duration > 0) {
      setTimeout(() => {
        this._renderFace(this.currentEmotion);
      }, duration);
    }
  }

  /**
   * Random eye variation - call occasionally for liveliness
   * Has a chance to briefly show pupils or change shape
   */
  randomEyeVariation() {
    if (!this.canvasTexture) return;

    const roll = Math.random();
    if (roll < 0.4) {
      // 40% chance: flash pupils
      this.flashPupils(150 + Math.random() * 100);
    } else if (roll < 0.6) {
      // 20% chance: quick widen
      this.quickEyeChange("widen", 100 + Math.random() * 100);
    } else if (roll < 0.75) {
      // 15% chance: squint
      this.quickEyeChange("squint", 80 + Math.random() * 80);
    } else {
      // 25% chance: dot pupils (surprise)
      this.flashDotPupils(100 + Math.random() * 100);
    }
  }

  /**
   * Update mouth for talking animation - call each frame while speaking
   * Cycles through open mouth shapes at a natural speaking rate
   * @param {number} deltaTime
   */
  updateTalkingMouth(deltaTime) {
    if (!this.canvasTexture) return;

    // Initialize talking state if needed
    if (!this._talkState) {
      this._talkState = {
        mouthIndex: 0,
        timer: 0,
        isTalking: false,
      };
    }
    const state = this._talkState;

    // Advance timer and cycle mouth shapes
    state.timer += deltaTime;
    const mouthChangeRate = 0.08 + Math.random() * 0.04; // ~80-120ms per shape

    if (state.timer >= mouthChangeRate) {
      state.timer = 0;
      state.mouthIndex = (state.mouthIndex + 1) % TALK_MOUTHS.length;

      // Get current eyes from emotion and render with talk mouth
      const parts = EMOTION_PARTS[this.currentEmotion];
      const leftEyeName = parts?.leftEye || "squareL";
      const rightEyeName = parts?.rightEye || "squareR";
      const talkMouthName = TALK_MOUTHS[state.mouthIndex];

      if (MOUTHS[talkMouthName]) {
        this._renderParts(leftEyeName, rightEyeName, talkMouthName);
      }
    }

    state.isTalking = true;
  }

  /**
   * Stop talking animation and return to emotion mouth
   */
  stopTalking() {
    if (this._talkState) {
      this._talkState.isTalking = false;
      this._talkState.timer = 0;
    }
    this._renderFace(this.currentEmotion);
  }

  /**
   * Check if currently in talking animation
   */
  isTalking() {
    return this._talkState?.isTalking || false;
  }

  setEmotion(emotion) {
    if (!this.canvasTexture) {
      this.logger.warn(
        `RobotFaceManager: Cannot set emotion "${emotion}" - no canvas texture`
      );
      return;
    }

    if (!EMOTION_PARTS[emotion]) {
      this.logger.warn(`RobotFaceManager: Unknown emotion "${emotion}"`);
      return;
    }

    this.logger.log(`RobotFaceManager: Setting emotion "${emotion}"`);
    this._renderFace(emotion);
    this.currentEmotion = emotion;
  }

  getEmotion() {
    return this.currentEmotion;
  }

  /**
   * Set a random look target within the allowed pitch/yaw range
   * Creates a target position in local space relative to robot
   */
  setRandomLookTarget() {
    const rotationTarget = this.faceAssembly || this.faceMesh;
    if (!rotationTarget) return;

    // Clear the look-at-target flag - allow secondary motion
    this._isLookingAtTarget = false;

    // Random rotation around Z (looking left/right) and X (pitch up/down)
    const lookAngle = (Math.random() - 0.5) * 2 * this.maxYaw;
    // Random pitch within asymmetric range (minPitch to maxPitch)
    const pitch =
      this.minPitch + Math.random() * (this.maxPitch - this.minPitch);

    // Store previous target to detect changes
    this._lastTargetQuat.copy(this.targetQuat);

    // Create target rotation - X is pitch, Z is yaw (look direction)
    this.targetQuat.setFromEuler(
      rotationTarget.rotation.clone().set(pitch, 0, lookAngle)
    );

    // Reset progress for arc easing
    this._rotationProgress = 0;
  }

  /**
   * Look at a specific world position (clamped to max angles)
   * @param {Vector3} worldPos - World position to look at
   * @param {number} bodyFacing - Optional body Y rotation (if not provided, reads from robotGroup)
   */
  lookAtPosition(worldPos, bodyFacing = null) {
    const rotationTarget = this.faceAssembly || this.faceMesh;
    if (!rotationTarget) return;

    // Mark that we're actively looking at a target - disables secondary motion
    this._isLookingAtTarget = true;

    // Get robot body's world position and add estimated face height
    this.robotGroup.getWorldPosition(this._facePos);
    this._facePos.y += 0.25; // Face is roughly 0.25m above robot origin

    // Get robot body's Y rotation (facing direction)
    const bodyYRotation =
      bodyFacing !== null ? bodyFacing : this.robotGroup.rotation.y;

    // Calculate world angle to target (same approach as lookAtWithBodyOverflow)
    const dx = worldPos.x - this._facePos.x;
    const dz = worldPos.z - this._facePos.z;
    const worldAngleToTarget = Math.atan2(dx, dz);

    // Calculate relative yaw angle (target angle minus body facing)
    let lookAngle = worldAngleToTarget - bodyYRotation;
    // Normalize to [-PI, PI]
    while (lookAngle > Math.PI) lookAngle -= Math.PI * 2;
    while (lookAngle < -Math.PI) lookAngle += Math.PI * 2;

    // Calculate pitch from vertical angle
    const dy = worldPos.y - this._facePos.y;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const pitch = Math.atan2(-dy, horizontalDist);

    // Clamp to limits
    const clampedLook = MathUtils.clamp(lookAngle, -this.maxYaw, this.maxYaw);
    const clampedPitch = MathUtils.clamp(pitch, this.minPitch, this.maxPitch);

    // Set target quaternion - X is pitch (up/down), Z is yaw (negate for correct direction)
    this.targetQuat.setFromEuler(
      rotationTarget.rotation.clone().set(clampedPitch, 0, -clampedLook)
    );
  }

  /**
   * Look at a target position relative to robot body facing.
   * Head leads the look, body only rotates for overflow beyond maxYaw.
   * @param {Vector3} targetWorldPos - World position to look at
   * @param {Vector3} robotWorldPos - Robot's world position
   * @param {number} bodyFacing - Robot body's current Y rotation in radians
   * @returns {number} Body rotation offset needed (overflow beyond head's maxYaw)
   */
  lookAtWithBodyOverflow(targetWorldPos, robotWorldPos, bodyFacing) {
    const rotationTarget = this.faceAssembly || this.faceMesh;
    if (!rotationTarget) return 0;

    // Mark that we're actively looking at a target - disables secondary motion
    this._isLookingAtTarget = true;

    // Calculate world-space angle from robot to target
    const dx = targetWorldPos.x - robotWorldPos.x;
    const dz = targetWorldPos.z - robotWorldPos.z;
    const worldAngleToTarget = Math.atan2(dx, dz);

    // Calculate relative angle from body facing to target
    let relativeAngle = worldAngleToTarget - bodyFacing;
    // Normalize to [-PI, PI]
    while (relativeAngle > Math.PI) relativeAngle -= Math.PI * 2;
    while (relativeAngle < -Math.PI) relativeAngle += Math.PI * 2;

    // Calculate overflow - how much beyond maxYaw the body needs to rotate
    let bodyOverflow = 0;
    let headYaw = relativeAngle;

    if (relativeAngle > this.maxYaw) {
      bodyOverflow = relativeAngle - this.maxYaw;
      headYaw = this.maxYaw;
    } else if (relativeAngle < -this.maxYaw) {
      bodyOverflow = relativeAngle + this.maxYaw;
      headYaw = -this.maxYaw;
    }

    // Calculate pitch toward target
    const dy = targetWorldPos.y - robotWorldPos.y;
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const pitch = Math.atan2(-dy, horizontalDist);
    const clampedPitch = MathUtils.clamp(pitch, this.minPitch, this.maxPitch);

    // Set head target rotation (relative to body, negate yaw for correct Z rotation direction)
    this.targetQuat.setFromEuler(
      rotationTarget.rotation.clone().set(clampedPitch, 0, -headYaw)
    );

    return bodyOverflow;
  }

  /**
   * Start scanning rotation (slow 360° rotation with pitch bob)
   * @param {number} duration - Total scan duration in ms
   */
  startScanRotation(duration) {
    this.isScanning = true;
    this.scanStartTime = performance.now();
    this.scanDuration = duration;
    this.scanYaw = 0;
  }

  /**
   * Stop scanning rotation (smoothly returns to forward)
   */
  stopScanRotation() {
    this.isScanning = false;
    // Set target to forward-facing (currentQuat will smoothly lerp to it)
    this.targetQuat.identity();
    // Reset progress to trigger smooth transition
    this._rotationProgress = 0;
  }

  /**
   * Update the robot's turn rate for head-leading behavior
   * @param {number} robotYaw - Current robot Y rotation in radians
   * @param {number} deltaTime - Time since last frame in seconds
   */
  updateTurnRate(robotYaw, deltaTime, speed = 0) {
    if (deltaTime <= 0) return;

    // Calculate raw turn rate
    let yawDelta = robotYaw - this._prevRobotYaw;

    // Handle wrap-around (when crossing ±π)
    if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;

    const rawTurnRate = yawDelta / deltaTime;

    // Smooth the turn rate
    const smoothing = 1 - Math.exp(-this.turnLeadSmoothing * deltaTime);
    this._robotTurnRate = MathUtils.lerp(
      this._robotTurnRate,
      rawTurnRate,
      smoothing
    );

    // Calculate target lead offset (proportional to turn rate)
    const targetLead = MathUtils.clamp(
      this._robotTurnRate * this.turnLeadMultiplier,
      -this.maxTurnLead,
      this.maxTurnLead
    );

    // Smooth the lead application
    this.currentTurnLead = MathUtils.lerp(
      this.currentTurnLead,
      targetLead,
      smoothing
    );

    this._prevRobotYaw = robotYaw;

    // Velocity-based pitch (head bobs back on accel, forward on decel)
    const rawAccel = (speed - this._prevSpeed) / deltaTime;
    this._smoothedAccel = MathUtils.lerp(
      this._smoothedAccel,
      rawAccel,
      smoothing
    );

    // Negative accel = head tips forward, positive = tips back
    const targetVelocityPitch = MathUtils.clamp(
      -this._smoothedAccel * this.velocityPitchMultiplier,
      -this.maxVelocityPitch,
      this.maxVelocityPitch
    );
    this.currentVelocityPitch = MathUtils.lerp(
      this.currentVelocityPitch,
      targetVelocityPitch,
      smoothing
    );

    // Position lag (head trails behind on accel, pushes forward on decel)
    // Negative offset = head moves backward in local space
    const targetPosOffset = MathUtils.clamp(
      -this._smoothedAccel * this.velocityPosMultiplier,
      -this.maxVelocityPosOffset,
      this.maxVelocityPosOffset
    );
    this.currentVelocityPosOffset = MathUtils.lerp(
      this.currentVelocityPosOffset,
      targetPosOffset,
      smoothing
    );

    this._prevSpeed = speed;
  }

  /**
   * Update face rotation - call every frame
   * @param {number} deltaTime - Time since last frame in seconds
   */
  updateRotation(deltaTime) {
    const rotationTarget = this.faceAssembly || this.faceMesh;
    if (!rotationTarget) return;

    if (this.isScanning) {
      // Scanning: continuous slow rotation with pitch bob
      const elapsed = performance.now() - this.scanStartTime;
      const progress = Math.min(elapsed / this.scanDuration, 1);

      // Smooth rotation progress
      const easedProgress =
        progress < 0.5
          ? 2 * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 2) / 2;

      // Full rotation around Z-axis (face looking left/right)
      const rotation = easedProgress * Math.PI * 2 * this.scanRotations;

      // Pitch bob while scanning (uses asymmetric range)
      const pitchFrequency = 3; // Number of pitch cycles during scan
      const pitchT =
        (Math.sin(progress * Math.PI * 2 * pitchFrequency) + 1) * 0.5; // 0 to 1
      const pitch = this.minPitch + pitchT * (this.maxPitch - this.minPitch);

      // Apply rotation - Z is yaw (looking around), X is pitch
      rotationTarget.rotation.set(pitch, 0, rotation);
    } else {
      // Normal: smoothly slerp toward target quaternion with arc easing and overshoot
      const distanceToTarget = this.currentQuat.angleTo(this.targetQuat);
      const isAtTarget = distanceToTarget < 0.05;

      // Update rotation progress (for arc easing)
      if (this._rotationProgress < 1) {
        this._rotationProgress += deltaTime * this.rotationSpeed * 0.5;
        this._rotationProgress = Math.min(this._rotationProgress, 1);
      }

      // Arc easing function: slow at start and end, fast in middle
      // Uses smooth step with configurable ease in/out
      const easeProgress = this._smoothStepArc(
        this._rotationProgress,
        this.arcEaseIn,
        this.arcEaseOut
      );

      // Detect when we've just reached target - trigger overshoot
      if (isAtTarget && !this._wasAtTarget && distanceToTarget > 0.001) {
        // Calculate overshoot direction (continue past target)
        const overshootT = this.overshootAmount;
        this._tempQuat
          .copy(this.currentQuat)
          .slerp(this.targetQuat, overshootT);
        this.currentQuat.copy(this._tempQuat);
      }

      // Base slerp speed, modified by arc easing
      const baseT = 1 - Math.exp(-this.rotationSpeed * deltaTime);
      const easedT = baseT * (0.5 + easeProgress * 0.5); // Blend easing

      // If close to target, use spring physics for natural settle
      if (distanceToTarget < 0.3) {
        // Damped spring toward target
        const springT = 1 - Math.exp(-this.overshootSpring * deltaTime * 0.01);
        this.currentQuat.slerp(this.targetQuat, springT);
      } else {
        // Arc-eased slerp when moving
        this.currentQuat.slerp(this.targetQuat, easedT);
      }

      this._wasAtTarget = isAtTarget;

      // Apply base rotation
      rotationTarget.quaternion.copy(this.currentQuat);

      // Only apply secondary motion (turn-leading, velocity pitch) when NOT looking at specific target
      if (!this._isLookingAtTarget) {
        // Add turn-leading offset on Z axis (yaw)
        if (Math.abs(this.currentTurnLead) > 0.001) {
          this._tempQuat.setFromAxisAngle(AXIS_Z, this.currentTurnLead);
          rotationTarget.quaternion.multiply(this._tempQuat);
        }

        // Add velocity-based pitch offset on X axis (head bobs back/forward)
        if (Math.abs(this.currentVelocityPitch) > 0.001) {
          this._tempQuat.setFromAxisAngle(AXIS_X, this.currentVelocityPitch);
          rotationTarget.quaternion.multiply(this._tempQuat);
        }

        // Apply velocity-based position lag (head trails behind on accel)
        if (Math.abs(this.currentVelocityPosOffset) > 0.0001) {
          // Store base position on first use
          if (this._baseHeadPosition === null) {
            this._baseHeadPosition = rotationTarget.position.clone();
          }
          // Offset along local Z (forward/backward) - negative = backward
          rotationTarget.position.z =
            this._baseHeadPosition.z + this.currentVelocityPosOffset;
        }
      }
    }
  }

  /**
   * Smooth step with configurable ease in/out for arc motion
   */
  _smoothStepArc(t, easeIn, easeOut) {
    // Modified smooth step that allows independent control of ease in/out
    if (t <= 0) return 0;
    if (t >= 1) return 1;

    // Ease in phase
    if (t < 0.5) {
      const x = t * 2;
      return 0.5 * Math.pow(x, 1 + easeIn * 2);
    }
    // Ease out phase
    const x = (t - 0.5) * 2;
    return 0.5 + 0.5 * (1 - Math.pow(1 - x, 1 + easeOut * 2));
  }

  /**
   * Check if face has reached its target rotation
   */
  isAtTarget() {
    return this.currentQuat.angleTo(this.targetQuat) < 0.05;
  }

  /**
   * Update emotion flash animation
   * @param {Object} flashState - Per-robot flash state object
   * @param {Object} config - { flashDurationMin, flashDurationMax, intervalMin, intervalMax, emotions }
   * @param {boolean} isScanning - Whether robot is currently scanning
   * @param {Function} setEmotion - Callback to set emotion (entityIndex, emotion)
   * @returns {Object} Updated flashState
   */
  updateEmotionFlash(flashState, config, isScanning, setEmotion) {
    const now = Date.now();

    if (flashState.isFlashing) {
      // Check if flash should end
      if (now >= flashState.flashEndTime) {
        flashState.isFlashing = false;
        // Return to a base emotion with variance (not always CONTENT)
        if (!isScanning) {
          const baseEmotions = [
            RobotEmotion.CONTENT,
            RobotEmotion.CONTENT,
            RobotEmotion.CURIOUS,
          ];
          const baseEmotion =
            baseEmotions[Math.floor(Math.random() * baseEmotions.length)];
          setEmotion(baseEmotion);
        }
        // Schedule next flash
        flashState.nextFlashTime =
          now +
          config.intervalMin +
          Math.random() * (config.intervalMax - config.intervalMin);
      }
    } else if (!isScanning && now >= flashState.nextFlashTime) {
      // Time to flash! Pick a random emotion
      const randomEmotion =
        config.emotions[Math.floor(Math.random() * config.emotions.length)];
      setEmotion(randomEmotion);
      flashState.isFlashing = true;
      flashState.flashEndTime =
        now +
        config.flashDurationMin +
        Math.random() * (config.flashDurationMax - config.flashDurationMin);
    }

    return flashState;
  }

  /**
   * Update look-at target scheduling
   * @param {Object} lookState - Per-robot look state object
   * @param {Object} config - { lookDurationMin, lookDurationMax, lookIntervalMin, lookIntervalMax }
   * @param {boolean} isScanning
   * @param {boolean} isStationary
   * @param {Object|null} interactionLookTarget - { x, y, z } position to look at
   * @param {number} bodyFacing - Current body facing angle
   * @returns {Object} Updated lookState
   */
  updateLookTarget(
    lookState,
    config,
    isScanning,
    isStationary,
    interactionLookTarget,
    bodyFacing
  ) {
    // Check for interaction look target first
    if (interactionLookTarget) {
      // During interaction, look at partner
      this._tempLookVec.set(
        interactionLookTarget.x,
        interactionLookTarget.y,
        interactionLookTarget.z
      );
      this.lookAtPosition(this._tempLookVec, bodyFacing);
      return lookState;
    }

    // Normal random look targets while moving
    if (!isScanning && !isStationary) {
      const now = Date.now();
      if (now >= lookState.nextLookTime && this.isAtTarget()) {
        // Pick new random look target
        this.setRandomLookTarget();
        // Schedule next look change
        const lookDuration =
          config.lookDurationMin +
          Math.random() * (config.lookDurationMax - config.lookDurationMin);
        lookState.nextLookTime = now + lookDuration;
      }
    }

    return lookState;
  }

  /**
   * Create initial flash state
   */
  static createFlashState(config) {
    const now = Date.now();
    // 50% of robots start mid-flash for immediate variance
    const startMidFlash = Math.random() < 0.5;

    if (startMidFlash) {
      return {
        isFlashing: true,
        flashEndTime: now + 100 + Math.random() * config.flashDurationMax,
        nextFlashTime: 0,
      };
    }

    return {
      isFlashing: false,
      flashEndTime: 0,
      // Wide variance: 0 to 2x max interval for first flash
      nextFlashTime: now + Math.random() * config.intervalMax * 2,
    };
  }

  /**
   * Create initial look state
   */
  static createLookState(config) {
    return {
      nextLookTime:
        Date.now() +
        config.lookIntervalMin +
        Math.random() * (config.lookIntervalMax - config.lookIntervalMin),
    };
  }

  dispose() {
    this.robotGroup = null;
    this.faceMesh = null;
    this.faceAssembly = null;
    this.faceMaterial = null;
    this.faceTextures = [];
  }
}
