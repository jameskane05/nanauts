/**
 * RobotCharacterManager.js - Character assignment and name tags
 * =============================================================================
 *
 * ROLE: Manages robot character assignment (personality, voice, appearance)
 * and floating name tags that billboard toward the camera.
 *
 * CHARACTER DATA:
 *   - Loaded from robotCharacters.js (Modem, Blit, Baud)
 *   - Each character has personality traits, voice type, appearance colors
 *   - Characters assigned in spawn order via getCharacterByIndex()
 *
 * NAME TAGS:
 *   - Canvas-rendered text with character accent color
 *   - Billboard toward camera each frame
 *   - Positioned above robot at nameTagOffset
 *
 * KEY METHODS:
 *   - assignCharacter(entityIndex): Get or assign character to robot
 *   - createNameTag(entityIndex, character): Create floating name label
 *   - updateNameTag(entityIndex, position): Billboard update
 *   - getCharacter(entityIndex): Get assigned character
 *   - getByName(name): Find robot by character name (for debugging)
 *
 * CLEANUP:
 *   - disposeNameTag(entityIndex): Remove single name tag
 *   - disposeAll(): Clean up all name tags and reset character index
 *
 * =============================================================================
 */
import {
  PlaneGeometry,
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  DoubleSide,
  MeshBasicMaterial,
  Mesh,
  Vector3,
} from "three";
import { getCharacterByIndex } from "../data/robotCharacters.js";
import { Logger } from "../utils/Logger.js";

