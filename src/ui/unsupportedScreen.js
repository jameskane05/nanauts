/**
 * UnsupportedScreen.js - NON-QUEST PLATFORM BLOCKING SCREEN
 * =============================================================================
 *
 * ROLE: HTML overlay that blocks non-Quest platforms with a friendly message
 * explaining that the experience requires Meta Quest hardware.
 *
 * KEY RESPONSIBILITIES:
 * - Create blocking overlay with VR headset icon
 * - Display instructions for accessing on Quest
 * - Prevent any interaction with underlying content
 *
 * DETECTION:
 * Platform check performed by index.js before showing this screen.
 * If not Quest, this screen is shown and XR entry is blocked.
 *
 * CONTENT:
 * - VR headset SVG icon
 * - "Meta Quest Required" title
 * - Instructions for opening in Quest browser
 *
 * USAGE: Instantiated by index.js, shown when platform check fails
 * =============================================================================
 */

import { GAME_STATES, gameState } from "../gameState.js";

export class UnsupportedScreen {
  constructor() {
    this.container = null;
    this.createUI();
  }

  createUI() {
    // Create container
    this.container = document.createElement("div");
    this.container.id = "unsupported-screen";
    this.container.className = "unsupported-screen";

    // Create content wrapper
    const content = document.createElement("div");
    content.className = "unsupported-content";

    // Create icon (VR headset emoji or SVG)
    const icon = document.createElement("div");
    icon.className = "unsupported-icon";
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" width="80" height="80" fill="currentColor">
        <path d="M20.5 6h-17A1.5 1.5 0 0 0 2 7.5v9A1.5 1.5 0 0 0 3.5 18h4.09a1.5 1.5 0 0 0 1.34-.83l1.17-2.34a1.5 1.5 0 0 1 1.34-.83h1.12a1.5 1.5 0 0 1 1.34.83l1.17 2.34a1.5 1.5 0 0 0 1.34.83h4.09a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 20.5 6zm-13 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm9 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
      </svg>
    `;
    content.appendChild(icon);

    // Create title
    const title = document.createElement("h1");
    title.className = "unsupported-title";
    title.textContent = "Meta Quest Required";
    content.appendChild(title);

    // Create message
    const message = document.createElement("p");
    message.className = "unsupported-message";
    message.textContent =
      "This experience is designed for Meta Quest headsets. Please open this page in your Quest browser to continue.";
    content.appendChild(message);

    // Create secondary message with instructions
    const instructions = document.createElement("p");
    instructions.className = "unsupported-instructions";
    instructions.innerHTML = `
      <strong>How to access:</strong><br>
      1. Put on your Meta Quest headset<br>
      2. Open the Quest Browser<br>
      3. Navigate to this URL
    `;
    content.appendChild(instructions);

    // Assemble UI
    this.container.appendChild(content);

    // Update game state
    gameState.setState({ currentState: GAME_STATES.UNSUPPORTED_PLATFORM });

    // Add to document
    document.body.appendChild(this.container);
  }

  /**
   * Show the unsupported screen
   */
  show() {
    if (this.container) {
      this.container.style.display = "flex";
    }
  }

  /**
   * Hide the unsupported screen (normally never called)
   */
  hide() {
    if (this.container) {
      this.container.style.display = "none";
    }
  }
}
