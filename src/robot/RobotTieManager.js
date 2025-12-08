/**
 * RobotTieManager.js - Animated tie/accessory using pixel art
 * =============================================================================
 *
 * ROLE: Controls the robot's tie/accessory animation using canvas-rendered
 * pixel art. Each character has a unique accessory:
 *   - Modem: Necktie (tall, narrow)
 *   - Blit: Bowtie (wide, symmetrical)
 *   - Baud: Cumberbund (very wide, short)
 *
 * PIXEL ART: ASCII definitions in robotTieData.js, rendered to CanvasTexture.
 * '#' = white pixel, '.' = black/transparent pixel.
 *
 * ANIMATION FRAMES:
 *   - STILL: Neutral position
 *   - LEFT: Leaning left (turning right)
 *   - RIGHT: Leaning right (turning left)
 *   - CENTER: Motion/transition frame
 *
 * ANIMATION BEHAVIOR:
 *   - Turning: Alternates between direction frame and CENTER
 *   - Stopping: Brief wobble, returns to STILL
 *   - Stationary: Shows STILL frame
 *
 * MESH: Looks for "ChestScreen" material in robot model (or "Screen2" legacy).
 * =============================================================================
 */
import {
  CanvasTexture,
  SRGBColorSpace,
  ClampToEdgeWrapping,
  LinearFilter,
  Color,
} from "three";
import {
  TIE_TYPES,
  CHARACTER_TIE_MAP,
  getTieData,
  getTieDimensions,
  NECKTIE,
  BOWTIE,
  CUMBERBUND,
} from "../data/robotTieData.js";
import { Logger } from "../utils/Logger.js";

const CANVAS_SIZE = 128; // Texture resolution

// Pre-rendered frame cache (shared across all instances)
const frameCache = {
  [TIE_TYPES.NECKTIE]: {},
  [TIE_TYPES.BOWTIE]: {},
  [TIE_TYPES.CUMBERBUND]: {},
  initialized: false,
};

function initFrameCache() {
  if (frameCache.initialized) return;

  const tieDataMap = {
    [TIE_TYPES.NECKTIE]: NECKTIE,
    [TIE_TYPES.BOWTIE]: BOWTIE,
    [TIE_TYPES.CUMBERBUND]: CUMBERBUND,
  };

  for (const [tieType, tieData] of Object.entries(tieDataMap)) {
    const dims = getTieDimensions(tieType);
    const { width, height } = dims;

    const pixelSizeX = Math.floor(CANVAS_SIZE / width);
    const pixelSizeY = Math.floor(CANVAS_SIZE / height);
    const pixelSize = Math.min(pixelSizeX, pixelSizeY);
    const totalWidth = width * pixelSize;
    const totalHeight = height * pixelSize;
    const offsetX = Math.floor((CANVAS_SIZE - totalWidth) / 2);
    const offsetY = Math.floor((CANVAS_SIZE - totalHeight) / 2);

    for (const frameName of ["STILL", "LEFT", "RIGHT", "CENTER"]) {
      const frameData = tieData[frameName];
      if (!frameData) continue;

      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx = canvas.getContext("2d");

      // Keep background transparent so color tint only affects pixels
      ctx.fillStyle = "#ffffff";

      for (let y = 0; y < height; y++) {
        const row = frameData[y];
        if (!row) continue;
        for (let x = 0; x < width; x++) {
          if (row[x] === "#") {
            const canvasY = CANVAS_SIZE - offsetY - (y + 1) * pixelSize;
            ctx.fillRect(
              offsetX + x * pixelSize,
              canvasY,
              pixelSize,
              pixelSize
            );
          }
        }
      }

      frameCache[tieType][frameName] = canvas;
    }
  }

  frameCache.initialized = true;
}

