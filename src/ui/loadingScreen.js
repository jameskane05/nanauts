/**
 * LoadingScreen.js - ASSET LOADING PROGRESS OVERLAY
 * =============================================================================
 *
 * ROLE: HTML overlay showing loading progress before XR session starts.
 * Tracks multiple loading tasks and displays aggregate progress bar.
 *
 * KEY RESPONSIBILITIES:
 * - Create DOM overlay with progress bar and status text
 * - Track multiple named loading tasks (world, systems, assets)
 * - Calculate and display aggregate progress percentage
 * - Auto-hide when all tasks complete
 * - Fire onComplete callback when loading finishes
 *
 * TASK TRACKING:
 * - registerTask(name): Add a new loading task
 * - updateTask(name, progress): Update task progress (0-1)
 * - completeTask(name): Mark task as 100% complete
 *
 * USAGE: Instantiated by index.js before world creation.
 * Tasks registered for world, systems, assets, etc.
 * Hides automatically when all tasks reach 100%.
 * =============================================================================
 */

import { GAME_STATES, gameState } from "../gameState.js";
import { Logger } from "../utils/Logger.js";

export class LoadingScreen {
  constructor(options = {}) {
    this.logger = new Logger("LoadingScreen", false);
    this.container = null;
    this.progressBar = null;
    this.progressText = null;
    this.loadingTasks = new Map(); // task name -> { progress: number } (0-1)
    this.isVisible = true;
    this.isComplete = false;
    this.onComplete = options.onComplete || null;

    this.createUI();
  }

  createUI() {
    // Create container
    this.container = document.createElement("div");
    this.container.id = "loading-screen";
    this.container.className = "loading-screen";

    // Create content wrapper
    const content = document.createElement("div");
    content.className = "loading-content";

    // Create loading title
    const title = document.createElement("div");
    title.className = "loading-title";
    title.textContent = "LOADING";
    content.appendChild(title);

    // Create progress bar container
    const progressContainer = document.createElement("div");
    progressContainer.className = "loading-progress-container";

    // Create progress bar fill
    this.progressBar = document.createElement("div");
    this.progressBar.className = "loading-progress-bar";
    this.progressBar.style.width = "0%";
    progressContainer.appendChild(this.progressBar);

    content.appendChild(progressContainer);

    // Create progress text
    this.progressText = document.createElement("div");
    this.progressText.className = "loading-progress-text";
    this.progressText.textContent = "0%";
    content.appendChild(this.progressText);

    // Assemble UI
    this.container.appendChild(content);

    // Add to document
    document.body.appendChild(this.container);
  }

  /**
   * Register a loading task
   * @param {string} taskName - Unique name for the task
   */
  registerTask(taskName) {
    this.loadingTasks.set(taskName, { progress: 0 });
    this.updateProgress();
  }

  /**
   * Update progress for a specific task
   * @param {string} taskName - Name of the task
   * @param {number} progress - Progress value (0-1)
   */
  updateTask(taskName, progress) {
    const task = this.loadingTasks.get(taskName);
    if (task) {
      task.progress = Math.max(0, Math.min(1, progress));
      this.updateProgress();
    }
  }

  /**
   * Mark a task as complete
   * @param {string} taskName - Name of the task
   */
  completeTask(taskName) {
    const task = this.loadingTasks.get(taskName);
    if (task) {
      task.progress = 1;
      this.updateProgress();
    }
  }

  /**
   * Calculate and update overall progress
   */
  updateProgress() {
    if (this.loadingTasks.size === 0) {
      return;
    }

    let totalProgress = 0;
    let allTasksComplete = true;

    for (const task of this.loadingTasks.values()) {
      totalProgress += task.progress;
      if (task.progress < 1) {
        allTasksComplete = false;
      }
    }

    const averageProgress = totalProgress / this.loadingTasks.size;
    const progressPercent = averageProgress * 100;

    // Update UI
    if (this.progressBar) {
      this.progressBar.style.width = `${progressPercent}%`;
    }
    if (this.progressText) {
      this.progressText.textContent = `${Math.round(progressPercent)}%`;
    }

    // Update game state
    gameState.setState({ loadingProgress: averageProgress });

    // Check if all tasks are complete
    if (allTasksComplete && !this.isComplete) {
      this.isComplete = true;
      this.handleLoadingComplete();
    }
  }

  /**
   * Handle loading completion - hide screen and transition state
   */
  handleLoadingComplete() {
    this.logger.log("All tasks complete");

    const fadeDuration = 0.5;
    this.hide(fadeDuration);

    // Transition to START_SCREEN state
    gameState.setState({ currentState: GAME_STATES.START_SCREEN });

    // Call completion callback if provided
    if (this.onComplete) {
      setTimeout(() => {
        this.onComplete();
      }, fadeDuration * 1000);
    }
  }

  /**
   * Hide the loading screen with fade-out
   * @param {number} duration - Fade duration in seconds
   */
  hide(duration = 0.5) {
    if (!this.isVisible || !this.container) return;

    this.isVisible = false;
    this.container.style.transition = `opacity ${duration}s ease-out`;
    this.container.style.opacity = "0";

    // Remove from DOM after fade
    setTimeout(() => {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.removeChild(this.container);
      }
    }, duration * 1000);
  }

  /**
   * Show the loading screen
   */
  show() {
    if (this.container) {
      this.container.style.opacity = "1";
      this.isVisible = true;
    }
  }

  /**
   * Check if loading is complete
   */
  isLoadingComplete() {
    return this.isComplete;
  }

  /**
   * Get current progress (0-100)
   */
  getProgress() {
    if (this.loadingTasks.size === 0) {
      return 0;
    }

    let totalProgress = 0;
    for (const task of this.loadingTasks.values()) {
      totalProgress += task.progress;
    }

    return (totalProgress / this.loadingTasks.size) * 100;
  }
}
