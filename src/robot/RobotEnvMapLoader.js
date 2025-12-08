/**
 * RobotEnvMapLoader.js - Environment map loading for robot reflections
 * =============================================================================
 *
 * ROLE: Loads or captures an environment map to make robot materials look
 * shiny and reflective. Adapts to emulator vs device context.
 *
 * MODES:
 *   - Emulator (localhost): Loads fallback image (/images/0012_original.jpg)
 *   - Device with camera: Captures environment from XR camera
 *   - Fallback: Uses fallback image if camera capture fails
 *
 * KEY METHOD:
 *   - loadEnvMap(cameraEntity): Returns Promise<Texture> for environment map
 *
 * USAGE: Called by RobotSystem when setting up robot materials. Applied to
 * robot mesh materials for realistic reflections.
 *
 * NOTE: Camera capture may not work on all XR devices. Fallback ensures
 * robots always have some reflective appearance.
 * =============================================================================
 */
import {
  EquirectangularReflectionMapping,
  SRGBColorSpace,
  CanvasTexture,
} from "three";
import { CameraUtils } from "@iwsdk/core";
import { Logger } from "../utils/Logger.js";

const IS_EMULATOR =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

const ENV_MAP_SIZE = 256;

export class RobotEnvMapLoader {
  constructor(world) {
    this.world = world;
    this.logger = new Logger("RobotEnvMap", false);
    this.envMap = null;
    this.loaded = false;
  }

  async loadEnvMap(cameraEntity = null) {
    if (this.loaded && this.envMap) {
      return this.envMap;
    }

    try {
      if (IS_EMULATOR) {
        this.logger.log("Emulator mode: loading fallback environment image");
        this.envMap = await this._loadFallbackImage();
      } else if (cameraEntity) {
        this.logger.log("Device mode: capturing environment from camera");
        this.envMap = await this._captureFromCamera(cameraEntity);
        if (!this.envMap) {
          this.logger.log("Camera capture failed, using fallback");
          this.envMap = await this._loadFallbackImage();
        }
      } else {
        this.logger.log("No camera entity, using fallback image");
        this.envMap = await this._loadFallbackImage();
      }

      this.loaded = true;
      return this.envMap;
    } catch (error) {
      this.logger.warn("Failed to load environment map:", error);
      return null;
    }
  }

  async _loadFallbackImage() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const texture = this._createResizedTexture(img);
        this.logger.log(
          `Fallback environment image loaded and resized to ${ENV_MAP_SIZE}x${ENV_MAP_SIZE}`
        );
        resolve(texture);
      };
      img.onerror = (error) => {
        this.logger.warn("Failed to load fallback image:", error);
        reject(error);
      };
      img.src = "./images/0012_original.jpg";
    });
  }

  _createResizedTexture(source) {
    const canvas = document.createElement("canvas");
    canvas.width = ENV_MAP_SIZE;
    canvas.height = ENV_MAP_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0, ENV_MAP_SIZE, ENV_MAP_SIZE);

    const texture = new CanvasTexture(canvas);
    texture.mapping = EquirectangularReflectionMapping;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  async _captureFromCamera(cameraEntity) {
    try {
      const frame = CameraUtils.captureFrame(cameraEntity);
      if (!frame) {
        return null;
      }

      const texture = this._createResizedTexture(frame);
      this.logger.log(
        `Environment captured from camera and resized to ${ENV_MAP_SIZE}x${ENV_MAP_SIZE}`
      );
      return texture;
    } catch (error) {
      this.logger.warn("Camera capture error:", error);
      return null;
    }
  }

  applyToMesh(mesh, config = {}) {
    if (!this.envMap) {
      this.logger.warn("No envMap loaded, cannot apply");
      return;
    }

    const { intensity = 1.0 } = config;

    mesh.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];

        materials.forEach((mat) => {
          // Only apply to materials that support envMap (PBR materials)
          if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
            mat.envMap = this.envMap;
            mat.envMapIntensity = intensity;
            mat.needsUpdate = true;

            this.logger.log(
              `Applied envMap to "${mat.name || "unnamed"}" (using model M=${
                mat.metalness
              } R=${mat.roughness})`
            );
          }
        });
      }
    });
  }

  dispose() {
    if (this.envMap) {
      this.envMap.dispose();
      this.envMap = null;
    }
    this.loaded = false;
  }
}
