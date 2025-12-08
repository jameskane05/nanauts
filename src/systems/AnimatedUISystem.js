import { createSystem, PanelUI, PanelDocument } from "@iwsdk/core";

/**
 * AnimatedUISystem - Provides ambient animations for spatial UI elements
 */
export class AnimatedUISystem extends createSystem(
  {
    animatedPanels: { required: [PanelUI, PanelDocument] },
  },
  {}
) {
  init() {
    this.animatedElements = new Map();
    this.pendingSetups = new Map(); // entityIndex -> { attempts: number }
    this.startTime = performance.now();
    this._frameCounter = 0;

    this.queries.animatedPanels.subscribe("qualify", (entity) => {
      // Queue for setup - will be processed in update()
      this.pendingSetups.set(entity.index, { attempts: 0, entity });
    });

    this.queries.animatedPanels.subscribe("disqualify", (entity) => {
      this.animatedElements.delete(entity.index);
      this.pendingSetups.delete(entity.index);
    });
  }

  _trySetupEntity(entityIndex, entity) {
    const doc = PanelDocument?.data?.document?.[entityIndex];

    if (!doc) {
      return false; // Not ready yet
    }

    // Use getElementsByClassName which is more reliable
    const statusDots = doc.getElementsByClassName?.("status-indicator") || [];
    const dividerDots = doc.getElementsByClassName?.("divider-dot") || [];
    const meterSegments = doc.getElementsByClassName?.("meter-active") || [];

    this.animatedElements.set(entityIndex, {
      statusDots: Array.from(statusDots),
      dividerDots: Array.from(dividerDots),
      meterSegments: Array.from(meterSegments),
      doc,
    });

    return true; // Setup complete
  }

  update(delta, time) {
    // Process pending setups (frame-based polling instead of setTimeout)
    for (const [entityIndex, pending] of this.pendingSetups) {
      pending.attempts++;
      if (this._trySetupEntity(entityIndex, pending.entity)) {
        this.pendingSetups.delete(entityIndex);
      } else if (pending.attempts > 300) {
        this.pendingSetups.delete(entityIndex);
      }
    }

    // Rate limit animations to ~24fps - visual pulses don't need 72Hz updates
    this._frameCounter++;
    if (this._frameCounter % 3 !== 0) return;

    const now = performance.now();
    const elapsed = (now - this.startTime) / 1000;

    for (const [entityIndex, data] of this.animatedElements) {
      // Animate status indicators - opacity pulse only (no size change to prevent layout shift)
      for (const dot of data.statusDots) {
        if (dot?.setProperties) {
          const pulse = 0.3 + 0.7 * Math.abs(Math.sin(elapsed * 2));
          dot.setProperties({
            opacity: pulse,
          });
        }
      }

      // Animate divider dots - dramatic color cycle coral <-> cyan
      for (const dot of data.dividerDots) {
        if (dot?.setProperties) {
          const cycle = (Math.sin(elapsed * 1.5) + 1) / 2;
          // coral (255, 100, 80) <-> cyan (0, 255, 255)
          const r = Math.round(255 * (1 - cycle));
          const g = Math.round(100 + 155 * cycle);
          const b = Math.round(80 + 175 * cycle);
          const size = 0.14 + 0.06 * Math.sin(elapsed * 3);
          dot.setProperties({
            backgroundColor: `rgba(${r}, ${g}, ${b}, 1.0)`,
            width: size,
            height: size,
          });
        }
      }

      // Animate meter segments - wave effect
      for (let i = 0; i < data.meterSegments.length; i++) {
        const segment = data.meterSegments[i];
        if (segment?.setProperties) {
          const phase = elapsed * 3 + i * 0.5;
          const brightness = 0.3 + 0.7 * Math.abs(Math.sin(phase));
          segment.setProperties({
            backgroundColor: `rgba(0, ${Math.round(
              220 * brightness
            )}, ${Math.round(255 * brightness)}, 1.0)`,
          });
        }
      }
    }
  }
}
