/**
 * Robot Character Definitions
 *
 * Each robot has unique voice characteristics, personality traits,
 * and behavioral tendencies that affect their interactions.
 */

export const VOICE_TYPES = {
  STANDARD: "standard",
  MODEM: "modem",
};

export const ROBOT_CHARACTERS = {
  MODEM: {
    id: "modem",
    name: "Modem",
    modelUrl: "./gltf/modem.glb",
    voiceType: VOICE_TYPES.MODEM,
    pitchOffset: 0,

    personality: {
      curiosity: 0.9,
      friendliness: 0.7,
      energy: 0.6,
      chattiness: 0.8,
      patience: 0.5,
    },

    behavior: {
      scanFrequency: 1.2,
      wanderRadius: 1.0,
      groupAffinity: 0.6,
      playerAttention: 0.8,
    },

    physics: {
      maxSpeed: 0.7,
      maxAcceleration: 8.0,
      agentRadius: 0.1,
      turnSpeedMultiplier: 1.0,
      jumpDurationMultiplier: 1.2, // Default jump speed
    },

    appearance: {
      primaryColor: 0xcc6600,
      accentColor: 0xe08040,
      glowIntensity: 1.0,
      nameTagHeight: 0.4,
      thrusterSize: 0.6,
      thrusterYOffset: 0.1,
      thrusterMaxScale: 1.0,
      heightOffset: 0.075,
      shadowSize: 0.35,
    },

    animationScale: 1.0,
  },

  BLIT: {
    id: "blit",
    name: "Blit",
    modelUrl: "./gltf/blit.glb",
    voiceType: VOICE_TYPES.STANDARD,
    pitchOffset: 12, // Higher, nasal

    personality: {
      curiosity: 0.5,
      friendliness: 0.8,
      energy: 0.4,
      chattiness: 0.5,
      patience: 0.9,
    },

    behavior: {
      scanFrequency: 0.7,
      wanderRadius: 0.8,
      groupAffinity: 0.8,
      playerAttention: 0.6,
    },

    physics: {
      maxSpeed: 1,
      maxAcceleration: 10.0,
      agentRadius: 0.1,
      turnSpeedMultiplier: 0.5, // Heavy dampening to prevent whip
      jumpDurationMultiplier: 1.0, // Faster, snappier jumps
    },

    appearance: {
      primaryColor: 0x8844ff,
      accentColor: 0xaa66ff,
      glowIntensity: 0.8,
      nameTagHeight: 0.58,
      thrusterSize: 0.45,
      thrusterYOffset: 0,
      thrusterMaxScale: 1.0,
      heightOffset: 0.075,
      shadowSize: 0.25,
    },

    animationScale: 0.25,
  },

  BAUD: {
    id: "baud",
    name: "Baud",
    modelUrl: "./gltf/baud.glb",
    voiceType: VOICE_TYPES.STANDARD,
    pitchOffset: -12, // Lower, grumbly

    personality: {
      curiosity: 0.7,
      friendliness: 0.9,
      energy: 0.9,
      chattiness: 0.9,
      patience: 0.3,
    },

    behavior: {
      scanFrequency: 1.0,
      wanderRadius: 1.3,
      groupAffinity: 0.4,
      playerAttention: 0.9,
    },

    physics: {
      maxSpeed: 0.9,
      maxAcceleration: 6.0,
      agentRadius: 0.18, // Bigger collision radius
      turnSpeedMultiplier: 0.6, // Slower rotation
      jumpDurationMultiplier: 1.4, // Slower, heavier jumps
    },

    appearance: {
      primaryColor: 0x20b2aa,
      accentColor: 0x40d0d0,
      glowIntensity: 1.2,
      nameTagHeight: 0.63,
      thrusterSize: 1.1,
      thrusterYOffset: 0.1,
      thrusterMaxScale: 1.0,
      heightOffset: 0.075,
      shadowSize: 0.45,
    },

    animationScale: 1.0,
  },
};

// Helper to get character by index (for spawning)
export function getCharacterByIndex(index) {
  const chars = Object.values(ROBOT_CHARACTERS);
  return chars[index % chars.length];
}

// Helper to get character by ID
export function getCharacterById(id) {
  return (
    Object.values(ROBOT_CHARACTERS).find((c) => c.id === id) ||
    ROBOT_CHARACTERS.MODEM
  );
}

// Get all character IDs
export function getAllCharacterIds() {
  return Object.values(ROBOT_CHARACTERS).map((c) => c.id);
}
