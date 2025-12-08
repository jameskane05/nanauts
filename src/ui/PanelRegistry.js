/**
 * PanelRegistry.js - PANEL CREATION AND DOCUMENT LIFECYCLE
 * =============================================================================
 *
 * Generic panel creation and document management. Handles PanelUI component
 * creation, async document polling, mount-specific sizing, and panel reparenting.
 *
 * RESPONSIBILITIES:
 * - Create panels with PanelUI component
 * - Poll for document readiness (async)
 * - Apply mount-specific sizing via setTargetDimensions
 * - Reparent panels between mounts with smooth transitions
 * - Enforce render settings so UI always renders on top of 3D scene elements
 * =============================================================================
 */

import { PanelUI, PanelDocument, Group } from "@iwsdk/core";
import { Vector3 } from "three";
import { Logger } from "../utils/Logger.js";
import { ATTACHMENT_MODE } from "./SpatialMountManager.js";

// Panel definitions: where each panel lives and its config
export const PANEL_DEFS = {
  call: {
    config: "./ui/wrist/callPanel.json",
    mount: ATTACHMENT_MODE.HUD,
  },
  callWorld: {
    config: "./ui/wrist/worldCallPanel.json",
    mount: ATTACHMENT_MODE.WORLD,
    maxWidth: 1.0,
    maxHeight: 1.0,
  },
  voice: {
    config: "./ui/wrist/translator.json",
    mount: ATTACHMENT_MODE.WRIST,
  },
  score: {
    config: "./ui/wrist/scorePanel.json",
    mount: ATTACHMENT_MODE.SCORE,
  },
};

export class PanelRegistry {
  constructor(world, mountManager, options = {}) {
    this.world = world;
    this.mountManager = mountManager;
    this.logger = new Logger("PanelRegistry", options.debug ?? false);

    this.panels = {};
    this.documents = {};
    this._pendingDocuments = new Map();
    this._panelTransitions = {};
    this._fadeAnimations = {}; // { panelKey: { current, target, speed } }

    // Panel sizing config - height higher to allow natural aspect ratio
    this.panelMaxWidth = 0.18;
    this.panelMaxHeight = 0.3;

    this._mountSizeMultipliers = {
      [ATTACHMENT_MODE.CENTER]: 1.25,
      [ATTACHMENT_MODE.HUD]: 0.7,
      [ATTACHMENT_MODE.WRIST]: 1.0,
      [ATTACHMENT_MODE.WORLD]: 1.0, // Scale handled separately via Three.js
    };
  }

  async createPanel(panelKey, mountMode = null) {
    if (this.panels[panelKey]) return this.panels[panelKey];

    const def = PANEL_DEFS[panelKey];
    if (!def) {
      this.logger.warn(`No definition for panel: ${panelKey}`);
      return null;
    }

    const config = def.config;
    const targetMount = mountMode || def.mount;

    // Use panel-specific size overrides if defined
    const maxWidth = def.maxWidth ?? this.panelMaxWidth;
    const maxHeight = def.maxHeight ?? this.panelMaxHeight;

    const entity = this.world.createEntity();
    const group = new Group();
    group.name = `spatialUI-${panelKey}`;
    entity.object3D = group;

    const mountGroup = this.mountManager.getMountGroup(targetMount);
    mountGroup.add(group);

    entity.addComponent(PanelUI, {
      config,
      maxWidth,
      maxHeight,
    });

    group.frustumCulled = false;
    group.visible = false;

    this.panels[panelKey] = { entity, group, currentMount: targetMount };
    this.logger.log(`Created panel: ${panelKey}`);

    await this._waitForDocument(panelKey, entity);

    group.traverse((child) => {
      child.frustumCulled = false;
      child.layers.enableAll();
      // Set render order very high and disable depth test so UI always renders on top
      // Don't overwrite higher values (viseme is at 9010)
      if (child.isMesh && child.renderOrder < 9000) {
        child.renderOrder = 9000;
        if (child.material) {
          child.material.depthTest = false;
          child.material.depthWrite = false;
        }
      }
    });

    return this.panels[panelKey];
  }

