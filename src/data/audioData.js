/**
 * Audio Data - Unified audio definitions for music and SFX
 *
 * Uses IWSDK's AudioSource component for all audio playback.
 * All audio is criteria-based and will auto-play/stop based on game state.
 *
 * Audio Types:
 * - Music: Parented to player head (follows listener = stereo playback)
 * - SFX: Can be positional (world-space) or non-positional (player-attached)
 *
 * Each audio definition contains:
 * - id: Unique identifier
 * - src: Path to audio file
 * - type: 'music' | 'sfx'
 * - priority: 'critical' | 'background' for AssetManager preloading
 * - criteria: State conditions for auto-play (uses criteriaHelper operators)
 * - loop: Whether to loop the audio
 * - volume: Playback volume (0-1)
 * - position: For positional SFX, {x, y, z} in world space
 * - spatial: true for 3D positioned audio, false for stereo (music is always false)
 * - loopDelay: Delay in ms between loops (requires loop: true)
 */

import { GAME_STATES } from "../gameState.js";
import { checkCriteria } from "../utils/CriteriaHelper.js";

export const audioTracks = {
  // ============================================================================
  // Music Tracks (non-positional, attached to player head)
  // ============================================================================

  spaceMusic: {
    id: "spaceMusic",
    src: "./audio/music/space.mp3",
    type: "music",
    priority: "critical",
    loop: true,
    volume: 0.6,
    spatial: false,
    criteria: {
      currentState: { $gte: GAME_STATES.START_SCREEN },
    },
  },

  tabletRing: {
    id: "tabletRing",
    src: "./audio/sfx/tablet-ring.wav",
    type: "sfx",
    priority: "critical",
    loop: true,
    loopDelay: 2000,
    volume: 0.8,
    spatial: false,
    analyze: true,
    criteria: {
      currentState: GAME_STATES.XR_ACTIVE,
    },
  },
  // ============================================================================
  // Sound Effects (can be positional or non-positional)
  // ============================================================================
  // Example UI sound effect
  /*
  uiClick: {
    id: "uiClick",
    src: "./audio/sfx/click.mp3",
    type: "sfx",
    priority: "background",
    loop: false,
    volume: 0.8,
    spatial: false,
    // No criteria - triggered manually via AudioSystem.play()
  },
  
  // Example positional sound effect
  ambientHum: {
    id: "ambientHum",
    src: "./audio/sfx/ambient-hum.mp3",
    type: "sfx",
    priority: "background",
    loop: true,
    volume: 0.5,
    spatial: true,
    position: { x: 0, y: 1, z: -2 },
    criteria: {
      isXRActive: true,
      currentState: { $gte: GAME_STATES.PLAYING },
    },
  },
  */
};

/**
 * Get all audio tracks that should be preloaded via AssetManager
 * Returns format compatible with IWSDK asset manifest
 */
export function getAudioAssetManifest() {
  const manifest = {};

  for (const [id, track] of Object.entries(audioTracks)) {
    manifest[id] = {
      url: track.src,
      type: "Audio", // AssetType.Audio
      priority: track.priority || "background",
    };
  }

  return manifest;
}

/**
 * Get audio tracks that match current game state
 * @param {Object} gameState - Current game state
 * @returns {Array} Array of matching audio track definitions
 */
export function getAudioForState(gameState) {
  return Object.values(audioTracks).filter((track) => {
    if (!track.criteria) return false;
    return checkCriteria(gameState, track.criteria);
  });
}

/**
 * Get all music tracks
 */
export function getMusicTracks() {
  return Object.values(audioTracks).filter((track) => track.type === "music");
}

/**
 * Get all SFX tracks
 */
export function getSFXTracks() {
  return Object.values(audioTracks).filter((track) => track.type === "sfx");
}

export default audioTracks;
