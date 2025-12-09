/**
 * CallPanelUI.js - CALL PANEL SPECIFIC UI LOGIC
 * =============================================================================
 *
 * Handles all call panel specific functionality: incoming/active call UI states,
 * phoneme/viseme animation, call timer, haptic feedback, and audio-reactive
 * animations.
 *
 * RESPONSIBILITIES:
 * - Incoming call UI (ringing state)
 * - Active call UI (connected state)
 * - Phoneme mesh creation and frame updates
 * - Call timer display
 * - Haptic pulse during ringing
 * - Audio-reactive button/status animations
 * =============================================================================
 */

import { Logger } from "../utils/Logger.js";
import { getAudioAnalyzer } from "../utils/AudioAnalyzer.js";
import { VisemeRenderer } from "./VisemeRenderer.js";
import { ThumbTapRenderer } from "./ThumbTapRenderer.js";
import { uiAudio } from "../audio/UIAudio.js";
import { hapticManager } from "../utils/HapticManager.js";
import { gameState } from "../gameState.js";

export const CALL_STATE = {
  HIDDEN: "hidden",
  INCOMING: "incoming",
  ACTIVE: "active",
};

export class CallPanelUI {
  constructor(registry, mountManager, options = {}) {
    this.registry = registry;
    this.mountManager = mountManager;
    this.logger = new Logger("CallPanelUI", options.debug ?? false);

    this.currentState = CALL_STATE.HIDDEN;
    // Size viseme to fill video container (176px of 200px panel, scaled by mount mode)
    this.viseme = new VisemeRenderer({
      size: 0.15,
      position: { x: 0, y: -0.015, z: -0.01 },
    });
    this.worldViseme = new VisemeRenderer({
      size: 0.75,
      position: { x: 0, y: -0.065, z: -0.01 },
      renderOrder: 8910, // Below HUD/wrist panels (9000) but above world panel (8900)
    });

    this.callStartTime = 0;
    this.callTimerInterval = null;

    this.hapticPulsing = false;
    this.hapticInterval = null;

    this._visualAmplitude = 0;
    this._visualSmoothingFactor = 0.08;
    this._hologramTime = 0;

    // Panel fade animation (matches mount transition ~0.5s)
    this._fadeProgress = 0;
    this._fadeTarget = 0;
    this._fadeDuration = 0.5; // seconds - matches position lerp timing

    // Incoming UI → Viseme crossfade (when answering call)
    this._incomingUIOpacity = 1;
    this._incomingUITarget = 1;
    this._visemeOpacity = 0;
    this._visemeTarget = 0;
    this._crossfadeDuration = 0.5; // seconds - matches position lerp timing

    this.onCallAnswered = options.onCallAnswered || null;
    this.onCallEnded = options.onCallEnded || null;

    this.inputMode = "controllers";

    this.thumbTap = new ThumbTapRenderer({
      size: 0.028,
      position: { x: 0.0525, y: -0.065, z: 0.01 },
    });
    this._thumbTapCreated = false;
  }

  getDocument() {
    return this.registry.getDocument("call");
  }

  setState(state) {
    if (state === this.currentState) return;
    this.logger.log(`Call state: ${this.currentState} -> ${state}`);

    // Exit current state
    if (this.currentState === CALL_STATE.INCOMING) {
      this.stopHapticPulse();
    }
    if (this.currentState === CALL_STATE.ACTIVE) {
      this._stopCallTimer();
    }

    this.currentState = state;

    // Enter new state
    this._updateUIForState(state);

    if (state === CALL_STATE.INCOMING) {
      this.startHapticPulse();
      // Sync input mode from gameState, then apply to UI
      this.inputMode = gameState.getState().inputMode || "controllers";
      this._applyInputModeToUI();
    }
    if (state === CALL_STATE.ACTIVE) {
      this._startCallTimer();
    }
  }

