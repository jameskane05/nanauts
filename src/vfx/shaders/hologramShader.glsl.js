/**
 * Hologram Shader - Lightweight sci-fi holographic effect
 * Optimized for mobile/VR: single texture sample, no per-fragment random
 */

export const hologramVertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const hologramFragmentShader = `
uniform sampler2D uTexture;
uniform float uTime;
uniform vec3 uHoloColor;
uniform float uScanLineIntensity;
uniform float uAlpha;
uniform vec2 uUvOffset;
uniform vec2 uUvRepeat;

varying vec2 vUv;

void main() {
  // === SAMPLE TEXTURE with sprite sheet UV mapping ===
  vec2 spriteUv = vUv * uUvRepeat + uUvOffset;
  vec4 texColor = texture2D(uTexture, spriteUv);
  
  // === SCAN LINES ===
  // Fast scanline using fract instead of sin
  float scanY = vUv.y * 60.0 + uTime * 3.0;
  float scanLine = fract(scanY);
  scanLine = smoothstep(0.0, 0.5, scanLine) * smoothstep(1.0, 0.5, scanLine);
  float scanEffect = mix(1.0, 0.7 + scanLine * 0.3, uScanLineIntensity);
  
  // === HOLOGRAPHIC TINT ===
  vec3 holoTint = texColor.rgb * uHoloColor * 1.3;
  holoTint *= scanEffect;
  
  // === EDGE GLOW (UV-based, no fresnel calc needed for flat plane) ===
  float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  float edgeGlow = smoothstep(0.0, 0.15, edgeDist);
  holoTint += uHoloColor * (1.0 - edgeGlow) * 0.3;
  
  // === ALPHA ===
  float alpha = texColor.a * uAlpha * scanEffect;
  
  gl_FragColor = vec4(holoTint, alpha);
}
`;

export default {
  vertexShader: hologramVertexShader,
  fragmentShader: hologramFragmentShader,
};

