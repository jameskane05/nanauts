/**
 * RobotAudioManager.js - Robot engine sounds and voice chatter
 * =============================================================================
 *
 * ROLE: Manages spatial audio for robots including engine hum (continuous) and
 * voice chatter (periodic mood sounds). Handles pause/resume for tab/XR state.
 *
 * AUDIO TYPES:
 *   - Engine: Continuous hum from RobotEngine, varies with speed/jumping
 *   - Voice: Character-specific mood sounds (happy, curious, content, etc.)
 *     via RobotVoice. Triggered by interactions or random chatter.
 *
 * KEY METHODS:
 *   - createEngineForRobot(entityIndex): Initialize engine audio
 *   - createVoiceForRobot(entityIndex, character): Initialize voice
 *   - getVoice(entityIndex)/getEngine(entityIndex): Access audio instances
 *   - updateEngine(entityIndex, speed, isJumping, jumpProgress): Per-frame
 *   - setAudioEnabled(bool)/setVoiceEnabled(bool): Master toggles
 *
 * CHATTER SYSTEM:
 *   - Random interval between chatterIntervalMin/Max (5-20s default)
 *   - Robots occasionally make mood sounds when not interacting
 *
 * PAUSE HANDLING:
 *   - Pauses all engines when tab hidden (document visibility)
 *   - Pauses when XR headset removed (GAME_STATES.XR_PAUSED)
 *   - Resumes automatically when state restored
 *
 * SPATIAL AUDIO: Uses Web Audio API with HRTF panning. Listener position
 * updated from camera via updateListenerPosition().
 * =============================================================================
 */
import { RobotEngine } from "../audio/RobotEngine.js";
import { createVoiceForCharacter } from "../audio/RobotVoice.js";
import {
  resumeAudioContext,
  updateListenerPosition,
  setMasterVolume,
  onVisibilityChange,
} from "../audio/audioContext.js";
import { Logger } from "../utils/Logger.js";
import { gameState, GAME_STATES } from "../gameState.js";