  _updateUIForState(state) {
    // Update both call and callWorld documents
    const docs = [
      this.registry.getDocument("call"),
      this.registry.getDocument("callWorld"),
    ].filter(Boolean);

    // Trigger fade animation
    if (state === CALL_STATE.INCOMING || state === CALL_STATE.ACTIVE) {
      this._fadeTarget = 1;
      this.logger.log(
        `Starting fade-in: progress=${this._fadeProgress}, target=${this._fadeTarget}`
      );
    } else if (state === CALL_STATE.HIDDEN) {
      this._fadeTarget = 0;
      this.logger.log(
        `Starting fade-out: progress=${this._fadeProgress}, target=${this._fadeTarget}`
      );
    }

    // Set crossfade targets (must happen even if docs not ready yet)
    if (state === CALL_STATE.INCOMING) {
      this._incomingUITarget = 1;
      this._visemeTarget = 0;
    } else if (state === CALL_STATE.ACTIVE) {
      this._incomingUITarget = 0;
      this._visemeTarget = 1;
    }

    // Update DOM elements (only if documents are ready)
    for (const doc of docs) {
      const statusText = doc.getElementById("status-text");
      const statusDot = doc.getElementById("status-dot");

      if (state === CALL_STATE.INCOMING) {
        const incomingPrompt = doc.getElementById("incoming-prompt");
        const incomingInfo = doc.getElementById("incoming-info");
        if (incomingPrompt) incomingPrompt.setProperties({ display: "flex" });
        if (incomingInfo) incomingInfo.setProperties({ display: "flex" });
        if (statusText) statusText.setProperties({ text: "RINGING" });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#f0ad4e" });
      } else if (state === CALL_STATE.ACTIVE) {
        const incomingPrompt = doc.getElementById("incoming-prompt");
        const incomingInfo = doc.getElementById("incoming-info");
        if (incomingPrompt) incomingPrompt.setProperties({ display: "none" });
        if (incomingInfo) incomingInfo.setProperties({ display: "none" });
        if (statusText) statusText.setProperties({ text: "CONNECTED" });
        if (statusDot) statusDot.setProperties({ backgroundColor: "#00d4e6" });
      }
    }

    // Handle viseme creation and thumbtap visibility
    if (state === CALL_STATE.INCOMING) {
      this.viseme.hide();
    } else if (state === CALL_STATE.ACTIVE) {
      this._createViseme();
      this.viseme.setAlpha(0); // Start invisible, will fade in
      this._visemeOpacity = 0; // Reset opacity for crossfade animation
      this.thumbTap.hide(); // Hide thumbtap when call is answered
    } else if (state === CALL_STATE.HIDDEN) {
      this._stopVideo();
      this.thumbTap.hide();
    }
  }

  setStatusText(text) {
    const doc = this.getDocument();
    if (!doc) return;
    const statusText = doc.getElementById("status-text");
    if (statusText) statusText.setProperties({ text });
  }

  setCallerName(name) {
    const doc = this.getDocument();
    if (!doc) return;
    const nameEl = doc.getElementById("caller-name");
    if (nameEl) nameEl.setProperties({ text: name });
  }

  updateInputModeUI(inputMode) {
    this.inputMode = inputMode;

    // Only update UI if we're in INCOMING state (when these elements are visible)
    if (this.currentState === CALL_STATE.INCOMING) {
      this._applyInputModeToUI();
    }
  }

  _applyInputModeToUI() {
    const docs = [
      this.registry.getDocument("call"),
      this.registry.getDocument("callWorld"),
    ].filter(Boolean);

    this._ensureThumbTapCreated();

    for (const doc of docs) {
      const buttonHint = doc.getElementById("button-hint");
      const buttonLetter = doc.getElementById("button-letter");
      const promptText = doc.getElementById("prompt-text");

      if (this.inputMode === "hands") {
        if (buttonHint) buttonHint.setProperties({ display: "none" });
        this.thumbTap.show();
        if (promptText)
          promptText.setProperties({ text: "THUMBTAP TO ANSWER" });
      } else {
        if (buttonHint) buttonHint.setProperties({ display: "flex" });
        this.thumbTap.hide();
        if (buttonLetter) buttonLetter.setProperties({ text: "A" });
        if (promptText) promptText.setProperties({ text: "PRESS TO ANSWER" });
      }
    }
  }

  _ensureThumbTapCreated() {
    if (this._thumbTapCreated) return;
    const panel = this.registry.getPanel("call");
    if (panel?.group) {
      this.thumbTap.create(panel.group);
      this._thumbTapCreated = true;
    }
  }

  _createViseme() {
    const panel = this.registry.getPanel("call");
    if (panel?.group) {
      this.viseme.create(panel.group);
      this.logger.log("Viseme created");
    }
  }

  showPhoneme() {
    this._createViseme();
    this.viseme.show();
  }

  updatePhonemeFrame(frameIndex, uv) {
    this.viseme.updateFrame(uv);
    this.worldViseme.updateFrame(uv);
  }

  getPhoneMesh() {
    return this.viseme.mesh;
  }