export class RobotTieManager {
  constructor(robotGroup) {
    this.robotGroup = robotGroup;
    this.logger = new Logger("RobotTieManager", false);
    this.tieMesh = null;
    this.tieMaterial = null;
    this.canvas = null;
    this.ctx = null;
    this.canvasTexture = null;

    // Tie type based on character
    this.tieType = TIE_TYPES.BOWTIE; // Default
    this.tieData = null;
    this.tieDimensions = null;

    // Current frame name (null initially to ensure first render happens)
    this.currentFrameName = null;

    // Tie color (default white)
    this.tieColor = "#ffffff";

    // Animation state
    this.frameTimer = 0;
    this.frameToggle = false;
    this.frameInterval = 0.4;

    // Movement state
    this.turnDirection = 0;
    this.isStopping = false;
    this.stoppingTimer = 0;
    this.isMoving = false;

    // Initialize shared frame cache (only runs once)
    initFrameCache();

    this._detectCharacterType();
    this._findTieMesh();
  }

  _detectCharacterType() {
    if (!this.robotGroup) return;

    // Check userData for character info
    const characterId =
      this.robotGroup.userData?.characterId?.toLowerCase() || "";

    if (CHARACTER_TIE_MAP[characterId]) {
      this.tieType = CHARACTER_TIE_MAP[characterId];
    } else {
      // Try to detect from model name
      const name = this.robotGroup.name?.toLowerCase() || "";
      if (name.includes("modem")) {
        this.tieType = TIE_TYPES.NECKTIE;
      } else if (name.includes("baud")) {
        this.tieType = TIE_TYPES.CUMBERBUND;
      } else {
        this.tieType = TIE_TYPES.BOWTIE;
      }
    }

    this.tieData = getTieData(this.tieType);
    this.tieDimensions = getTieDimensions(this.tieType);
  }

  _findTieMesh() {
    if (!this.robotGroup) return;

    this.logger.log(
      `Searching for ChestScreen in robot: ${
        this.robotGroup.name ||
        this.robotGroup.userData?.characterId ||
        "unknown"
      }`
    );

    this.robotGroup.traverse((child) => {
      if (!child.isMesh || !child.material || this.tieMaterial) return;

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      for (const mat of materials) {
        const matNameLower = mat.name?.toLowerCase() || "";
        this.logger.log(
          `Found material: "${mat.name}" on mesh: "${child.name}"`
        );

        // Look for ChestScreen material (primary) or Screen2 (legacy)
        if (
          matNameLower === "chestscreen" ||
          matNameLower === "screen2" ||
          matNameLower === "screen2_mat"
        ) {
          this.logger.log(`✓ Found tie material: ${mat.name}`);
          this.tieMesh = child;
          this.tieMaterial = mat;
          this._initCanvas();
          return;
        }
      }
    });

    if (!this.tieMaterial) {
      this.logger.warn(`✗ No ChestScreen material found`);
    }
  }

  _initCanvas() {
    if (!this.tieMaterial) return;

    // Create canvas for pixel rendering
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext("2d");

    // Create texture
    this.canvasTexture = new CanvasTexture(this.canvas);
    this.canvasTexture.colorSpace = SRGBColorSpace;
    this.canvasTexture.wrapS = ClampToEdgeWrapping;
    this.canvasTexture.wrapT = ClampToEdgeWrapping;
    this.canvasTexture.minFilter = LinearFilter;
    this.canvasTexture.magFilter = LinearFilter;

    // Apply to material - always set both map and emissiveMap
    this.tieMaterial.map = this.canvasTexture;
    this.tieMaterial.emissiveMap = this.canvasTexture;
    // Emissive color must be non-black for emissiveMap to show
    if (!this.tieMaterial.emissive) {
      this.tieMaterial.emissive = new Color(1, 1, 1);
    } else if (
      this.tieMaterial.emissive.r === 0 &&
      this.tieMaterial.emissive.g === 0 &&
      this.tieMaterial.emissive.b === 0
    ) {
      this.tieMaterial.emissive.setRGB(1, 1, 1);
    }
    this.tieMaterial.emissiveIntensity = 1;
    this.tieMaterial.needsUpdate = true;

    this.logger.log(`Canvas texture applied to ${this.tieMaterial.name}`);

    // Render initial frame
    this._renderFrame("STILL");
  }