export class RobotAudioManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotAudioManager", false);

    // Audio instances per robot
    this.robotAudioEngines = new Map();
    this.robotVoices = new Map();
    this.robotNextChatter = new Map();

    // Audio settings
    this.audioEnabled = true;
    this.voiceEnabled = true;
    this.chatterIntervalMin = 5000;
    this.chatterIntervalMax = 20000;

    // Reusable vector for listener direction
    this._audioForward = null; // Will be set from robotSystem

    // Pause state
    this._isPaused = false;

    // Listen for document visibility changes (tab hidden)
    this._unsubVisibility = onVisibilityChange((visible) => {
      if (visible) {
        this._resumeAllEngines();
      } else {
        this._pauseAllEngines();
      }
    });

    // Listen for XR pause state (headset removed)
    gameState.on("state:changed", (newState, oldState) => {
      if (
        newState.currentState === GAME_STATES.XR_PAUSED &&
        oldState.currentState !== GAME_STATES.XR_PAUSED
      ) {
        this._pauseAllEngines();
      } else if (
        oldState.currentState === GAME_STATES.XR_PAUSED &&
        newState.currentState !== GAME_STATES.XR_PAUSED
      ) {
        this._resumeAllEngines();
      }
    });
  }

  setAudioEnabled(enabled) {
    this.audioEnabled = enabled;
    if (!enabled) {
      for (const [, engine] of this.robotAudioEngines) {
        engine.stop();
      }
    }
    this.logger.log(`Robot audio ${enabled ? "enabled" : "disabled"}`);
  }

  setVoiceEnabled(enabled) {
    this.voiceEnabled = enabled;
    this.logger.log(`Robot voice ${enabled ? "enabled" : "disabled"}`);
  }

  getVoice(entityIndex) {
    return this.robotVoices.get(entityIndex);
  }

  getEngine(entityIndex) {
    return this.robotAudioEngines.get(entityIndex);
  }

  createEngineForRobot(entityIndex, character) {
    if (this.robotAudioEngines.has(entityIndex)) {
      return this.robotAudioEngines.get(entityIndex);
    }

    resumeAudioContext();
    const pitchOffset = character?.pitchOffset ?? 0;
    const engine = new RobotEngine(pitchOffset);
    this.robotAudioEngines.set(entityIndex, engine);
    return engine;
  }

  createVoiceForRobot(entityIndex, character) {
    if (this.robotVoices.has(entityIndex)) {
      return this.robotVoices.get(entityIndex);
    }

    resumeAudioContext();
    const voice = createVoiceForCharacter(character);
    this.robotVoices.set(entityIndex, voice);

    // Stagger initial chatter
    const initialDelay = Math.random() * this.chatterIntervalMax;
    this.robotNextChatter.set(entityIndex, Date.now() + initialDelay);

    return voice;
  }

  robotSpeak(entityIndex, emotion) {
    const voice = this.robotVoices.get(entityIndex);
    if (voice && typeof voice[emotion] === "function") {
      voice[emotion]();
    }
  }

  allRobotsSpeak(emotion) {
    for (const [entityIndex, voice] of this.robotVoices) {
      setTimeout(() => {
        if (typeof voice[emotion] === "function") {
          voice[emotion]();
        }
      }, Math.random() * 500);
    }
  }

  testVoice(entityIndex, mood) {
    const voice = this.robotVoices.get(entityIndex);
    if (!voice) {
      this.logger.warn(`No voice found for robot ${entityIndex}`);
      return;
    }

    if (typeof voice[mood] === "function") {
      voice[mood]();
      this.logger.log(`Playing ${mood} on robot ${entityIndex}`);
    } else {
      this.logger.warn(`Unknown mood "${mood}"`);
    }
  }

  updateListenerPosition(camera, audioForward) {
    if (!camera) return;

    const forward = camera.getWorldDirection(audioForward);
    updateListenerPosition(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      forward.x,
      forward.y,
      forward.z
    );
  }

  updateRobot(entityIndex, agentPosition, speed, deltaTime) {
    // Update engine
    if (this.audioEnabled) {
      const engine = this.robotAudioEngines.get(entityIndex);
      if (engine) {
        engine.setPosition(
          agentPosition[0],
          agentPosition[1],
          agentPosition[2]
        );
        engine.setSpeed(speed);
      }
    }

    // Update voice position
    if (this.voiceEnabled) {
      const voice = this.robotVoices.get(entityIndex);
      if (voice) {
        voice.setPosition(agentPosition[0], agentPosition[1], agentPosition[2]);
      }
    }
  }

  updateChatter(entityIndex) {
    if (!this.voiceEnabled) return false;

    const voice = this.robotVoices.get(entityIndex);
    if (!voice) return false;

    const now = Date.now();
    const nextChatter = this.robotNextChatter.get(entityIndex);

    if (now >= nextChatter) {
      voice.randomContent();
      const nextInterval =
        this.chatterIntervalMin +
        Math.random() * (this.chatterIntervalMax - this.chatterIntervalMin);
      this.robotNextChatter.set(entityIndex, now + nextInterval);
      return true;
    }

    return false;
  }

  _pauseAllEngines() {
    if (this._isPaused) return;
    this._isPaused = true;
    this.logger.log("Pausing all robot audio");
    for (const [, engine] of this.robotAudioEngines) {
      engine.pause();
    }
  }

  _resumeAllEngines() {
    if (!this._isPaused) return;
    this._isPaused = false;
    this.logger.log("Resuming all robot audio");
    for (const [, engine] of this.robotAudioEngines) {
      engine.resume();
    }
  }

  stopAll() {
    for (const [, engine] of this.robotAudioEngines) {
      engine.stop();
    }
    this.robotAudioEngines.clear();
    this.robotVoices.clear();
    this.robotNextChatter.clear();
  }

  dispose() {
    if (this._unsubVisibility) {
      this._unsubVisibility();
    }
    this.stopAll();
  }
}