  createWorldViseme() {
    const panel = this.registry.getPanel("callWorld");
    if (panel?.group) {
      this.worldViseme.create(panel.group);
      this.worldViseme.show();
      this.logger.log("World viseme created");
    }
  }

  hideWorldViseme() {
    this.worldViseme.hide();
  }

  _startCallTimer() {
    this.callStartTime = performance.now();
    this.callTimerInterval = setInterval(() => {
      const elapsed = Math.floor(
        (performance.now() - this.callStartTime) / 1000
      );
      const mins = Math.floor(elapsed / 60)
        .toString()
        .padStart(2, "0");
      const secs = (elapsed % 60).toString().padStart(2, "0");

      const doc = this.getDocument();
      if (doc) {
        const timerEl = doc.getElementById("status-text");
        if (timerEl) timerEl.setProperties({ text: `${mins}:${secs}` });
      }
    }, 1000);
  }

  _stopCallTimer() {
    if (this.callTimerInterval) {
      clearInterval(this.callTimerInterval);
      this.callTimerInterval = null;
    }
  }

  _stopVideo() {
    this.viseme.hide();
  }

  startHapticPulse() {
    this.hapticPulsing = true;
    this._pulseHaptic();
  }

  stopHapticPulse() {
    this.hapticPulsing = false;
    if (this.hapticInterval) {
      clearTimeout(this.hapticInterval);
      this.hapticInterval = null;
    }
  }

  _pulseHaptic() {
    if (!this.hapticPulsing) return;

    const xrInput = this.mountManager.getXRInput();
    if (xrInput?.gamepads) {
      const gamepad = xrInput.gamepads.right || xrInput.gamepads.left;

      if (gamepad?.hapticActuators?.[0]) {
        gamepad.hapticActuators[0].pulse(1.0, 200);
      } else if (gamepad?.vibrationActuator) {
        gamepad.vibrationActuator.playEffect("dual-rumble", {
          duration: 200,
          strongMagnitude: 1.0,
          weakMagnitude: 1.0,
        });
      }
    }

    this.hapticInterval = setTimeout(() => this._pulseHaptic(), 500);
  }

  update(dt) {
    const deltaTime = dt || 1 / 60;

    // Thumbtap only needed for incoming call in hands mode
    if (
      this.inputMode === "hands" &&
      this.currentState === CALL_STATE.INCOMING
    ) {
      if (!this._thumbTapCreated) {
        this._ensureThumbTapCreated();
      }
      if (
        this.thumbTap.ready &&
        this.thumbTap.mesh &&
        !this.thumbTap.mesh.visible
      ) {
        this.thumbTap.show();
      }
      this.thumbTap.update();
    }

    // Update fade animation
    this._updateFadeAnimation(deltaTime);

    // Update incoming UI ↔ viseme crossfade
    this._updateCrossfade(deltaTime);

    // Update hologram shader time (runs during active call)
    if (this.currentState === CALL_STATE.ACTIVE) {
      // Ensure viseme is created (might not have been ready when setState was called)
      if (!this.viseme.mesh) {
        this._createViseme();
      }
      // Once mesh exists, ensure it's visible
      if (this.viseme.mesh && !this.viseme.mesh.visible) {
        this.viseme.show();
        this.logger.log(`Viseme shown (deferred), alpha=${this._visemeOpacity}`);
      }

      this._hologramTime += deltaTime;
      if (this.viseme.uniforms) {
        this.viseme.uniforms.uTime.value = this._hologramTime;
      }
      if (this.worldViseme.uniforms) {
        this.worldViseme.uniforms.uTime.value = this._hologramTime;
      }
    }

    if (this.currentState !== CALL_STATE.INCOMING) return;

    const doc = this.getDocument();
    if (!doc) return;

    const analyzer = getAudioAnalyzer();
    const rawAmplitude = analyzer.getSmoothedAmplitude();

    this._visualAmplitude +=
      (rawAmplitude - this._visualAmplitude) * this._visualSmoothingFactor;

    const boosted = Math.min(1, this._visualAmplitude * 10);

    // Only animate button hint in controller mode (hidden in hands mode)
    if (this.inputMode !== "hands") {
      const buttonHint = doc.getElementById("button-hint");
      if (buttonHint) {
        const r = Math.floor(0 + boosted * 255);
        const g = Math.floor(212 + boosted * 43);
        const b = Math.floor(230 + boosted * 25);
        buttonHint.setProperties({
          backgroundColor: `rgb(${r}, ${g}, ${b})`,
        });
      }
    }

    const statusDot = doc.getElementById("status-dot");
    if (statusDot) {
      const r = Math.floor(240 + boosted * 15);
      const g = Math.floor(173 + boosted * 82);
      const b = Math.floor(78 + boosted * 177);
      statusDot.setProperties({
        backgroundColor: `rgb(${r}, ${g}, ${b})`,
      });
    }

    const incomingPrompt = doc.getElementById("incoming-prompt");
    if (incomingPrompt) {
      const alpha = 0.7 + boosted * 0.25;
      const borderAlpha = 0.5 + boosted * 0.5;
      incomingPrompt.setProperties({
        backgroundColor: `rgba(0, 70, 90, ${alpha})`,
        borderColor: `rgba(0, 220, 240, ${borderAlpha})`,
      });
    }
  }

