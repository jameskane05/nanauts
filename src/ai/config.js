/**
 * config.js - AI SYSTEM CONFIGURATION AND CONSTANTS
 * =============================================================================
 *
 * ROLE: Central configuration for all AI-related settings including API URLs,
 * tracking parameters, depth encoding, and debug flags. Values can be overridden
 * via Vite environment variables for production builds.
 *
 * CONFIGURATION SECTIONS:
 * - API URLs: Endpoints for segmentation, 3D generation, transcription, interpretation
 * - Detection: TEXT_PROMPTS (object classes to detect), THRESHOLD (confidence cutoff)
 * - Tracking: Distance thresholds, confidence decay, smoothing factors
 * - Depth: Native depth scale/flip, server depth encoding (MiDaS parameters)
 * - Debug: Mid-air visualization toggle, verbose logging
 *
 * ENVIRONMENT VARIABLES:
 * - VITE_API_URL: Override /segment/json endpoint
 * - VITE_API_3D_URL: Override /generate3d endpoint
 * - VITE_API_VOICE_URL: Override /segment/voice endpoint
 * - VITE_API_TRANSCRIBE_URL: Override /transcribe endpoint
 * - VITE_API_INTERPRET_URL: Override /interpret endpoint
 * - VITE_OPENAI_API_KEY: OpenAI API key for speech-to-text (required, set in .env)
 * - VITE_AWS_REGION: AWS region for Bedrock (default: us-east-1)
 * - VITE_AWS_ACCESS_KEY_ID: AWS access key ID for Bedrock (required, set in .env)
 * - VITE_AWS_SECRET_ACCESS_KEY: AWS secret access key for Bedrock (required, set in .env)
 * - VITE_AWS_BEDROCK_MODEL_ID: Bedrock model ID (default: meta.llama3-3-70b-instruct-v1:0)
 *
 * DEPTH ENCODING (MiDaS DPT-Hybrid):
 * Server returns disparity map: 255 = near (0.25m), 0 = far (2.5m)
 * Set serverDepthInverted=true to decode correctly
 *
 * USAGE: Imported by other ai/ modules for configuration values
 * =============================================================================
 */

// API URL configuration
// Uses environment variables for production, falls back to localhost for development
function buildApiUrl(path) {
  const isLocalhost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const base = isLocalhost
    ? "https://localhost:8002"
    : `https://${window.location.hostname.split(":")[0]}:8002`;
  return `${base}${path}`;
}

export const API_URL =
  import.meta.env.VITE_API_URL || buildApiUrl("/segment/json");
export const API_3D_URL =
  import.meta.env.VITE_API_3D_URL || buildApiUrl("/generate3d");
export const API_VOICE_URL =
  import.meta.env.VITE_API_VOICE_URL || buildApiUrl("/segment/voice");
export const API_HEALTH_URL =
  import.meta.env.VITE_API_HEALTH_URL || buildApiUrl("/health");
export const API_TRANSCRIBE_URL =
  import.meta.env.VITE_API_TRANSCRIBE_URL || buildApiUrl("/transcribe");
export const API_INTERPRET_URL =
  import.meta.env.VITE_API_INTERPRET_URL || buildApiUrl("/interpret");

// Lambda Proxy configuration (for production - hides API keys server-side)
export const LAMBDA_PROXY_URL =
  import.meta.env.VITE_LAMBDA_PROXY_URL ||
  "https://ust3u26jq6yroaiubpqlcah3au0kxuct.lambda-url.us-east-1.on.aws";

// Use Lambda proxy in production (when not on localhost)
const isLocalDev =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
export const USE_LAMBDA_PROXY = !isLocalDev;

// OpenAI API configuration (only needed for local dev)
export const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY;
if (!OPENAI_API_KEY && isLocalDev) {
  console.warn(
    "VITE_OPENAI_API_KEY is not set. OpenAI transcription will not work in local dev."
  );
}
export const OPENAI_TRANSCRIBE_URL =
  "https://api.openai.com/v1/audio/transcriptions";

// AWS Bedrock configuration (only needed for local dev)
export const AWS_REGION = import.meta.env.VITE_AWS_REGION || "us-east-1";
export const AWS_BEDROCK_API_KEY = import.meta.env.VITE_AWS_BEDROCK_API_KEY;
export const AWS_BEDROCK_MODEL_ID =
  import.meta.env.VITE_AWS_BEDROCK_MODEL_ID ||
  "us.meta.llama3-3-70b-instruct-v1:0";

if (!AWS_BEDROCK_API_KEY && isLocalDev) {
  console.warn(
    "AWS Bedrock API key not set for local dev. Set VITE_AWS_BEDROCK_API_KEY in .env"
  );
}

// Multiple text prompts to search for in each frame
export const TEXT_PROMPTS = ["guitar", "book", "lamp"];
export const THRESHOLD = 0.5;

// Video mode configuration
export const ENABLE_VIDEO_MODE = false; // Set to true to enable SAM3 Video model tracking

export const IS_EMULATOR =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";
export const USE_TEST_IMAGE_IN_EMULATOR = false;

// Tracking parameters
export const TRACKING_CONFIG = {
  maxTrackingDistance: 1.0, // Max distance (meters) to match existing object
  confidenceDecayRate: 0.1, // Confidence decay per frame when not detected
  minConfidence: 0.1, // Minimum confidence to keep object
  maxConfidence: 1.0, // Maximum confidence cap
  positionSmoothing: 0.3, // Exponential smoothing factor (0-1, lower = more smoothing)
};

// Depth processing configuration
export const DEPTH_CONFIG = {
  // Native depth (hit test) scaling factor
  // 1.0 = use raw hit test depth as-is (recommended starting point)
  // Only adjust if native depth consistently over/under estimates
  nativeDepthScale: 1.0, // Multiplier for hit test distance (1.0 = no scaling)

  // Native depth Z flip - if blue wireframe is positioned incorrectly front/back
  nativeFlipZ: false, // Native Z is already correct (negative = in front of user)

  // Native depth Y flip - if blue wireframe is upside down or in the floor
  nativeFlipY: true, // Flip Y if native positions have inverted Y axis

  // Server depth map encoding (MiDaS DPT-Hybrid outputs disparity: 255=near, 0=far)
  serverDepthNear: 0.25, // Depth in meters for brightest pixel (255)
  serverDepthFar: 2.5, // Depth in meters for darkest pixel (0)
  serverDepthInverted: true, // true = 255 is near, false = 255 is far
};

// Debug visualization config
export const DEBUG_CONFIG = {
  // Show floating debug plane with depth visualizations in front of user
  showMidAirVisualization: false,
  // Enable verbose debug logging
  verboseLogging: true,
};
