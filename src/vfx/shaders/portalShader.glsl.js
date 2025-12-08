/**
 * Portal Shader - Tech/Holographic style with scan lines and energy effects
 */

import { perlinNoise } from "./perlinNoise.glsl.js";

export const portalVertexShader = `
varying vec2 vUv;
varying vec3 vPosition;

void main() {
  vUv = uv;
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const portalFragmentShader = `
${perlinNoise}

uniform float uTime;
uniform float uRadius;
uniform float uProgress; // 0 = closed, 1 = fully open
uniform vec3 uPrimaryColor;
uniform vec3 uSecondaryColor;
uniform float uGlowIntensity;
uniform float uScanLineSpeed;

varying vec2 vUv;
varying vec3 vPosition;

#define PI 3.14159265359

void main() {
  vec2 center = vec2(0.5, 0.5);
  vec2 uv = vUv;
  
  // Distance from center (0 at center, 1 at edge)
  float dist = length(uv - center) * 2.0;
  
  // Animated radius based on progress
  float animatedRadius = uProgress;
  
  // Discard pixels outside the animated radius
  if (dist > animatedRadius) {
    discard;
  }
  
  // Normalized distance within the portal (0 at edge, 1 at center)
  float normDist = 1.0 - (dist / max(animatedRadius, 0.001));
  
  // === CORE DARKNESS ===
  // Deep black/blue core that fades toward center
  float coreDarkness = smoothstep(0.0, 0.6, normDist);
  vec3 coreColor = vec3(0.0, 0.02, 0.05) * coreDarkness;
  
  // === CONCENTRIC SCAN RINGS ===
  // Multiple rings moving inward
  float ringFreq = 12.0;
  float ringSpeed = uScanLineSpeed * 2.0;
  float rings = sin((dist * ringFreq - uTime * ringSpeed) * PI);
  rings = smoothstep(0.3, 1.0, rings);
  
  // Fade rings toward center and edge
  float ringMask = smoothstep(0.0, 0.3, normDist) * smoothstep(1.0, 0.7, normDist);
  rings *= ringMask * 0.6;
  
  // === GRID PATTERN ===
  // Hexagonal-ish tech grid
  float gridScale = 20.0;
  vec2 gridUv = (uv - center) * gridScale;
  
  // Rotate grid over time
  float gridAngle = uTime * 0.1;
  float cs = cos(gridAngle);
  float sn = sin(gridAngle);
  gridUv = vec2(gridUv.x * cs - gridUv.y * sn, gridUv.x * sn + gridUv.y * cs);
  
  // Create grid lines
  vec2 gridLines = abs(fract(gridUv) - 0.5);
  float grid = smoothstep(0.02, 0.05, min(gridLines.x, gridLines.y));
  grid = 1.0 - grid;
  
  // Fade grid toward center
  grid *= smoothstep(0.0, 0.5, normDist) * 0.3;
  
  // === ENERGY SWIRL ===
  // Rotating energy pattern using noise
  float angle = atan(uv.y - 0.5, uv.x - 0.5);
  float swirlSpeed = 1.5;
  float swirlAngle = angle + uTime * swirlSpeed + dist * 3.0;
  
  vec3 noisePos = vec3(cos(swirlAngle) * dist * 2.0, sin(swirlAngle) * dist * 2.0, uTime * 0.5);
  float swirl = cnoise(noisePos * 3.0) * 0.5 + 0.5;
  swirl *= smoothstep(1.0, 0.3, normDist) * 0.4;
  
  // === EDGE GLOW ===
  // Bright edge effect
  float edgeGlow = smoothstep(animatedRadius, animatedRadius - 0.15, dist);
  edgeGlow = 1.0 - edgeGlow;
  edgeGlow = pow(edgeGlow, 2.0) * uGlowIntensity;
  
  // Pulsing edge
  float pulse = sin(uTime * 4.0) * 0.3 + 0.7;
  edgeGlow *= pulse;
  
  // === DATA STREAMS ===
  // Radial lines streaming toward center
  float numStreams = 16.0;
  float streamAngle = fract(angle / (2.0 * PI) * numStreams);
  float stream = smoothstep(0.4, 0.5, streamAngle) * smoothstep(0.6, 0.5, streamAngle);
  
  // Animate streams inward
  float streamMove = fract(dist * 3.0 - uTime * 2.0);
  stream *= smoothstep(0.0, 0.3, streamMove) * smoothstep(1.0, 0.7, streamMove);
  stream *= smoothstep(0.2, 0.6, normDist) * 0.5;
  
  // === COMBINE EFFECTS ===
  vec3 color = coreColor;
  
  // Add grid (primary color)
  color += uPrimaryColor * grid;
  
  // Add rings (mix of colors)
  color += mix(uPrimaryColor, uSecondaryColor, 0.5) * rings;
  
  // Add swirl (secondary color)
  color += uSecondaryColor * swirl;
  
  // Add data streams (primary color)
  color += uPrimaryColor * stream;
  
  // Add edge glow (bright primary)
  color += uPrimaryColor * edgeGlow * 1.5;
  
  // === ALPHA ===
  // Solid in the middle, soft edge
  float alpha = smoothstep(animatedRadius, animatedRadius - 0.1, dist);
  
  // Boost alpha for edge glow
  alpha = max(alpha, edgeGlow * 0.8);
  
  // Apply opening animation
  alpha *= smoothstep(0.0, 0.1, uProgress);
  
  gl_FragColor = vec4(color, alpha);
}
`;

export default {
  vertexShader: portalVertexShader,
  fragmentShader: portalFragmentShader,
};