  setupInteractions(onEndCall) {
    const doc = this.getDocument();
    if (!doc) return;

    const endBtn = doc.getElementById("end-call-btn");
    if (endBtn) {
      endBtn.addEventListener("click", () => {
        uiAudio.cancel();
        hapticManager.pulseBoth(0.6, 50);
        if (onEndCall) onEndCall();
      });
    }
  }

  _updateFadeAnimation(dt) {
    const panel = this.registry.getPanel("call");
    if (!panel?.group) return;

    // Skip if already at target
    if (Math.abs(this._fadeProgress - this._fadeTarget) < 0.001) {
      this._fadeProgress = this._fadeTarget;
      // Hide when fully faded for performance
      if (this._fadeProgress <= 0.001) {
        panel.group.visible = false;
      }
      return;
    }

    // Lerp toward target
    const speed = 1 / this._fadeDuration;
    if (this._fadeProgress < this._fadeTarget) {
      this._fadeProgress = Math.min(
        this._fadeTarget,
        this._fadeProgress + speed * dt
      );
      // Ensure visible when fading in
      panel.group.visible = true;
    } else {
      this._fadeProgress = Math.max(
        this._fadeTarget,
        this._fadeProgress - speed * dt
      );
    }

    // Apply opacity to panel's object3D materials
    this._applyOpacityToGroup(panel.group, this._fadeProgress);

    // Hide when fully faded for performance
    if (this._fadeProgress <= 0.001) {
      panel.group.visible = false;
    }
  }

  _updateCrossfade(dt) {
    const speed = 1 / this._crossfadeDuration;

    // Animate incoming UI opacity
    if (Math.abs(this._incomingUIOpacity - this._incomingUITarget) > 0.001) {
      if (this._incomingUIOpacity < this._incomingUITarget) {
        this._incomingUIOpacity = Math.min(
          this._incomingUITarget,
          this._incomingUIOpacity + speed * dt
        );
      } else {
        this._incomingUIOpacity = Math.max(
          this._incomingUITarget,
          this._incomingUIOpacity - speed * dt
        );
      }

      // Apply to incoming UI elements
      const doc = this.getDocument();
      if (doc) {
        const incomingPrompt = doc.getElementById("incoming-prompt");
        const incomingInfo = doc.getElementById("incoming-info");
        if (incomingPrompt) {
          incomingPrompt.setProperties({ opacity: this._incomingUIOpacity });
          if (this._incomingUIOpacity <= 0.01) {
            incomingPrompt.setProperties({ display: "none" });
          }
        }
        if (incomingInfo) {
          incomingInfo.setProperties({ opacity: this._incomingUIOpacity });
          if (this._incomingUIOpacity <= 0.01) {
            incomingInfo.setProperties({ display: "none" });
          }
        }
      }
    }

    // Animate viseme opacity
    if (Math.abs(this._visemeOpacity - this._visemeTarget) > 0.001) {
      if (this._visemeOpacity < this._visemeTarget) {
        this._visemeOpacity = Math.min(
          this._visemeTarget,
          this._visemeOpacity + speed * dt
        );
      } else {
        this._visemeOpacity = Math.max(
          this._visemeTarget,
          this._visemeOpacity - speed * dt
        );
      }

      // Apply to viseme shader
      this.viseme.setAlpha(this._visemeOpacity);
    }
  }

  _applyOpacityToGroup(group, opacity) {
    group.traverse((child) => {
      if (child.material) {
        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of materials) {
          if (mat.opacity !== undefined) {
            mat.transparent = true;
            mat.opacity = opacity;
            mat.needsUpdate = true;
          }
        }
      }
    });
  }

  destroy() {
    this.stopHapticPulse();
    this._stopCallTimer();
    this._stopVideo();
    this.viseme.dispose();
    this.thumbTap.dispose();
  }
}
