/**
 * Starfield.js - PROCEDURAL STARFIELD BACKGROUND EFFECT
 * =============================================================================
 *
 * ROLE: Creates a multi-layered particle-based starfield effect for the
 * background of the start screen. Uses Three.js Points with glow textures.
 *
 * KEY RESPONSIBILITIES:
 * - Generate procedural star positions in hemisphere distribution
 * - Create glow texture for soft star appearance
 * - Multiple layers: base stars + sparkle overlay
 * - Animate star twinkle via opacity modulation
 * - Dispose resources on cleanup
 *
 * VISUAL DESIGN:
 * - Stars distributed in hemisphere (mostly in front of viewer)
 * - Warm color tint (slight yellow/orange)
 * - Sparkle layer with larger, more prominent stars
 * - Depth-based size attenuation
 *
 * EXPORTS:
 * - createStarfield(scene, options): Creates and returns starfield group
 * - Returns: { group, update(dt), dispose() }
 *
 * USAGE: Called by index.js for start screen background
 * =============================================================================
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  PointsMaterial,
  Color,
  CanvasTexture,
  TextureLoader,
  Group,
} from "three";
import { Logger } from "../utils/Logger.js";

function createGlowTexture(size = 64) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  const center = size / 2;
  const gradient = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    center
  );
  gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
  gradient.addColorStop(0.2, "rgba(255, 255, 255, 0.8)");
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.3)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  return new CanvasTexture(canvas);
}

function createParticleLayer(positions, colors, texture, size, opacity) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));

  const material = new PointsMaterial({
    size,
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity,
    sizeAttenuation: true,
    alphaTest: 0.01,
    depthWrite: false,
  });

  return { points: new Points(geometry, material), geometry, material };
}

export function createStarfield(scene, options = {}) {
  const {
    starCount = 3000,
    sparkleCount = 800,
    zNear = 50,
    zFar = 4000,
    spread = 200,
    size = 2.0,
    sparkleSize = 3.0,
    color = 0xffffff,
    opacity = 0.9,
    speed = 50,
  } = options;

  const logger = new Logger("Starfield", false);

  const baseColor = new Color(color);
  const warmColor = new Color(0xffaa44);
  const coolColor = new Color(0x44aaff);
  const pinkColor = new Color(0xff66aa);

  function generateStars(count) {
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      positions[i3] = (Math.random() - 0.5) * spread;
      positions[i3 + 1] = (Math.random() - 0.5) * spread;
      positions[i3 + 2] = -zFar + Math.random() * (zFar - zNear);

      const colorVariation = Math.random();
      let starColor;
      if (colorVariation < 0.15) starColor = warmColor;
      else if (colorVariation < 0.3) starColor = coolColor;
      else if (colorVariation < 0.4) starColor = pinkColor;
      else starColor = baseColor;

      const brightness = 0.6 + Math.random() * 0.4;
      colors[i3] = starColor.r * brightness;
      colors[i3 + 1] = starColor.g * brightness;
      colors[i3 + 2] = starColor.b * brightness;
    }
    return { positions, colors };
  }

  const starGroup = new Group();
  starGroup.name = "starfield";

  const glowTexture = createGlowTexture(64);
  const glowData = generateStars(starCount);

  let minZ = Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < starCount; i++) {
    const z = glowData.positions[i * 3 + 2];
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  logger.log(
    `Glow layer - particles: ${starCount}, Z range: ${minZ.toFixed(
      1
    )} to ${maxZ.toFixed(1)}`
  );
  logger.log(
    `Sample positions: (${glowData.positions[0].toFixed(
      1
    )}, ${glowData.positions[1].toFixed(1)}, ${glowData.positions[2].toFixed(
      1
    )}), (${glowData.positions[3].toFixed(1)}, ${glowData.positions[4].toFixed(
      1
    )}, ${glowData.positions[5].toFixed(1)})`
  );

  const glowLayer = createParticleLayer(
    glowData.positions,
    glowData.colors,
    glowTexture,
    size,
    opacity
  );
  glowLayer.points.name = "starfield-glow";
  starGroup.add(glowLayer.points);

  const loader = new TextureLoader();
  const sparkleTexture = loader.load("./images/star-particle.png");
  const sparkleData = generateStars(sparkleCount);
  const sparkleLayer = createParticleLayer(
    sparkleData.positions,
    sparkleData.colors,
    sparkleTexture,
    sparkleSize,
    opacity * 0.8
  );
  sparkleLayer.points.name = "starfield-sparkle";
  starGroup.add(sparkleLayer.points);

  scene.add(starGroup);

  logger.log(
    `Created - zNear: ${zNear}, zFar: ${zFar}, spread: ${spread}, speed: ${speed}`
  );
  logger.log(
    `StarGroup visible: ${starGroup.visible}, children: ${starGroup.children.length}`
  );

  const maxDistance = Math.sqrt(spread * spread + spread * spread) / 2;

  function calculateSpeedMultiplier(x, y) {
    const distanceFromCenter = Math.sqrt(x * x + y * y);
    const normalizedDistance = Math.min(distanceFromCenter / maxDistance, 1);
    const speedFactor = 1.0 - normalizedDistance;
    return 0.2 + speedFactor * speedFactor * 3.8;
  }

  function generateSpeedMultipliers(positions) {
    const count = positions.length / 3;
    const multipliers = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      multipliers[i] = calculateSpeedMultiplier(
        positions[i3],
        positions[i3 + 1]
      );
    }
    return multipliers;
  }

  const glowSpeedMultipliers = generateSpeedMultipliers(glowData.positions);
  const sparkleSpeedMultipliers = generateSpeedMultipliers(
    sparkleData.positions
  );

  logger.log(
    `Speed multipliers - min: ${Math.min(
      ...Array.from(glowSpeedMultipliers)
    ).toFixed(2)}, max: ${Math.max(...Array.from(glowSpeedMultipliers)).toFixed(
      2
    )}`
  );

  const state = {
    speed,
    disposed: false,
    lastTime: 0,
    frameCount: 0,
  };

  function resetStar(posArray, index, speedMultipliers) {
    const i3 = index * 3;
    posArray[i3] = (Math.random() - 0.5) * spread;
    posArray[i3 + 1] = (Math.random() - 0.5) * spread;
    posArray[i3 + 2] = -zFar + Math.random() * (zFar - zNear);
    speedMultipliers[index] = calculateSpeedMultiplier(
      posArray[i3],
      posArray[i3 + 1]
    );
  }

  function animateLayer(geometry, delta, speedMultipliers, layerName) {
    const positions = geometry.attributes.position.array;
    const count = positions.length / 3;

    let minZ = Infinity,
      maxZ = -Infinity,
      resetCount = 0;

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      const speedMultiplier = speedMultipliers[i];
      const movement = state.speed * speedMultiplier * delta;
      positions[i3 + 2] += movement;
      minZ = Math.min(minZ, positions[i3 + 2]);
      maxZ = Math.max(maxZ, positions[i3 + 2]);
      if (positions[i3 + 2] > 0) {
        resetStar(positions, i, speedMultipliers);
        resetCount++;
      }
    }

    if (state.frameCount % 60 === 0) {
      logger.log(
        `${layerName} - Z range: ${minZ.toFixed(1)} to ${maxZ.toFixed(
          1
        )}, resets: ${resetCount}, delta: ${delta.toFixed(4)}`
      );
    }

    geometry.attributes.position.needsUpdate = true;
  }

  function animate(delta) {
    if (state.disposed) return;
    const dt = delta !== undefined ? delta : 0.016;
    state.frameCount++;

    if (state.frameCount === 1) {
      logger.log(`First animate call - speed: ${state.speed}, delta: ${dt}`);
    }

    animateLayer(glowLayer.geometry, dt, glowSpeedMultipliers, "glow");
    animateLayer(sparkleLayer.geometry, dt, sparkleSpeedMultipliers, "sparkle");
  }

  function dispose() {
    state.disposed = true;
    scene.remove(starGroup);
    glowLayer.geometry.dispose();
    glowLayer.material.dispose();
    sparkleLayer.geometry.dispose();
    sparkleLayer.material.dispose();
  }

  return {
    stars: starGroup,
    animate,
    dispose,
    setSpeed: (s) => {
      state.speed = s;
    },
    setVisible: (visible) => {
      starGroup.visible = visible;
    },
  };
}