export class RobotCharacterManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotCharacterManager", false);

    // Character assignments (entityIndex -> character object)
    this.characters = new Map();

    // Name tag meshes (entityIndex -> Mesh)
    this.nameTags = new Map();

    // Track nametags currently fading in (entityIndex -> { progress, targetOpacity })
    this._fadingNameTags = new Map();

    // Track next character to assign (round-robin)
    this._nextCharacterIndex = 0;

    // Name tag positioning
    this.nameTagOffset = new Vector3(0, 0.6, 0);

    // Reusable vector for camera lookAt
    this._tempVec3 = new Vector3();

    // Fade-in duration in seconds
    this._fadeInDuration = 0.4;
  }

  /**
   * Get or assign a character to a robot
   * @param {number} entityIndex
   * @returns {Object} Character config object
   */
  assignCharacter(entityIndex) {
    // Return existing if already assigned
    let character = this.characters.get(entityIndex);
    if (character) return character;

    // Assign next character in round-robin order
    character = getCharacterByIndex(this._nextCharacterIndex++);
    this.characters.set(entityIndex, character);

    this.logger.log(
      `Assigned character "${character.name}" to robot ${entityIndex}`
    );
    return character;
  }

  /**
   * Get the character assigned to a robot (without assigning)
   * @param {number} entityIndex
   * @returns {Object|null} Character config or null if not assigned
   */
  getCharacter(entityIndex) {
    return this.characters.get(entityIndex) || null;
  }

  /**
   * Get robot by character name (for console testing)
   * @param {string} name - Character name (Modem, Blit, or Baud)
   * @returns {{character: Object, entityIndex: number}|null}
   */
  getByName(name) {
    const nameLower = name.toLowerCase();
    for (const [entityIndex, character] of this.characters.entries()) {
      if (character.name.toLowerCase() === nameLower) {
        return { character, entityIndex };
      }
    }
    return null;
  }

  /**
   * Get all assigned characters
   * @returns {Map} Map of entityIndex -> character
   */
  getAllCharacters() {
    return this.characters;
  }

  /**
   * Create a billboarding name tag for a robot
   * @param {number} entityIndex
   * @param {Object} character - Character config with name and appearance
   * @returns {Mesh} The name tag mesh
   */
  createNameTag(entityIndex, character) {
    // Remove existing if any
    this.disposeNameTag(entityIndex);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");

    // Background with character accent color
    const accentColor = character.appearance?.accentColor || 0x00ffff;
    const r = (accentColor >> 16) & 0xff;
    const g = (accentColor >> 8) & 0xff;
    const b = accentColor & 0xff;

    ctx.fillStyle = `rgba(${Math.floor(r * 0.2)}, ${Math.floor(
      g * 0.2
    )}, ${Math.floor(b * 0.2)}, 0.85)`;
    ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 8);
    ctx.fill();

    // Border with accent color
    ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.lineWidth = 2;
    ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 8);
    ctx.stroke();

    // Name text
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 32px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      character.name.toUpperCase(),
      canvas.width / 2,
      canvas.height / 2
    );

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;

    const geometry = new PlaneGeometry(0.25, 0.065);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0,
      side: DoubleSide,
      depthWrite: false,
    });

    const nameTag = new Mesh(geometry, material);
    nameTag.renderOrder = -100; // Render early, before UI panels
    nameTag.frustumCulled = false;
    nameTag.visible = false; // Start hidden, will be shown via showNameTag()
    nameTag.userData.targetOpacity = 0.95;

    // Add to scene
    const scene = this.robotSystem.world?.scene;
    if (scene) {
      scene.add(nameTag);
    }

    this.nameTags.set(entityIndex, nameTag);
    return nameTag;
  }

  showNameTag(entityIndex) {
    const nameTag = this.nameTags.get(entityIndex);
    if (!nameTag) return;

    nameTag.visible = true;
    this._fadingNameTags.set(entityIndex, { progress: 0 });
    this.logger.log(`Showing nametag for entity ${entityIndex}`);
  }

  showNameTagByName(characterName) {
    for (const [entityIndex, character] of this.characters) {
      if (character.name.toLowerCase() === characterName.toLowerCase()) {
        this.showNameTag(entityIndex);
        return true;
      }
    }
    return false;
  }

  update(delta) {
    if (this._fadingNameTags.size === 0) return;

    for (const [entityIndex, fadeState] of this._fadingNameTags) {
      const nameTag = this.nameTags.get(entityIndex);
      if (!nameTag) {
        this._fadingNameTags.delete(entityIndex);
        continue;
      }

      fadeState.progress += delta / this._fadeInDuration;

      if (fadeState.progress >= 1) {
        nameTag.material.opacity = nameTag.userData.targetOpacity;
        this._fadingNameTags.delete(entityIndex);
      } else {
        const eased = 1 - Math.pow(1 - fadeState.progress, 3); // ease out cubic
        nameTag.material.opacity = nameTag.userData.targetOpacity * eased;
      }
    }
  }

  /**
   * Update name tag position and billboard toward camera
   * @param {number} entityIndex
   * @param {Array|Object} position - [x, y, z] array or {x, y, z} object
   * @param {number} animationYOffset - Extra Y offset from animations (jumps, hover, etc.)
   */
  updateNameTag(entityIndex, position, animationYOffset = 0) {
    const nameTag = this.nameTags.get(entityIndex);
    if (!nameTag) return;

    // Handle both array and object position formats
    const x = Array.isArray(position) ? position[0] : position.x;
    const y = Array.isArray(position) ? position[1] : position.y;
    const z = Array.isArray(position) ? position[2] : position.z;

    // Use per-character height if available
    const character = this.characters.get(entityIndex);
    const yOffset =
      character?.appearance?.nameTagHeight ?? this.nameTagOffset.y;

    nameTag.position.set(
      x + this.nameTagOffset.x,
      y + yOffset + animationYOffset,
      z + this.nameTagOffset.z
    );

    // Billboard toward camera
    const camera = this.robotSystem.world?.camera;
    if (camera) {
      camera.getWorldPosition(this._tempVec3);
      nameTag.lookAt(this._tempVec3.x, this._tempVec3.y, this._tempVec3.z);
    }
  }

  /**
   * Get name tag mesh for a robot
   * @param {number} entityIndex
   * @returns {Mesh|null}
   */
  getNameTag(entityIndex) {
    return this.nameTags.get(entityIndex) || null;
  }

  /**
   * Dispose a single name tag
   * @param {number} entityIndex
   */
  disposeNameTag(entityIndex) {
    const nameTag = this.nameTags.get(entityIndex);
    if (!nameTag) return;

    // Remove from scene
    if (nameTag.parent) {
      nameTag.parent.remove(nameTag);
    }

    // Dispose resources
    if (nameTag.material?.map) {
      nameTag.material.map.dispose();
    }
    if (nameTag.material) {
      nameTag.material.dispose();
    }
    if (nameTag.geometry) {
      nameTag.geometry.dispose();
    }

    this.nameTags.delete(entityIndex);
  }

  /**
   * Remove character assignment for a robot
   * @param {number} entityIndex
   */
  removeCharacter(entityIndex) {
    this.characters.delete(entityIndex);
    this.disposeNameTag(entityIndex);
  }

  /**
   * Dispose all name tags and reset character assignments
   */
  disposeAll() {
    // Dispose all name tags
    for (const [entityIndex] of this.nameTags) {
      this.disposeNameTag(entityIndex);
    }

    // Clear characters and reset index
    this.characters.clear();
    this._nextCharacterIndex = 0;
  }

  /**
   * Test a voice mood on a character by name (console debugging)
   * @param {string} characterName
   * @param {string} mood
   */
  testVoice(characterName, mood) {
    const robot = this.getByName(characterName);
    if (!robot) {
      this.logger.warn(`No robot found with character name: ${characterName}`);
      this.logger.log(
        "Available characters:",
        [...this.characters.values()].map((c) => c.name)
      );
      return;
    }

    const voice = this.robotSystem.audioManager?.getVoice(robot.entityIndex);
    if (!voice) {
      this.logger.warn(`Robot ${characterName} has no voice initialized yet`);
      return;
    }

    if (typeof voice[mood] !== "function") {
      this.logger.warn(`Invalid mood: ${mood}`);
      this.logger.log(
        "Available moods: content, excited, happy, sad, angry, curious, inquisitive, acknowledge"
      );
      return;
    }

    this.logger.log(`Testing ${characterName}'s ${mood} mood...`);
    voice[mood]();
  }
}
