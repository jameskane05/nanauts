/**
 * AudioSystem - ECS System for criteria-based audio playback
 *
 * Uses IWSDK's AudioSource component and AudioUtils for all audio.
 * - Music tracks are parented to player head (stereo playback)
 * - SFX can be positional (world-space) or non-positional
 *
 * Tracks with `analyze: true` use HTML Audio elements routed through
 * AudioAmplitudeSystem for real-time amplitude analysis (haptics, visuals).
 *
 * Listens to gameState changes and auto-plays/stops audio based on criteria.
 */

import { createSystem, AudioUtils, AudioSource } from "@iwsdk/core";
import { gameState, GAME_STATES } from "../gameState.js";
import { audioTracks } from "../data/audioData.js";
import { checkCriteria } from "../utils/CriteriaHelper.js";
import { getAudioAnalyzer } from "../utils/AudioAnalyzer.js";
import { onVisibilityChange } from "../audio/audioContext.js";
import { Logger } from "../utils/Logger.js";

export class AudioSystem extends createSystem({}, {}) {
  init() {
    this.logger = new Logger("AudioSystem", false);
    this.logger.log("Initializing");

    // Get player reference for attaching audio
    this.player = this.world.player || this.world.getPlayer?.();

    // Map of track id -> entity (for cleanup and state tracking)
    this.audioEntities = new Map();

    // Map of track id -> HTMLAudioElement (for analyzed tracks)
    this.audioElements = new Map();

    // Track which audio is currently playing
    this.playingTracks = new Set();

    // Map of track id -> timeout ID (for loopDelay cleanup)
    this.loopTimeouts = new Map();

    // Get audio analyzer for tracks that need amplitude analysis
    this.analyzer = getAudioAnalyzer();

    // Subscribe to game state changes
    gameState.on("state:changed", (newState, oldState) => {
      this.updateAudioForState(newState);

      // Handle volume changes
      if (newState.musicVolume !== oldState.musicVolume) {
        this.applyMusicVolume(newState.musicVolume);
      }
      if (newState.sfxVolume !== oldState.sfxVolume) {
        this.applySfxVolume(newState.sfxVolume);
      }

      // Handle XR pause state
      if (
        newState.currentState === GAME_STATES.XR_PAUSED &&
        oldState.currentState !== GAME_STATES.XR_PAUSED
      ) {
        this.pauseAll();
      } else if (
        oldState.currentState === GAME_STATES.XR_PAUSED &&
        newState.currentState !== GAME_STATES.XR_PAUSED
      ) {
        this.resumeAll();
      }
    });

    // Handle document visibility changes (tab hidden)
    this._unsubVisibility = onVisibilityChange((visible) => {
      if (visible) {
        this.resumeAll();
      } else {
        this.pauseAll();
      }
    });

    // Initial state check
    this.updateAudioForState(gameState.getState());
  }

  /**
   * Update audio playback based on current game state
   * @param {Object} state - Current game state
   */
  updateAudioForState(state) {
    for (const [id, track] of Object.entries(audioTracks)) {
      const matchesCriteria = track.criteria
        ? checkCriteria(state, track.criteria)
        : false;
      const isPlaying = this.playingTracks.has(id);

      if (matchesCriteria && !isPlaying) {
        // Should play but isn't - start it
        this.playTrack(id, track);
      } else if (!matchesCriteria && isPlaying) {
        // Shouldn't play but is - stop it
        this.stopTrack(id);
      }
    }
  }