  _renderFrame(frameName, forceRedraw = false) {
    if (!this.ctx || !this.tieType) return;
    if (this.currentFrameName === frameName && !forceRedraw) return;

    const cachedFrame = frameCache[this.tieType]?.[frameName];
    if (!cachedFrame) return;

    // Clear to transparent first
    this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Blit pre-rendered frame (white pixels on transparent background)
    this.ctx.drawImage(cachedFrame, 0, 0);

    // Apply color tint if not white (only affects drawn pixels)
    if (this.tieColor !== "#ffffff") {
      this.ctx.globalCompositeOperation = "source-atop";
      this.ctx.fillStyle = this.tieColor;
      this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
      this.ctx.globalCompositeOperation = "source-over";
    }

    // Draw black background BEHIND the pixels
    this.ctx.globalCompositeOperation = "destination-over";
    this.ctx.fillStyle = "#000000";
    this.ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    this.ctx.globalCompositeOperation = "source-over";

    this.canvasTexture.needsUpdate = true;
    this.currentFrameName = frameName;
  }

  /**
   * Set the tie pixel color and re-render
   * @param {string} color - CSS color string (e.g. "#ff0000", "rgb(255,0,0)")
   */
  setTieColor(color) {
    if (this.tieColor === color) return;
    this.tieColor = color;
    // Re-render current frame with new color
    if (this.currentFrameName) {
      this._renderFrame(this.currentFrameName, true);
    }
  }

  /**
   * Get the current tie color
   * @returns {string} Current tie color
   */
  getTieColor() {
    return this.tieColor;
  }

  _setFrame(frameName) {
    this._renderFrame(frameName);
  }

  /**
   * Update tie animation based on robot movement state
   * @param {number} turnRate - How fast the robot is turning (rad/s, negative = left, positive = right)
   * @param {number} speed - Current movement speed
   * @param {number} acceleration - Current acceleration (negative = decelerating)
   * @param {number} deltaTime - Frame time in seconds
   */
  update(turnRate, speed, acceleration, deltaTime) {
    if (!this.canvasTexture) return;

    const isTurning = Math.abs(turnRate) > 0.5;
    const isMovingNow = speed > 0.15;
    const justStopped = this.isMoving && !isMovingNow;

    // Track movement state AFTER checking justStopped
    this.isMoving = isMovingNow;

    // Start stopping animation when we just stopped
    if (justStopped) {
      this.isStopping = true;
      this.stoppingTimer = 0;
    }

    // Continue stopping animation for its duration
    if (this.isStopping) {
      this.stoppingTimer += deltaTime;
      if (this.stoppingTimer > 0.6) {
        this.isStopping = false;
        this._setFrame("STILL");
        this.frameTimer = 0;
        return;
      }
    }

    // Determine animation frames and interval
    let frame1, frame2;
    let interval;

    if (isTurning) {
      // Turning: alternate between direction frame and center
      frame1 = turnRate > 0 ? "RIGHT" : "LEFT";
      frame2 = "CENTER";
      interval = Math.max(0.3, 0.5 - Math.abs(turnRate) * 0.03);
    } else if (this.isStopping) {
      // Stopping: wobble between still and center
      frame1 = "STILL";
      frame2 = "CENTER";
      interval = 0.2;
    } else if (!isMovingNow) {
      // Stationary: just show still frame
      this._setFrame("STILL");
      this.frameTimer = 0;
      return;
    } else {
      // Moving straight: very subtle sway
      frame1 = "STILL";
      frame2 = "CENTER";
      interval = 0.5;
    }

    // Animate between frames at the calculated interval
    this.frameTimer += deltaTime;
    if (this.frameTimer >= interval) {
      this.frameTimer = 0;
      this.frameToggle = !this.frameToggle;
      this._setFrame(this.frameToggle ? frame2 : frame1);
    }
  }

  /**
   * Force a specific frame (for external control)
   * @param {string} frameName - "STILL", "LEFT", "RIGHT", or "CENTER"
   */
  setFrame(frameName) {
    if (this.tieData && this.tieData[frameName]) {
      this._renderFrame(frameName);
    }
  }

  /**
   * Get current tie type
   * @returns {string} The tie type (necktie, bowtie, cumberbund)
   */
  getTieType() {
    return this.tieType;
  }

  dispose() {
    if (this.canvasTexture) {
      this.canvasTexture.dispose();
    }
    this.tieMesh = null;
    this.tieMaterial = null;
    this.canvas = null;
    this.ctx = null;
    this.canvasTexture = null;
  }
}
