import { createSystem } from "@iwsdk/core";

export class StatsSystem extends createSystem({}, {}) {
  init() {
    // Stats object is stored on window by index.js
    this.frameTimes = {};
    this.frameCount = 0;
    this.lastLogTime = 0;
    
    // Expose timing helper globally
    window.systemTiming = {
      start: (name) => {
        this.frameTimes[name] = performance.now();
      },
      end: (name) => {
        if (this.frameTimes[name]) {
          const elapsed = performance.now() - this.frameTimes[name];
          if (!this.frameTimes[name + '_total']) {
            this.frameTimes[name + '_total'] = 0;
            this.frameTimes[name + '_count'] = 0;
          }
          this.frameTimes[name + '_total'] += elapsed;
          this.frameTimes[name + '_count']++;
        }
      },
      log: () => this.logTimings()
    };
  }

  logTimings() {
    console.log("=== System Timing Report ===");
    const systems = ['AIManager', 'HandInput', 'SemanticLabels', 'GameState', 'Audio'];
    for (const name of systems) {
      const total = this.frameTimes[name + '_total'] || 0;
      const count = this.frameTimes[name + '_count'] || 0;
      if (count > 0) {
        const avg = (total / count).toFixed(2);
        console.log(`${name}: ${avg}ms avg (${count} frames, ${total.toFixed(0)}ms total)`);
      }
    }
  }

  update(delta, time) {
    if (window.stats) {
      window.stats.update();
    }
    
    // Log every 5 seconds
    this.frameCount++;
    if (time - this.lastLogTime > 5) {
      this.logTimings();
      this.lastLogTime = time;
    }
  }
}