  /**
   * Play an audio track
   * @param {string} id - Track ID
   * @param {Object} track - Track definition from audioData
   */
  playTrack(id, track) {
    if (this.playingTracks.has(id)) return;

    this.logger.log(
      `Playing track: ${id}${track.analyze ? " (with analysis)" : ""}`
    );

    // If track needs amplitude analysis OR has loopDelay, use HTML Audio
    if (track.analyze || track.loopDelay > 0) {
      this.playAnalyzedTrack(id, track);
      return;
    }

    // Create entity for this audio
    let entity;

    if (track.type === "music" || !track.spatial) {
      // Non-positional audio - attach to player head (or camera if no player)
      const parent = this.player?.head || this.world.camera;
      entity = this.world.createTransformEntity(undefined, {
        parent: parent,
      });
    } else if (track.spatial && track.position) {
      // Positional audio - place in world
      entity = this.world.createTransformEntity();
      entity.object3D.position.set(
        track.position.x || 0,
        track.position.y || 0,
        track.position.z || 0
      );
    } else {
      // Default - attach to player head (or camera if no player)
      const parent = this.player?.head || this.world.camera;
      entity = this.world.createTransformEntity(undefined, {
        parent: parent,
      });
    }

    // Add AudioSource component with user volume applied
    const state = gameState.getState();
    const globalVolume =
      track.type === "music" ? state.musicVolume : state.sfxVolume;
    const effectiveVolume = (track.volume || 1.0) * globalVolume;

    try {
      entity.addComponent(AudioSource, {
        src: track.src,
        loop: track.loop || false,
        volume: effectiveVolume,
        autoplay: true,
      });

      // Try to play via AudioUtils
      AudioUtils.play(entity);

      this.audioEntities.set(id, entity);
      this.playingTracks.add(id);
    } catch (error) {
      this.logger.warn(`Failed to play track ${id}:`, error);
      entity.destroy();
    }
  }

  /**
   * Play a track using HTML Audio (supports loopDelay and optional amplitude analysis)
   * @param {string} id - Track ID
   * @param {Object} track - Track definition
   */
  playAnalyzedTrack(id, track) {
    try {
      // Create HTML Audio element with user volume applied
      const state = gameState.getState();
      const globalVolume =
        track.type === "music" ? state.musicVolume : state.sfxVolume;
      const audio = new Audio(track.src);
      audio.volume = (track.volume || 1.0) * globalVolume;

      // Handle looping - if loopDelay is specified, we handle it manually
      if (track.loop && track.loopDelay > 0) {
        audio.loop = false;
        audio.addEventListener("ended", () => {
          if (!this.playingTracks.has(id)) return;
          const timeoutId = setTimeout(() => {
            if (this.playingTracks.has(id)) {
              audio.currentTime = 0;
              audio.play().catch(() => {});
            }
          }, track.loopDelay);
          this.loopTimeouts.set(id, timeoutId);
        });
      } else {
        audio.loop = track.loop || false;
      }

      // Connect to analyzer for amplitude tracking only if requested
      if (track.analyze) {
        if (!this.analyzer._initialized) {
          this.analyzer.init();
        }
        this.analyzer.connectAudioElement(audio, id);
      }

      // Play the audio
      audio.play().catch((err) => {
        this.logger.warn(`Failed to play track ${id}:`, err);
      });

      this.audioElements.set(id, audio);
      this.playingTracks.add(id);

      this.logger.log(
        `Playing: ${id}${track.analyze ? " (analyzed)" : ""}${
          track.loopDelay ? ` (${track.loopDelay}ms loop delay)` : ""
        }`
      );
    } catch (error) {
      this.logger.warn(`Failed to setup track ${id}:`, error);
    }
  }

  /**
   * Stop an audio track
   * @param {string} id - Track ID
   */
  stopTrack(id) {
    if (!this.playingTracks.has(id)) return;

    this.logger.log(`Stopping track: ${id}`);

    // Clear any pending loop timeout
    const timeoutId = this.loopTimeouts.get(id);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.loopTimeouts.delete(id);
    }

