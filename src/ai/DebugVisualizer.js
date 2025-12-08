/**
 * DebugVisualizer.js - DEBUG DEPTH OVERLAYS AND VISUALIZATION PLANES
 * =============================================================================
 *
 * ROLE: Creates debug visualizations for depth data, including floating planes
 * in world space that show server vs native depth comparisons, mask overlays,
 * and depth value annotations. Provides helpers for downloading debug images.
 *
 * KEY RESPONSIBILITIES:
 * - Create native depth visualization (XR hit test points with depth labels)
 * - Create server depth visualization (MiDaS depth map with mask overlay)
 * - Show floating debug planes at camera capture position in 3D space
 * - Toggle between server/native depth views on click
 * - Download debug images (depth overlays, raw captures)
 * - Console helper window.logDebugImages() for remote debugging
 *
 * VISUALIZATION TYPES:
 * - Server depth: Grayscale depth map + colored dots at sample points
 * - Native depth: Original image + hit test points colored by depth
 * - Both show: Segmentation mask overlay, bounding boxes, depth labels in meters
 *
 * DEPTH COLORING: Blue (near) to Red (far), with white text labels showing meters
 *
 * DEBUG PLANE: 1.2m wide plane positioned 30cm in front of capture location,
 * oriented to match camera direction. Clickable to toggle depth source.
 *
 * USAGE: Instantiated by AIManager when debug mode enabled.
 * showDepthVisualizations() called after each detection to create debug output.
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import {
  PlaneGeometry,
  MeshBasicMaterial,
  CanvasTexture,
  SRGBColorSpace,
  LinearFilter,
  Interactable,
} from "@iwsdk/core";
import { Vector3 as THREEVector3, Mesh, Quaternion, Matrix4 } from "three";
import { DEBUG_CONFIG } from "./config.js";

export class DebugVisualizer {
  constructor(debugMode = true) {
    this.debugMode = debugMode;
    this.debugImageElement = null;
    this.debugImageTimeout = null;
    this.imageCounter = 0;
    this.logger = new Logger("DebugVisualizer", false);
    this.visualizationPlanes = new Map(); // Store planes by objectId
    this.visualizationCanvases = new Map(); // Store both canvases for toggling: key -> {serverCanvas, nativeCanvas}
    this.visualizationModes = new Map(); // Track which mode is active: key -> "server" | "native"

    // Store latest debug canvases for download
    this.lastServerDepthCanvas = null;
    this.lastNativeDepthCanvas = null;
    this.lastOriginalCanvas = null;

    // Expose download helper globally
    this._setupDownloadHelpers();
  }

  _setupDownloadHelpers() {
    const self = this;

    // Log images to console (for copying from remote DevTools on PC)
    window.logDebugImages = () => {
      const logCanvas = (canvas, name) => {
        if (!canvas) {
          console.log(`No ${name} canvas available`);
          return;
        }
        const dataUrl = canvas.toDataURL("image/png");
        // Log as clickable link and preview image
        console.log(`\n=== ${name} ===`);
        console.log(
          `%c `,
          `
          background: url(${dataUrl}) no-repeat;
          background-size: contain;
          padding: 100px 200px;
        `
        );
        console.log(`Right-click to copy data URL for ${name}:`);
        console.log(dataUrl);
      };

      logCanvas(self.lastOriginalCanvas, "ORIGINAL");
      logCanvas(self.lastServerDepthCanvas, "SERVER_DEPTH");
      logCanvas(self.lastNativeDepthCanvas, "NATIVE_DEPTH");

      if (window._lastApiResponse?.depth_map) {
        console.log("\n=== RAW_DEPTH_MAP ===");
        const b64 = window._lastApiResponse.depth_map;
        const url = b64.startsWith("data:")
          ? b64
          : `data:image/png;base64,${b64}`;
        console.log(url);
      }
    };

    this.logger.log("Ready: logDebugImages() - logs to console for PC copy");
  }

  setDebugMode(enabled) {
    this.debugMode = enabled;
  }

  setImageCounter(counter) {
    this.imageCounter = counter;
  }

  createDebugImageDisplay() {
    this.debugImageElement = document.createElement("div");
    this.debugImageElement.id = "camera-debug-display";
    this.debugImageElement.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      width: 320px;
      max-height: 240px;
      background: rgba(0, 0, 0, 0.8);
      border: 2px solid #00ff00;
      border-radius: 8px;
      padding: 8px;
      z-index: 99999;
      display: none;
      pointer-events: none;
    `;

    const img = document.createElement("img");
    img.id = "camera-debug-image";
    img.style.cssText = `
      width: 100%;
      height: auto;
      display: block;
    `;

    const label = document.createElement("div");
    label.id = "camera-debug-label";
    label.style.cssText = `
      color: #00ff00;
      font-family: monospace;
      font-size: 10px;
      margin-top: 4px;
      text-align: center;
    `;
    label.textContent = "Camera Capture";

    this.debugImageElement.appendChild(img);
    this.debugImageElement.appendChild(label);
    document.body.appendChild(this.debugImageElement);

    this.logger.log("Debug image display created");
  }

  showDebugImage(imageDataUrl, timestamp) {
    if (!this.debugImageElement) return;

    const img = this.debugImageElement.querySelector("#camera-debug-image");
    const label = this.debugImageElement.querySelector("#camera-debug-label");

    if (img && label) {
      img.src = imageDataUrl;
      label.textContent = `Capture ${this.imageCounter} - ${new Date(
        timestamp
      ).toLocaleTimeString()}`;
      this.debugImageElement.style.display = "block";

      if (this.debugImageTimeout) {
        clearTimeout(this.debugImageTimeout);
      }
      this.debugImageTimeout = setTimeout(() => {
        if (this.debugImageElement) {
          this.debugImageElement.style.display = "none";
        }
      }, 3000);

      this.logger.log("Debug image displayed");
    }
  }

  async saveImageLocally(canvas) {
    if (!this.debugMode) return null;

    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(null);
            return;
          }

          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = `camera-capture-${this.imageCounter}-${timestamp}.jpg`;
          this.imageCounter++;

          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          setTimeout(() => URL.revokeObjectURL(url), 100);

          this.logger.log(`Saved image: ${filename}`);
          resolve({ filename, url, blob });
        },
        "image/jpeg",
        0.95
      );
    });
  }

  async saveDebugImageWithDepthOverlay(
    canvas,
    detections,
    masks,
    capturedDepthData
  ) {
    if (!capturedDepthData || !capturedDepthData.depthMap) {
      this.logger.log(`Cannot save debug image: No captured depth data`);
      return;
    }

    if (!this.debugMode) {
      return;
    }

    try {
      const overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = canvas.width;
      overlayCanvas.height = canvas.height;
      const ctx = overlayCanvas.getContext("2d");

      ctx.drawImage(canvas, 0, 0);

      if (detections && detections.length > 0) {
        const maskImages = [];
        if (masks && masks.length > 0) {
          const maskPromises = detections.map(async (detection, i) => {
            if (
              detection.mask_index !== undefined &&
              masks[detection.mask_index]
            ) {
              try {
                const maskBase64 = masks[detection.mask_index];
                const maskImg = new Image();
                return new Promise((resolve, reject) => {
                  maskImg.onload = () => resolve({ index: i, image: maskImg });
                  maskImg.onerror = reject;
                  maskImg.src = `data:image/png;base64,${maskBase64}`;
                });
              } catch (error) {
                this.logger.warn(
                  `Failed to load mask for detection ${i}:`,
                  error
                );
                return null;
              }
            }
            return null;
          });

          const loadedMasks = await Promise.all(maskPromises);
          loadedMasks.forEach((result) => {
            if (result) {
              maskImages[result.index] = result.image;
            }
          });
        }

        for (let i = 0; i < detections.length; i++) {
          const detection = detections[i];
          const bbox = detection.bbox;
          if (bbox) {
            const [x1, y1, x2, y2] = bbox;
            ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
            ctx.lineWidth = 2;
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

            ctx.fillStyle = "rgba(0, 255, 0, 0.9)";
            ctx.font = "bold 14px Arial";
            ctx.fillText(detection.label || "object", x1, y1 - 5);
          }

          if (maskImages[i]) {
            ctx.globalAlpha = 0.3;
            ctx.drawImage(maskImages[i], 0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1.0;
          }
        }
      }

      const depthMap = capturedDepthData.depthMap;

      let minDepth = Infinity;
      let maxDepth = -Infinity;
      for (const sample of depthMap.values()) {
        minDepth = Math.min(minDepth, sample.depth);
        maxDepth = Math.max(maxDepth, sample.depth);
      }

      const depthRange = maxDepth - minDepth || 1;

      for (const [pixelKey, sample] of depthMap.entries()) {
        const x = sample.pixelX;
        const y = sample.pixelY;
        const depth = sample.depth;

        const normalizedDepth = (depth - minDepth) / depthRange;
        const r = Math.floor(normalizedDepth * 255);
        const b = Math.floor((1 - normalizedDepth) * 255);
        const color = `rgb(${r}, 0, ${b})`;

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = "white";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = "white";
        ctx.font = "10px monospace";
        ctx.fillText(depth.toFixed(2) + "m", x + 7, y + 3);
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `depth-overlay-${this.imageCounter}-${timestamp}.jpg`;
      this.imageCounter++;

      overlayCanvas.toBlob(
        (blob) => {
          if (!blob) {
            this.logger.warn("Failed to create debug image blob.");
            return;
          }

          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          setTimeout(() => URL.revokeObjectURL(url), 100);

          this.logger.log(`Saved debug image with depth overlay: ${filename}`);
        },
        "image/jpeg",
        0.95
      );
    } catch (error) {
      this.logger.warn("Error saving depth overlay:", error);
    }
  }

  /**
   * Create visualization canvas for native depth with mask and hit test points
   */
  async createNativeDepthVisualization(
    originalImageCanvas,
    detections,
    masks,
    capturedDepthData,
    imageWidth,
    imageHeight
  ) {
    if (!capturedDepthData || !capturedDepthData.depthMap) {
      this.logger.warn("No native depth data available");
      return null;
    }

    const visCanvas = document.createElement("canvas");
    visCanvas.width = imageWidth;
    visCanvas.height = imageHeight;
    const ctx = visCanvas.getContext("2d");

    // Draw original image as background first
    if (originalImageCanvas) {
      ctx.drawImage(originalImageCanvas, 0, 0, imageWidth, imageHeight);
    } else {
      // Gray background if no image
      ctx.fillStyle = "#333333";
      ctx.fillRect(0, 0, imageWidth, imageHeight);
    }

    // Draw depth map as heatmap overlay on top of original image
    const depthMap = capturedDepthData.depthMap;
    const imageData = ctx.createImageData(imageWidth, imageHeight);

    // Find depth range
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    for (const sample of depthMap.values()) {
      minDepth = Math.min(minDepth, sample.depth);
      maxDepth = Math.max(maxDepth, sample.depth);
    }
    const depthRange = maxDepth - minDepth || 1;

    // Draw depth samples as colored dots (colored by depth, no circles/borders)
    // Each sample point gets a dot colored by depth
    for (const [pixelKey, sample] of depthMap.entries()) {
      const x = sample.pixelX;
      const y = sample.pixelY;
      const depth = sample.depth;

      // Color by depth: blue (near) to red (far)
      const normalizedDepth = (depth - minDepth) / depthRange;
      const r = Math.floor(normalizedDepth * 255);
      const b = Math.floor((1 - normalizedDepth) * 255);
      const color = `rgb(${r}, 0, ${b})`;

      // Draw dot (5px radius) - colored by depth, no border
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();

      // Draw depth label
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px monospace";
      ctx.fillText(`${depth.toFixed(2)}m`, x + 8, y - 8);
    }

    // Draw detection masks (semi-transparent overlay)
    if (detections && masks && masks.length > 0) {
      for (let i = 0; i < detections.length; i++) {
        const detection = detections[i];
        if (detection.mask_index !== undefined && masks[detection.mask_index]) {
          try {
            const maskImg = new Image();
            await new Promise((resolve, reject) => {
              maskImg.onload = resolve;
              maskImg.onerror = reject;
              maskImg.src = `data:image/png;base64,${
                masks[detection.mask_index]
              }`;
            });
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = "#00ffff"; // Light blue for native depth mask
            ctx.drawImage(maskImg, 0, 0, imageWidth, imageHeight);
            ctx.globalAlpha = 1.0;
          } catch (error) {
            this.logger.warn(`Failed to load mask ${i}:`, error);
          }
        }
      }
    }

    // Draw bounding boxes
    if (detections) {
      for (const detection of detections) {
        const bbox = detection.bbox;
        if (bbox) {
          const [x1, y1, x2, y2] = bbox;
          ctx.strokeStyle = "#00ffff"; // Light blue for native depth
          ctx.lineWidth = 3;
          ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

          ctx.fillStyle = "#00ffff";
          ctx.font = "bold 16px Arial";
          ctx.fillText(`${detection.label || "object"} (native)`, x1, y1 - 8);
        }
      }
    }

    // Draw hit test sample points - ONLY within detection masks
    if (detections && masks && masks.length > 0) {
      // Load all masks first
      const maskCanvases = [];
      for (let i = 0; i < detections.length; i++) {
        const detection = detections[i];
        if (detection.mask_index !== undefined && masks[detection.mask_index]) {
          try {
            const maskImg = new Image();
            await new Promise((resolve, reject) => {
              maskImg.onload = resolve;
              maskImg.onerror = reject;
              maskImg.src = `data:image/png;base64,${
                masks[detection.mask_index]
              }`;
            });
            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = imageWidth;
            maskCanvas.height = imageHeight;
            const maskCtx = maskCanvas.getContext("2d");
            maskCtx.drawImage(maskImg, 0, 0, imageWidth, imageHeight);
            maskCanvases.push(
              maskCtx.getImageData(0, 0, imageWidth, imageHeight)
            );
          } catch (error) {
            this.logger.warn(
              `Failed to load mask ${i} for native depth sampling:`,
              error
            );
            maskCanvases.push(null);
          }
        } else {
          maskCanvases.push(null);
        }
      }

      // Only draw hit test points that fall within masks
      for (const [pixelKey, sample] of depthMap.entries()) {
        const x = sample.pixelX;
        const y = sample.pixelY;

        // Check if this point is within any detection mask
        let inMask = false;
        for (let i = 0; i < maskCanvases.length; i++) {
          const maskData = maskCanvases[i];
          if (!maskData) continue;

          const maskIdx = (y * imageWidth + x) * 4;
          if (
            maskIdx < maskData.data.length &&
            maskData.data[maskIdx + 3] >= 128
          ) {
            inMask = true;
            break;
          }
        }

        if (!inMask) continue; // Skip points outside masks

        // Color-code dot by depth: blue (near) to red (far)
        const depth = sample.depth;
        const normalizedDepth = (depth - minDepth) / depthRange;
        const dotR = Math.floor(normalizedDepth * 255);
        const dotB = Math.floor((1 - normalizedDepth) * 255);

        // Draw dot (5px radius) - colored by depth, no border
        ctx.fillStyle = `rgb(${dotR}, 0, ${dotB})`;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return visCanvas;
  }

  /**
   * Create visualization canvas showing server-returned depth image with mask overlay
   */
  async createServerDepthVisualization(
    originalImageCanvas,
    detections,
    masks,
    depthMapImageData,
    imageWidth,
    imageHeight
  ) {
    if (!depthMapImageData) {
      this.logger.warn("No server depth map available");
      return null;
    }

    this.logger.log(
      `Server depth visualization: depthMapImageData=${!!depthMapImageData}, width=${
        depthMapImageData?.width
      }, height=${depthMapImageData?.height}, dataLength=${
        depthMapImageData?.data?.length || 0
      }`
    );

    // Verify depth map has valid data
    if (!depthMapImageData.data || depthMapImageData.data.length === 0) {
      this.logger.error("Server depth map has no data!");
      return null;
    }

    const visCanvas = document.createElement("canvas");
    visCanvas.width = imageWidth;
    visCanvas.height = imageHeight;
    const ctx = visCanvas.getContext("2d");

    // Create a temporary canvas from the depth map ImageData
    const depthCanvas = document.createElement("canvas");
    depthCanvas.width = depthMapImageData.width;
    depthCanvas.height = depthMapImageData.height;
    const depthCtx = depthCanvas.getContext("2d");
    depthCtx.putImageData(depthMapImageData, 0, 0);

    // Draw the depth map image directly, scaled to match the visualization canvas size
    ctx.drawImage(depthCanvas, 0, 0, imageWidth, imageHeight);

    // Depth map conversion parameters (matching DepthProcessor)
    const nearMeters = 0.25;
    const farMeters = 2.5;
    const depthData = depthMapImageData.data;
    const depthWidth = depthMapImageData.width;
    const depthHeight = depthMapImageData.height;

    // Overlay segmentation masks and sample depth values within masks
    if (detections && masks && masks.length > 0) {
      for (let i = 0; i < detections.length; i++) {
        const detection = detections[i];
        if (detection.mask_index !== undefined && masks[detection.mask_index]) {
          try {
            const maskImg = new Image();
            await new Promise((resolve, reject) => {
              maskImg.onload = resolve;
              maskImg.onerror = reject;
              maskImg.src = `data:image/png;base64,${
                masks[detection.mask_index]
              }`;
            });

            // Draw mask as semi-transparent overlay
            ctx.globalAlpha = 0.5; // 50% opacity so depth map is still visible
            ctx.drawImage(maskImg, 0, 0, imageWidth, imageHeight);
            ctx.globalAlpha = 1.0; // Reset alpha

            // Sample depth values within the mask and draw labels
            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = imageWidth;
            maskCanvas.height = imageHeight;
            const maskCtx = maskCanvas.getContext("2d");
            maskCtx.drawImage(maskImg, 0, 0, imageWidth, imageHeight);
            const maskImageData = maskCtx.getImageData(
              0,
              0,
              imageWidth,
              imageHeight
            );

            // Sample pixels within mask (every 40 pixels for better readability - less crowding)
            const sampleStep = 40;
            let sampleCount = 0;
            const depthValues = []; // For logging

            for (let y = 0; y < imageHeight; y += sampleStep) {
              for (let x = 0; x < imageWidth; x += sampleStep) {
                const maskIdx = (y * imageWidth + x) * 4;

                // Check if pixel is in mask (alpha >= 128)
                if (
                  maskIdx >= maskImageData.data.length ||
                  maskImageData.data[maskIdx + 3] < 128
                ) {
                  continue; // Skip pixels outside mask
                }

                // Sample depth from depth map ImageData at this pixel
                // Map from visualization canvas coordinates to depth map ImageData coordinates
                const depthX = Math.floor((x / imageWidth) * depthWidth);
                const depthY = Math.floor((y / imageHeight) * depthHeight);

                // Ensure coordinates are within bounds
                if (
                  depthX < 0 ||
                  depthX >= depthWidth ||
                  depthY < 0 ||
                  depthY >= depthHeight
                ) {
                  continue;
                }

                const depthIdx = (depthY * depthWidth + depthX) * 4;

                // Check if depth is valid (alpha > 0)
                if (
                  depthIdx >= depthData.length ||
                  depthData[depthIdx + 3] === 0
                ) {
                  continue;
                }

                // Read grayscale value from depth map ImageData
                // For grayscale images, R=G=B, so we can use any channel
                // Use the red channel (or average of RGB for robustness)
                const r = depthData[depthIdx];
                const g = depthData[depthIdx + 1];
                const b = depthData[depthIdx + 2];
                const depthValue = Math.round((r + g + b) / 3); // Average RGB for grayscale

                // Convert depth map grayscale value to meters
                // Depth map: darker (lower value) = closer, lighter (higher value) = farther
                const depthNormalized = depthValue / 255.0;
                const depthMeters =
                  nearMeters +
                  (1.0 - depthNormalized) * (farMeters - nearMeters);

                // Validate depth
                if (
                  isFinite(depthMeters) &&
                  depthMeters > 0 &&
                  depthMeters <= farMeters
                ) {
                  depthValues.push(depthMeters);

                  // Color-code dots by depth: blue (near) to red (far)
                  const normalizedDepth =
                    (depthMeters - nearMeters) / (farMeters - nearMeters);
                  const dotR = Math.floor(normalizedDepth * 255);
                  const dotB = Math.floor((1 - normalizedDepth) * 255);

                  // Draw dot at sample point (color-coded by depth)
                  ctx.fillStyle = `rgb(${dotR}, 0, ${dotB})`;
                  ctx.beginPath();
                  ctx.arc(x, y, 5, 0, Math.PI * 2);
                  ctx.fill();

                  // White outline
                  ctx.strokeStyle = "#ffffff";
                  ctx.lineWidth = 1;
                  ctx.stroke();

                  // Draw depth label
                  ctx.fillStyle = "#ffffff"; // White text
                  ctx.font = "bold 11px monospace";
                  ctx.fillText(`${depthMeters.toFixed(2)}m`, x + 8, y - 8);

                  sampleCount++;
                }
              }
            }

            // Log depth value range for debugging
            if (depthValues.length > 0) {
              const minDepth = Math.min(...depthValues);
              const maxDepth = Math.max(...depthValues);
              const avgDepth =
                depthValues.reduce((a, b) => a + b, 0) / depthValues.length;
              this.logger.log(
                `Server depth visualization: ${sampleCount} samples for ${
                  detection.label || "object"
                }, ` +
                  `depth range: ${minDepth.toFixed(2)}m - ${maxDepth.toFixed(
                    2
                  )}m, avg: ${avgDepth.toFixed(2)}m`
              );
            } else {
              this.logger.warn(
                `Server depth visualization: No valid depth samples found for ${
                  detection.label || "object"
                }`
              );
            }
          } catch (error) {
            this.logger.warn(`Failed to load mask ${i} for overlay:`, error);
          }
        }
      }
    }

    return visCanvas;
  }

  /**
   * Display depth visualizations as 3D planes in world space
   */
  async showDepthVisualizations(
    originalImageCanvas,
    detections,
    masks,
    capturedDepthData,
    serverDepthMapImageData,
    imageWidth,
    imageHeight,
    world,
    player,
    trackedObjects,
    captureHeadTransform = null
  ) {
    this.logger.log(
      `showDepthVisualizations called: debugMode=${this.debugMode}, ` +
        `capturedDepthData=${!!capturedDepthData}, serverDepthMapImageData=${!!serverDepthMapImageData}, ` +
        `headTransform=${!!captureHeadTransform}`
    );

    if (!this.debugMode) {
      this.logger.warn("Debug mode is disabled, skipping visualization");
      return;
    }

    // Check if mid-air visualization is disabled in config
    if (!DEBUG_CONFIG.showMidAirVisualization) {
      this.logger.log("Mid-air visualization disabled in config, skipping");
      return;
    }

    try {
      // Create both visualizations
      const nativeCanvas = await this.createNativeDepthVisualization(
        originalImageCanvas,
        detections,
        masks,
        capturedDepthData,
        imageWidth,
        imageHeight
      );

      const serverCanvas = await this.createServerDepthVisualization(
        originalImageCanvas,
        detections,
        masks,
        serverDepthMapImageData,
        imageWidth,
        imageHeight
      );

      if (!nativeCanvas && !serverCanvas) {
        this.logger.warn("No depth visualizations available");
        return;
      }

      // Store canvases for download via downloadDebugImages()
      this.lastServerDepthCanvas = serverCanvas;
      this.lastNativeDepthCanvas = nativeCanvas;
      this.lastOriginalCanvas = originalImageCanvas;

      // Store both canvases for toggling
      const key = "debug_depth_image";
      this.visualizationCanvases.set(key, { serverCanvas, nativeCanvas });
      this.visualizationModes.set(key, "server"); // Start with server depth

      // Position at camera capture location (if available)
      let cameraPosition = null;
      let cameraRotation = null;

      if (captureHeadTransform) {
        // Extract position from head transform
        cameraPosition = new THREEVector3(
          captureHeadTransform.position[0],
          captureHeadTransform.position[1],
          captureHeadTransform.position[2]
        );

        // Extract rotation from head transform
        // captureHeadTransform.matrix is a Matrix4 OBJECT (not an array!)
        // captureHeadTransform.rotation is an array [x, y, z, w]
        if (captureHeadTransform.rotation) {
          // Use pre-computed rotation array (preferred)
          try {
            cameraRotation = new Quaternion(
              captureHeadTransform.rotation[0],
              captureHeadTransform.rotation[1],
              captureHeadTransform.rotation[2],
              captureHeadTransform.rotation[3]
            );
            cameraRotation.normalize();
            if (
              !isFinite(cameraRotation.x) ||
              !isFinite(cameraRotation.y) ||
              !isFinite(cameraRotation.z) ||
              !isFinite(cameraRotation.w)
            ) {
              this.logger.warn(
                `Invalid quaternion from rotation array, using identity`
              );
              cameraRotation = new Quaternion();
            }
          } catch (error) {
            this.logger.warn(
              `Error creating quaternion from rotation array:`,
              error
            );
            cameraRotation = new Quaternion();
          }
        } else if (
          captureHeadTransform.matrix &&
          captureHeadTransform.matrix.elements
        ) {
          // matrix is a Matrix4 object with .elements array
          try {
            cameraRotation = new Quaternion();
            cameraRotation.setFromRotationMatrix(captureHeadTransform.matrix);
            cameraRotation.normalize();
            if (
              !isFinite(cameraRotation.x) ||
              !isFinite(cameraRotation.y) ||
              !isFinite(cameraRotation.z) ||
              !isFinite(cameraRotation.w)
            ) {
              this.logger.warn(
                `Invalid quaternion from matrix, using identity`
              );
              cameraRotation = new Quaternion();
            }
          } catch (error) {
            this.logger.warn(`Error extracting rotation from matrix:`, error);
            cameraRotation = new Quaternion();
          }
        } else if (captureHeadTransform.quaternion) {
          // Fallback: use quaternion array if provided separately
          try {
            cameraRotation = new Quaternion(
              captureHeadTransform.quaternion[0],
              captureHeadTransform.quaternion[1],
              captureHeadTransform.quaternion[2],
              captureHeadTransform.quaternion[3]
            );
            cameraRotation.normalize();
            if (
              !isFinite(cameraRotation.x) ||
              !isFinite(cameraRotation.y) ||
              !isFinite(cameraRotation.z) ||
              !isFinite(cameraRotation.w)
            ) {
              this.logger.warn(
                `Invalid quaternion from quaternion array, using identity`
              );
              cameraRotation = new Quaternion();
            }
          } catch (error) {
            this.logger.warn(`Error creating quaternion from array:`, error);
            cameraRotation = new Quaternion();
          }
        }
      }

      // If no camera transform, use first tracked object position as fallback
      if (!cameraPosition && trackedObjects && trackedObjects.size > 0) {
        const firstTracked = Array.from(trackedObjects.values())[0];
        const worldPosition =
          firstTracked.captureTimePosition || firstTracked.fusedPosition;
        if (worldPosition) {
          cameraPosition = new THREEVector3(
            worldPosition.x,
            worldPosition.y,
            worldPosition.z
          );
          // Default rotation: face forward (no rotation)
          cameraRotation = new Quaternion();
        }
      }

      if (!cameraPosition) {
        this.logger.warn(
          "No camera position available for debug visualization"
        );
        return;
      }

      this.logger.log(
        `Creating debug visualization at camera position: (${cameraPosition.x.toFixed(
          2
        )}, ${cameraPosition.y.toFixed(2)}, ${cameraPosition.z.toFixed(2)}), ` +
          `rotation: ${
            cameraRotation ? "set" : "none"
          }, serverCanvas: ${!!serverCanvas}, nativeCanvas: ${!!nativeCanvas}`
      );

      // Create single plane at camera position with camera rotation
      // Start with server depth (will toggle on click)
      if (serverCanvas) {
        try {
          this.logger.log(`Calling createVisualizationPlaneAtCamera...`);
          await this.createVisualizationPlaneAtCamera(
            serverCanvas,
            cameraPosition,
            cameraRotation || new Quaternion(), // Default to no rotation if not provided
            key,
            world
          );
          this.logger.log(`Successfully created debug visualization plane`);
        } catch (error) {
          this.logger.error(`Error creating debug visualization plane:`, error);
          console.error("Debug visualization plane creation error:", error);
        }
      } else {
        this.logger.warn("No server canvas available for debug visualization");
      }

      // Also download them as backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      if (nativeCanvas) {
        const filename = `native-depth-${this.imageCounter}-${timestamp}.png`;
        this.downloadCanvas(nativeCanvas, filename);
      }
      if (serverCanvas) {
        const filename = `server-depth-${this.imageCounter}-${timestamp}.png`;
        this.downloadCanvas(serverCanvas, filename);
      }

      this.imageCounter++;
    } catch (error) {
      this.logger.error("Error creating depth visualizations:", error);
    }
  }

  /**
   * Create a 3D plane with visualization texture
   */
  async createVisualizationPlaneAtCamera(
    canvas,
    cameraPosition,
    cameraRotation,
    key,
    world
  ) {
    // Remove existing plane if it exists
    this.removeVisualizationPlane(key, world);

    // Create texture from canvas
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;

    // Calculate aspect ratio and size (make it larger and more visible)
    const aspectRatio = canvas.width / canvas.height;
    const planeWidth = 1.2; // 1.2m wide (larger for visibility)
    const planeHeight = planeWidth / aspectRatio;

    this.logger.log(
      `Creating visualization plane: canvas=${canvas.width}x${canvas.height}, ` +
        `plane=${planeWidth.toFixed(2)}x${planeHeight.toFixed(2)}m, ` +
        `position=(${cameraPosition.x.toFixed(2)}, ${cameraPosition.y.toFixed(
          2
        )}, ${cameraPosition.z.toFixed(2)})`
    );

    // Create plane geometry and material
    const geometry = new PlaneGeometry(planeWidth, planeHeight);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 1.0, // Full opacity for visibility
      side: 2, // DoubleSide
      depthWrite: false,
      depthTest: true, // Enable depth testing
    });

    // Create mesh
    const mesh = new Mesh(geometry, material);

    // Validate camera position
    if (
      !cameraPosition ||
      !isFinite(cameraPosition.x) ||
      !isFinite(cameraPosition.y) ||
      !isFinite(cameraPosition.z)
    ) {
      this.logger.error(`Invalid camera position: ${cameraPosition}`);
      return;
    }

    // Position plane slightly forward from camera position along camera's forward direction
    // This makes it visible when you're at the camera position
    const forwardOffset = new THREEVector3(0, 0, -0.3); // 30cm forward in camera space (negative Z = forward)
    if (
      cameraRotation &&
      isFinite(cameraRotation.x) &&
      isFinite(cameraRotation.y) &&
      isFinite(cameraRotation.z) &&
      isFinite(cameraRotation.w)
    ) {
      // Transform offset to world space using camera rotation
      forwardOffset.applyQuaternion(cameraRotation);
    }

    // Set position explicitly to avoid NaN issues
    mesh.position.set(
      cameraPosition.x + forwardOffset.x,
      cameraPosition.y + forwardOffset.y,
      cameraPosition.z + forwardOffset.z
    );

    // Validate position after calculation
    if (
      !isFinite(mesh.position.x) ||
      !isFinite(mesh.position.y) ||
      !isFinite(mesh.position.z)
    ) {
      this.logger.error(
        `Position calculation produced NaN: cameraPos=(${cameraPosition.x}, ${cameraPosition.y}, ${cameraPosition.z}), offset=(${forwardOffset.x}, ${forwardOffset.y}, ${forwardOffset.z})`
      );
      // Fallback: just use camera position without offset
      mesh.position.copy(cameraPosition);
    }

    // Apply camera rotation so plane faces the same direction camera was looking
    // Plane default normal is +Z, camera forward is -Z, so rotate 180° around Y
    const forwardRotation = new Quaternion();
    forwardRotation.setFromAxisAngle(new THREEVector3(0, 1, 0), Math.PI); // Rotate 180° around Y
    let finalRotation = forwardRotation;
    if (
      cameraRotation &&
      isFinite(cameraRotation.x) &&
      isFinite(cameraRotation.y) &&
      isFinite(cameraRotation.z) &&
      isFinite(cameraRotation.w)
    ) {
      finalRotation = cameraRotation.clone().multiply(forwardRotation);
      // Validate rotation
      if (
        !isFinite(finalRotation.x) ||
        !isFinite(finalRotation.y) ||
        !isFinite(finalRotation.z) ||
        !isFinite(finalRotation.w)
      ) {
        this.logger.warn(
          `Rotation calculation produced NaN, using default rotation`
        );
        finalRotation = forwardRotation;
      }
    }
    mesh.setRotationFromQuaternion(finalRotation);

    this.logger.log(
      `Plane positioned: cameraPos=(${cameraPosition.x.toFixed(
        2
      )}, ${cameraPosition.y.toFixed(2)}, ${cameraPosition.z.toFixed(2)}), ` +
        `finalPos=(${mesh.position.x.toFixed(2)}, ${mesh.position.y.toFixed(
          2
        )}, ${mesh.position.z.toFixed(2)}), ` +
        `rotation=${!!cameraRotation}`
    );

    mesh.visible = true;
    mesh.matrixAutoUpdate = true;

    // Create entity
    const entity = world.createTransformEntity(mesh);
    if (!entity) {
      this.logger.error(
        `Failed to create visualization plane entity for ${key}`
      );
      return;
    }

    // Ensure mesh is in scene (createTransformEntity should add it, but verify)
    if (!mesh.parent) {
      this.logger.warn(
        `Mesh has no parent after createTransformEntity, adding to scene manually`
      );
      world.scene.add(mesh);
    } else {
      this.logger.log(
        `Mesh is in scene, parent: ${mesh.parent.constructor.name}`
      );
    }

    // Force update matrix to ensure position/rotation are applied
    mesh.updateMatrixWorld(true);

    // Add Interactable component for click handling
    try {
      entity.addComponent(Interactable);
      mesh.userData.debugKey = key;
      mesh.userData.isDebugImage = true;

      // Set up click handler (using onClick pattern like XrInputSystem)
      mesh.onClick = () => {
        this.logger.log(`Debug image clicked, toggling...`);
        this.toggleDebugImage(key, world);
      };
    } catch (error) {
      this.logger.warn(`Could not add Interactable to debug image:`, error);
    }

    // Store reference
    this.visualizationPlanes.set(key, { entity, mesh });

    this.logger.log(
      `Created debug visualization plane at camera position: (${cameraPosition.x.toFixed(
        2
      )}, ${cameraPosition.y.toFixed(2)}, ${cameraPosition.z.toFixed(2)}), ` +
        `mesh.visible=${
          mesh.visible
        }, mesh.parent=${!!mesh.parent}, mesh.position=(${mesh.position.x.toFixed(
          2
        )}, ${mesh.position.y.toFixed(2)}, ${mesh.position.z.toFixed(2)})`
    );
  }

  toggleDebugImage(key, world) {
    const canvases = this.visualizationCanvases.get(key);
    if (!canvases) {
      this.logger.warn(`No canvases found for key: ${key}`);
      return;
    }

    const currentMode = this.visualizationModes.get(key) || "server";
    const newMode = currentMode === "server" ? "native" : "server";
    const newCanvas =
      newMode === "server" ? canvases.serverCanvas : canvases.nativeCanvas;

    if (!newCanvas) {
      this.logger.warn(`No ${newMode} canvas available`);
      return;
    }

    // Update the texture
    const plane = this.visualizationPlanes.get(key);
    if (plane && plane.mesh && plane.mesh.material) {
      // Dispose old texture
      if (plane.mesh.material.map) {
        plane.mesh.material.map.dispose();
      }

      // Create new texture
      const texture = new CanvasTexture(newCanvas);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      plane.mesh.material.map = texture;
      plane.mesh.material.needsUpdate = true;

      this.visualizationModes.set(key, newMode);
      this.logger.log(`Toggled debug image to ${newMode} mode`);
    }
  }

  /**
   * Remove a visualization plane
   */
  removeVisualizationPlane(key, world) {
    const existing = this.visualizationPlanes.get(key);
    if (existing) {
      if (existing.entity && typeof existing.entity.destroy === "function") {
        existing.entity.destroy();
      } else if (existing.mesh) {
        world.scene.remove(existing.mesh);
        if (existing.mesh.material) {
          if (existing.mesh.material.map) {
            existing.mesh.material.map.dispose();
          }
          existing.mesh.material.dispose();
        }
        if (existing.mesh.geometry) {
          existing.mesh.geometry.dispose();
        }
      }
      this.visualizationPlanes.delete(key);
    }
  }

  /**
   * Remove all visualization planes
   */
  removeAllVisualizationPlanes(world) {
    for (const key of this.visualizationPlanes.keys()) {
      this.removeVisualizationPlane(key, world);
    }
  }

  /**
   * Update plane billboarding to face camera (only for non-camera-positioned planes)
   */
  updateVisualizationPlanes(player) {
    const headPos = player.head.position;
    for (const { mesh } of this.visualizationPlanes.values()) {
      // Skip debug images positioned at camera (they have fixed rotation)
      if (mesh && mesh.visible && !mesh.userData.isDebugImage) {
        mesh.lookAt(headPos.x, headPos.y, headPos.z);
      }
    }
  }

  /**
   * Download a canvas as an image file
   */
  downloadCanvas(canvas, filename) {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          this.logger.warn(`Failed to create blob for ${filename}`);
          return;
        }

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        setTimeout(() => URL.revokeObjectURL(url), 100);
      },
      "image/png",
      1.0
    );
  }
}
