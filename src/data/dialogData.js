/**
 * Dialog Data for IWSDK
 
 *
 * Each dialog contains:
 * - id: Unique identifier
 * - audio: Path to the audio file
 * - captions: Array of caption objects with:
 *   - text: The text to display
 *   - duration: How long to show (seconds)
 *   - startTime: (optional) Absolute start time in seconds
 * - criteria: Object with key-value pairs that must match gameState
 *   - Simple equality: { currentScreen: "xr_active" }
 *   - Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in
 * - once: If true, only play once (tracked automatically)
 * - priority: Higher priority dialogs checked first (default: 0)
 * - autoPlay: If true, automatically play when criteria match
 * - delay: Delay in seconds before playing (default: 0)
 * - playNext: Chain to another dialog ID after completion
 * - onComplete: Callback when dialog finishes
 *
 * Generated captions via /captions/generate endpoint with Whisper timestamps
 */

import { GAME_STATES } from "../gameState.js";
import { checkCriteria } from "../utils/CriteriaHelper.js";

export const dialogTracks = {
  // Intro dialog - plays after user presses A to enter XR
  intro: {
    id: "intro",
    audio: "./audio/dialog/00_intro.mp3",
    captions: [
      { text: "Greetings, Ambassador!", duration: 1.04 },
      {
        text: "Nanobots from a distant alien civilization",
        startTime: 1.64,
        duration: 2.16,
      },
      { text: "have begun exploring Earth.", startTime: 3.8, duration: 1.92 },
      { text: "Good news, they're friendly", startTime: 6.2, duration: 1.58 },
      {
        text: "and have advanced technology to offer.",
        startTime: 7.78,
        duration: 1.96,
      },
      { text: "The bad news...", startTime: 10.46, duration: 0.56 },
      { text: "they're... kind of annoying.", startTime: 11.8, duration: 1.08 },
      {
        text: "Nevertheless, to show Earth's goodwill to these bots,",
        startTime: 13.64,
        duration: 2.44,
      },
      {
        text: "you will help them understand our culture and way of life",
        startTime: 16.48,
        duration: 2.6,
      },
      {
        text: "by way of exploring your environment.",
        startTime: 19.08,
        duration: 2.1,
      },
    ],
    criteria: {
      currentState: GAME_STATES.PLAYING,
      introPlayed: { $ne: true },
    },
    once: true,
    autoPlay: true,
    priority: 100,
    delay: 1.0,
    onComplete: (gameState) => {
      gameState.setState({
        introPlayed: true,
        currentState: GAME_STATES.PORTAL_PLACEMENT,
      });
    },
  },

  // Portal placement instructions - plays when entering PORTAL_PLACEMENT state
  portalPlacement: {
    id: "portalPlacement",
    audio: "./audio/dialog/01_our-guests-are-ready-to-join-us-now.mp3",
    captions: [
      { text: "Our guests are ready to join us.", duration: 2.1 },
      {
        text: "Just set the coordinates in an open area on the floor.",
        startTime: 3.0,
        duration: 3.02,
      },
      { text: "They'll... find their way in.", startTime: 7.2, duration: 2.3 },
      { text: "Trans-dimensionally.", startTime: 9.76, duration: 0.7 },
    ],
    criteria: {
      currentState: GAME_STATES.PORTAL_PLACEMENT,
      portalPlacementPlayed: { $ne: true },
      roomSetupRequired: { $ne: true },
    },
    autoPlay: true,
    once: true,
    priority: 90,
    delay: 0.5,
    onComplete: (gameState) => {
      gameState.setState({ portalPlacementPlayed: true });
      // Play input-mode-specific helper only if portal placement hasn't started
      const state = gameState.getState();
      if (!state.portalPlacementStarted) {
        const dialogManager = state.world?.aiManager?.dialogManager;
        const helperId =
          state.inputMode === "hands"
            ? "portalPlacementHelperHands"
            : "portalPlacementHelperControllers";
        if (dialogManager) {
          dialogManager.playDialog(helperId);
        }
      }
    },
  },

  // Portal placement helper for hand tracking mode
  portalPlacementHelperHands: {
    id: "portalPlacementHelperHands",
    audio: "./audio/dialog/01a_hands_simply-point-make-a-thumbs-up.mp3",
    captions: [
      { text: "Simply point,", duration: 1.42 },
      { text: "make a thumbs up,", startTime: 1.98, duration: 1.08 },
      { text: "then tap your thumb.", startTime: 3.36, duration: 0.96 },
    ],
    autoPlay: false,
    once: true,
    priority: 89,
  },

  // Portal placement helper for controller mode
  portalPlacementHelperControllers: {
    id: "portalPlacementHelperControllers",
    audio: "./audio/dialog/01a_contr_simply-point-and-pull-the-trigger.mp3",
    captions: [{ text: "Simply point and pull the trigger.", duration: 2.66 }],
    autoPlay: false,
    once: true,
    priority: 89,
  },

  // Ambassador presentation - plays when robots have spawned and are gathered
  ambassadorPresentation: {
    id: "ambassadorPresentation",
    audio: "./audio/dialog/02_splendid-ambassador-may-i-present.mp3",
    captions: [
      { text: "Splendid!", startTime: 0.78, duration: 0.64 },
      { text: "Ambassador, may I present", startTime: 1.9, duration: 1.76 },
      { text: "Modem, Blit, and Baud.", startTime: 3.66, duration: 2.42 },
      { text: "The Nanaunts!", startTime: 6.74, duration: 0.7 },
      {
        text: "They'll start by taking a quick look around.",
        startTime: 8.18,
        duration: 2.54,
      },
    ],
    timedEvents: [
      {
        time: 3.66,
        type: "robotReaction",
        robotName: "Modem",
        reaction: "happyLoop",
      },
      {
        time: 4.5,
        type: "robotReaction",
        robotName: "Blit",
        reaction: "happyBarrel",
      },
      {
        time: 5.3,
        type: "robotReaction",
        robotName: "Baud",
        reaction: "happyBounce",
      },
    ],
    criteria: {
      robotsActive: true,
      robotBehavior: "gathered",
      ambassadorPresentationPlayed: { $ne: true },
    },
    autoPlay: true,
    once: true,
    priority: 85,
    delay: 1.0,
    onComplete: (gameState) => {
      gameState.setState({
        ambassadorPresentationPlayed: true,
        voiceInputEnabled: true,
        robotBehavior: "wandering",
      });
      // Play input-mode-specific translation app instructions
      const state = gameState.getState();
      const dialogManager = state.world?.aiManager?.dialogManager;
      const translationId =
        state.inputMode === "hands"
          ? "translationAppHands"
          : "translationAppControllers";
      if (dialogManager) {
        dialogManager.playDialog(translationId);
      }
    },
  },

  // Translation app instructions for controllers - plays after ambassador presentation
  translationAppControllers: {
    id: "translationAppControllers",
    audio: "./audio/dialog/03_contr_a-translation-app.mp3",
    captions: [
      { text: "A translation app has been", duration: 2.06 },
      { text: "uploaded to your Nanopad", startTime: 2.06, duration: 2.18 },
      {
        text: "You must press and hold A to record",
        startTime: 4.96,
        duration: 2.84,
      },
      {
        text: "then release to translate your",
        startTime: 8.22,
        duration: 2.44,
      },
      { text: "speech into their language.", startTime: 10.66, duration: 1.58 },
      { text: "Try it now!", startTime: 12.98, duration: 1.14 },
      { text: "Give these explorers", startTime: 14.62, duration: 1.42 },
      { text: "a nice, friendly greeting", startTime: 16.04, duration: 1.96 },
    ],
    autoPlay: false,
    once: true,
    priority: 84,
  },

  // Translation app instructions for hand tracking - plays after ambassador presentation
  translationAppHands: {
    id: "translationAppHands",
    audio: "./audio/dialog/03_hands_a-translation-app.mp3",
    captions: [
      {
        text: "A translation app has been uploaded to your NanoPad.",
        duration: 4.4,
      },
      {
        text: "Do another thumb tap to stop recording.",
        startTime: 4.88,
        duration: 2.78,
      },
      {
        text: "Tap again to stop recording and translate your speech",
        startTime: 8.24,
        duration: 4.28,
      },
      { text: "into their language.", startTime: 12.52, duration: 1.58 },
      { text: "Try it now!", startTime: 15.0, duration: 1.04 },
      {
        text: "Give these explorers a nice,",
        startTime: 16.62,
        duration: 2.22,
      },
      { text: "friendly greeting.", startTime: 19.14, duration: 0.86 },
    ],
    autoPlay: false,
    once: true,
    priority: 84,
  },

  // Greeting response - positive (user gave a friendly greeting)
  greetingPositive: {
    id: "greetingPositive",
    audio: "./audio/dialog/what-a-lovely-greeting.mp3",
    captions: [
      { text: "Ah! What a lovely greeting.", duration: 2.64 },
      { text: "They are most pleased.", startTime: 3.12, duration: 1.7 },
    ],
    criteria: {
      greetingResult: "positive",
    },
    autoPlay: true,
    once: true,
    priority: 80,
    playNext: "moreReadings",
    onComplete: (gameState) => {
      gameState.setState({
        greetingResult: null,
        robotBehavior: "wandering",
      });
    },
  },

  // Post-greeting instructions - robots need more readings
  moreReadings: {
    id: "moreReadings",
    audio: "./audio/dialog/06_they-need-to-take-a-few-more-readings.mp3",
    captions: [
      { text: "They need to take a few more readings,", duration: 2.48 },
      {
        text: "but they're a little overexcited, let's say.",
        startTime: 2.8,
        duration: 2.0,
      },
      { text: "If you see one panicking,", startTime: 5.2, duration: 1.5 },
      {
        text: "give them a little pat on the head for encouragement.",
        startTime: 7.0,
        duration: 2.5,
      },
    ],
    autoPlay: false,
    once: true,
    priority: 79,
    onComplete: (gameState) => {
      gameState.setState({ robotBehavior: "panicking" });
    },
  },

  // Greeting response - negative (didn't recognize as greeting)
  greetingNotRecognized: {
    id: "greetingNotRecognized",
    audio: "./audio/dialog/they-didnt-quite-recognize-that.mp3",
    captions: [
      { text: "They didn't quite recognize that", duration: 3.28 },
      { text: "as a friendly greeting.", startTime: 3.28, duration: 1.22 },
    ],
    criteria: {
      greetingResult: "negative",
    },
    autoPlay: true,
    once: false,
    priority: 79,
    onComplete: (gameState) => {
      gameState.setState({ greetingResult: null });
    },
  },

  // Per-robot question dialogs - triggered when robot is patted after being summoned
  robotQuestion_modem: {
    id: "robotQuestion_modem",
    audio: "./audio/dialog/question_modem.mp3",
    captions: [
      { text: "Modem has a question for you!", duration: 1.5 },
      {
        text: "What is this strange object you call... a 'door'?",
        startTime: 1.8,
        duration: 2.5,
      },
      {
        text: "Is it a portal to another dimension?",
        startTime: 4.5,
        duration: 2.0,
      },
    ],
    autoPlay: false,
    once: false,
    priority: 50,
  },

  robotQuestion_blit: {
    id: "robotQuestion_blit",
    audio: "./audio/dialog/question_blit.mp3",
    captions: [
      { text: "Blit seems curious...", duration: 1.5 },
      {
        text: "Why do humans sit on these soft rectangles?",
        startTime: 1.8,
        duration: 2.5,
      },
      {
        text: "Do they not have hover-pods?",
        startTime: 4.5,
        duration: 2.0,
      },
    ],
    autoPlay: false,
    once: false,
    priority: 50,
  },

  robotQuestion_baud: {
    id: "robotQuestion_baud",
    audio: "./audio/dialog/question_baud.mp3",
    captions: [
      { text: "Baud is excited to ask!", duration: 1.5 },
      {
        text: "What is this shiny surface that shows another you?",
        startTime: 1.8,
        duration: 2.5,
      },
      {
        text: "Is the other you friendly too?",
        startTime: 4.5,
        duration: 2.0,
      },
    ],
    autoPlay: false,
    once: false,
    priority: 50,
  },

  // Panic minigame call dialogs - quick fade-in, play, fade-out
  panicWorkedUp: {
    id: "panicWorkedUp",
    audio: "./audio/dialog/oh-no-theyre-a-little-worked-up.mp3",
    captions: [
      { text: "Oh no! They're a little worked up.", duration: 3.24 },
      {
        text: "Reassure them by connecting your hand to their antennae.",
        startTime: 3.76,
        duration: 3.48,
      },
    ],
    autoPlay: false,
    once: true,
    priority: 70,
  },
};

/**
 * Get dialogs that match current state and should auto-play
 * @param {Object} state - Current game state
 * @param {Set} playedDialogs - Set of dialog IDs already played
 * @returns {Array} Matching dialogs sorted by priority
 */
export function getDialogsForState(state, playedDialogs = new Set()) {
  const autoPlayDialogs = Object.values(dialogTracks).filter(
    (d) => d.autoPlay === true
  );

  // Sort by priority (descending)
  const sorted = autoPlayDialogs.sort(
    (a, b) => (b.priority || 0) - (a.priority || 0)
  );

  const matching = [];
  for (const dialog of sorted) {
    // Skip if once and already played
    if (dialog.once && playedDialogs.has(dialog.id)) continue;

    // Check criteria
    if (!dialog.criteria || checkCriteria(state, dialog.criteria)) {
      matching.push(dialog);
    }
  }

  return matching;
}

/**
 * Get dialog by ID
 * @param {string} id - Dialog ID
 * @returns {Object|null}
 */
export function getDialogById(id) {
  return dialogTracks[id] || null;
}

export default dialogTracks;