    // Check if this is an HTML Audio track
    const audioElement = this.audioElements.get(id);
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
      // Only disconnect from analyzer if it was connected
      const track = audioTracks[id];
      if (track?.analyze) {
        this.analyzer.disconnect(id);
      }
      this.audioElements.delete(id);
      this.playingTracks.delete(id);
      return;
    }

    // Standard IWSDK AudioSource track
    const entity = this.audioEntities.get(id);
    if (entity) {
      try {
        AudioUtils.stop(entity);
      } catch (error) {
        // AudioUtils.stop may not exist - just destroy entity
      }
      entity.destroy();
      this.audioEntities.delete(id);
    }

    this.playingTracks.delete(id);
  }

  /**
   * Manually play a one-shot sound (no criteria, immediate playback)
   * @param {string} id - Track ID from audioData
   */
  playOneShot(id) {
    const track = audioTracks[id];
    if (!track) {
      this.logger.warn(`Unknown track: ${id}`);
      return;
    }

    this.logger.log(`Playing one-shot: ${id}`);

    // Create temporary entity
    const parent = this.player?.head || this.world.camera;
    const entity = this.world.createTransformEntity(undefined, {
      parent: parent,
    });

    try {
      const state = gameState.getState();
      const globalVolume =
        track.type === "music" ? state.musicVolume : state.sfxVolume;

      entity.addComponent(this.world.components.AudioSource || AudioSource, {
        src: track.src,
        loop: false,
        volume: (track.volume || 1.0) * globalVolume,
        autoplay: true,
      });

      AudioUtils.play(entity);

      // Clean up entity after sound completes (estimate duration or use fixed time)
      setTimeout(() => {
        entity.destroy();
      }, 5000); // 5 second cleanup delay
    } catch (error) {
      this.logger.warn(`Failed to play one-shot ${id}:`, error);
      entity.destroy();
    }
  }

  /**
   * Apply music volume to all playing music tracks
   * @param {number} volume - Volume (0-1)
   */
  applyMusicVolume(volume) {
    this.logger.log(`Applying music volume: ${volume}`);

    // Update HTML Audio elements (analyzed tracks)
    for (const [id, audio] of this.audioElements) {
      const track = audioTracks[id];
      if (track && track.type === "music") {
        audio.volume = volume * (track.volume || 1.0);
      }
    }

    // Update IWSDK AudioSource entities
    for (const [id, entity] of this.audioEntities) {
      const track = audioTracks[id];
      if (track && track.type === "music") {
        try {
          const audioSource = entity.getComponent(AudioSource);
          if (audioSource) {
            audioSource.volume = volume * (track.volume || 1.0);
          }
        } catch (error) {
          // Fallback - try setValue API
          try {
            entity.setValue(
              AudioSource,
              "volume",
              volume * (track.volume || 1.0)
            );
          } catch (e) {}
        }
      }
    }
  }

  /**
   * Apply SFX volume to all playing SFX tracks
   * @param {number} volume - Volume (0-1)
   */
  applySfxVolume(volume) {
    this.logger.log(`Applying SFX volume: ${volume}`);

    // Update HTML Audio elements (analyzed tracks)
    for (const [id, audio] of this.audioElements) {
      const track = audioTracks[id];
      if (track && track.type === "sfx") {
        audio.volume = volume * (track.volume || 1.0);
      }
    }

    // Update IWSDK AudioSource entities
    for (const [id, entity] of this.audioEntities) {
      const track = audioTracks[id];
      if (track && track.type === "sfx") {
        try {
          const audioSource = entity.getComponent(AudioSource);
          if (audioSource) {
            audioSource.volume = volume * (track.volume || 1.0);
          }
        } catch (error) {
          try {
            entity.setValue(
              AudioSource,
              "volume",
              volume * (track.volume || 1.0)
            );
          } catch (e) {}
        }
      }
    }
  }

  /**
   * Set music volume (public API)
   * @param {number} volume - Volume (0-1)
   */
  setMusicVolume(volume) {
    gameState.setState({ musicVolume: volume });
  }

  /**
   * Set SFX volume (public API)
   * @param {number} volume - Volume (0-1)
   */
  setSFXVolume(volume) {
    gameState.setState({ sfxVolume: volume });
  }

  /**
   * Stop all audio (e.g., when XR session ends)
   */
  stopAll() {
    for (const id of this.playingTracks) {
      this.stopTrack(id);
    }
  }

  /**
   * Pause all audio (e.g., when XR paused)
   */
  pauseAll() {
    // Pause HTML Audio elements (analyzed tracks)
    for (const [id, audio] of this.audioElements) {
      audio.pause();
    }

    // Pause IWSDK AudioSource tracks
    for (const [id, entity] of this.audioEntities) {
      try {
        AudioUtils.pause(entity);
      } catch (error) {
        // Pause may not be supported
      }
    }
  }

  /**
   * Resume all audio (e.g., when XR resumed)
   */
  resumeAll() {
    // Resume HTML Audio elements (analyzed tracks)
    for (const [id, audio] of this.audioElements) {
      audio.play().catch(() => {});
    }

    // Resume IWSDK AudioSource tracks
    for (const [id, entity] of this.audioEntities) {
      try {
        AudioUtils.play(entity);
      } catch (error) {
        // Resume may not be supported
      }
    }
  }

  update(delta, time) {
    // No per-frame updates needed - all logic is event-driven via state changes
  }

  destroy() {
    this.logger.log("Destroying");
    if (this._unsubVisibility) {
      this._unsubVisibility();
    }
    this.stopAll();
  }
}