  async _waitForDocument(panelKey, entity) {
    return new Promise((resolve) => {
      this._pendingDocuments.set(panelKey, {
        entity,
        attempts: 0,
        maxAttempts: 300,
        resolve,
      });
    });
  }

  pollPendingDocuments(onDocumentReady = null) {
    if (this._pendingDocuments.size === 0) return;

    for (const [panelKey, pending] of this._pendingDocuments) {
      pending.attempts++;
      const doc = PanelDocument?.data?.document?.[pending.entity.index];

      if (doc) {
        this.documents[panelKey] = doc;
        const panel = this.panels[panelKey];
        if (panel) {
          this.applyMountSizing(panelKey, panel.currentMount);
          // Enforce render settings now that UIKit has created all meshes
          this._enforceUIRenderSettingsForPanel(panel);
        }
        this.logger.log(
          `Panel ${panelKey} document ready after ${pending.attempts} frames`
        );
        this._pendingDocuments.delete(panelKey);
        pending.resolve();
        if (onDocumentReady) onDocumentReady(panelKey, doc);
      } else if (pending.attempts >= pending.maxAttempts) {
        this.logger.warn(`Panel ${panelKey} document timeout`);
        this._pendingDocuments.delete(panelKey);
        pending.resolve();
      }
    }
  }

  getDocument(panelKey) {
    return this.documents[panelKey];
  }

  getPanel(panelKey) {
    return this.panels[panelKey];
  }

  applyMountSizing(panelKey, mountMode) {
    const doc = this.documents[panelKey];
    if (!doc) return;

    const multiplier = this._mountSizeMultipliers[mountMode] ?? 1.0;
    const targetWidth = this.panelMaxWidth * multiplier;
    const targetHeight = this.panelMaxHeight * multiplier;

    doc.setTargetDimensions(targetWidth, targetHeight);
    this.logger.log(
      `Panel ${panelKey} sized for ${mountMode}: ${targetWidth.toFixed(
        3
      )}m x ${targetHeight.toFixed(3)}m`
    );
  }

  reparentPanel(panelKey, newMount) {
    const panel = this.panels[panelKey];
    if (!panel) return;

    // Force-update the destination mount's position before reparenting
    // This ensures we calculate the correct offset for smooth transitions
    this.mountManager.forceUpdateMountPosition(newMount);

    const newMountGroup = this.mountManager.getMountGroup(newMount);
    const currentParent = panel.group.parent;

    this.applyMountSizing(panelKey, newMount);
    panel.currentMount = newMount;

    if (currentParent && currentParent !== newMountGroup) {
      panel.group.updateMatrixWorld(true);
      const worldPos = new Vector3();
      panel.group.getWorldPosition(worldPos);

      currentParent.remove(panel.group);
      newMountGroup.add(panel.group);

      newMountGroup.updateMatrixWorld(true);
      const newMountWorldPos = new Vector3();
      newMountGroup.getWorldPosition(newMountWorldPos);

      panel.group.position.copy(worldPos).sub(newMountWorldPos);

      this._panelTransitions[panelKey] = {
        startOffset: panel.group.position.clone(),
        progress: 0,
      };

      this.logger.log(`Reparented ${panelKey} panel to ${newMount}`);
    }
  }

  updatePanelTransitions() {
    const lerpSpeed = 0.08;

    for (const [key, transition] of Object.entries(this._panelTransitions)) {
      transition.progress += lerpSpeed;

      const target = this.panels[key]?.group;

      if (target) {
        target.position.lerp(new Vector3(0, 0, 0), lerpSpeed);

        if (target.position.length() < 0.001) {
          target.position.set(0, 0, 0);
          delete this._panelTransitions[key];
        }
      }
    }
  }

  _enforceUIRenderSettingsForPanel(panel) {
    if (!panel?.group) return;

    panel.group.traverse((child) => {
      if (child.isMesh && child.renderOrder < 9000) {
        child.renderOrder = 9000;
        if (child.material) {
          child.material.depthTest = false;
          child.material.depthWrite = false;
        }
      }
    });
  }

  setPanelVisible(panelKey, visible, fadeOutDuration = 0) {
    const panel = this.panels[panelKey];
    if (!panel) return;

    if (visible) {
      // Show immediately, reset opacity
      panel.group.visible = true;
      this._applyOpacityToGroup(panel.group, 1);
      delete this._fadeAnimations[panelKey];
    } else {
      // Hide: fade out if duration specified, otherwise immediate
      if (fadeOutDuration > 0) {
        this.fadePanel(panelKey, 0, fadeOutDuration);
      } else {
        panel.group.visible = false;
      }
    }
  }

  fadePanel(panelKey, targetOpacity, duration = 1.0) {
    const panel = this.panels[panelKey];
    if (!panel) return;

    const currentOpacity =
      this._fadeAnimations[panelKey]?.current ?? (panel.group.visible ? 1 : 0);

    // Make visible if fading in
    if (targetOpacity > 0) {
      panel.group.visible = true;
    }

    this._fadeAnimations[panelKey] = {
      current: currentOpacity,
      target: targetOpacity,
      speed: 1 / duration,
    };

    this.logger.log(
      `Fade ${panelKey}: ${currentOpacity.toFixed(
        2
      )} -> ${targetOpacity} over ${duration}s`
    );
  }

  fadeInPanel(panelKey, duration = 1.0) {
    const panel = this.panels[panelKey];
    if (!panel) return;

    // Start from 0, fade to 1
    panel.group.visible = true;
    this._applyOpacityToGroup(panel.group, 0);

    this._fadeAnimations[panelKey] = {
      current: 0,
      target: 1,
      speed: 1 / duration,
    };

    this.logger.log(`FadeIn ${panelKey}: 0 -> 1 over ${duration}s`);
  }

  updateFadeAnimations(dt) {
    for (const [panelKey, fade] of Object.entries(this._fadeAnimations)) {
      const panel = this.panels[panelKey];
      if (!panel) {
        delete this._fadeAnimations[panelKey];
        continue;
      }

      const delta = dt || 1 / 60;
      const step = fade.speed * delta;

      if (fade.current < fade.target) {
        fade.current = Math.min(fade.target, fade.current + step);
      } else {
        fade.current = Math.max(fade.target, fade.current - step);
      }

      this._applyOpacityToGroup(panel.group, fade.current);

      // Hide when fully faded out
      if (fade.current <= 0.001) {
        panel.group.visible = false;
        delete this._fadeAnimations[panelKey];
      } else if (Math.abs(fade.current - fade.target) < 0.001) {
        delete this._fadeAnimations[panelKey];
      }
    }
  }

  enforceRenderSettingsForVisiblePanels() {
    for (const [panelKey, panel] of Object.entries(this.panels)) {
      if (panel?.group?.visible) {
        this._enforceUIRenderSettingsForPanel(panel);
      }
    }
  }

  _applyOpacityToGroup(group, opacity) {
    group.traverse((child) => {
      if (child.material) {
        child.material.transparent = true;
        child.material.opacity = opacity;
        child.material.needsUpdate = true;
      }
    });
  }

  isFading(panelKey) {
    return !!this._fadeAnimations[panelKey];
  }

  forceVisibilityRefresh(panelKey) {
    const panel = this.panels[panelKey];
    if (!panel) return;

    const group = panel.group;
    const targetMount = this.mountManager.getMountGroup(panel.currentMount);

    const setupMesh = (child) => {
      child.frustumCulled = false;
      child.layers.enableAll();
      // Don't overwrite higher values (viseme is at 9010)
      if (child.isMesh && child.renderOrder < 9000) {
        child.renderOrder = 9000;
        if (child.material) {
          child.material.depthTest = false;
          child.material.depthWrite = false;
          child.material.needsUpdate = true;
        }
      }
    };

    group.traverse(setupMesh);
    targetMount.traverse(setupMesh);
    targetMount.updateMatrixWorld(true);

    this.logger.log(`Panel ${panelKey} refreshed`);
  }

  destroy() {
    for (const key in this.panels) {
      const { entity, group } = this.panels[key];
      if (group.parent) group.parent.remove(group);
      if (entity && this.world) this.world.removeEntity(entity);
    }

    this.panels = {};
    this.documents = {};
    this._pendingDocuments.clear();
  }
}
