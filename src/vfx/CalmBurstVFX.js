import {
  Group,
  Points,
  BufferGeometry,
  Float32BufferAttribute,
  PointsMaterial,
  TextureLoader,
  Color,
  AdditiveBlending,
} from "three";

export class CalmBurstVFX {
  constructor(options = {}) {
    this.config = {
      particleCount: options.particleCount || 24,
      burstSpeed: options.burstSpeed || 2.0,
      particleSize: options.particleSize || 0.025,
      duration: options.duration || 0.6,
      primaryColor: new Color(options.primaryColor || 0x00ffcc),
      secondaryColor: new Color(options.secondaryColor || 0xffff00),
      gravity: options.gravity || -2.0,
    };

    this.group = new Group();
    this.time = 0;
    this.isComplete = false;
    this.onComplete = options.onComplete || null;
    this.velocities = [];
    this.positions = null;

    this._createParticles();
  }

  _createParticles() {
    const count = this.config.particleCount;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const { primaryColor, secondaryColor, burstSpeed, particleSize } =
      this.config;

    this.velocities = [];

    for (let i = 0; i < count; i++) {
      positions[i * 3] = 0;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = 0;

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.6;
      const speed = burstSpeed * (0.5 + Math.random() * 0.8);

      this.velocities.push({
        x: Math.sin(phi) * Math.cos(theta) * speed,
        y: Math.cos(phi) * speed * 0.8 + 0.5,
        z: Math.sin(phi) * Math.sin(theta) * speed,
      });

      const colorMix = Math.random();
      colors[i * 3] =
        primaryColor.r * (1 - colorMix) + secondaryColor.r * colorMix;
      colors[i * 3 + 1] =
        primaryColor.g * (1 - colorMix) + secondaryColor.g * colorMix;
      colors[i * 3 + 2] =
        primaryColor.b * (1 - colorMix) + secondaryColor.b * colorMix;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    this.positions = geometry.attributes.position.array;

    const textureLoader = new TextureLoader();
    const particleTexture = textureLoader.load("./images/star-particle.png");

    const material = new PointsMaterial({
      size: this.config.particleSize,
      map: particleTexture,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.particleSystem = new Points(geometry, material);
    this.particleSystem.renderOrder = 100;
    this.group.add(this.particleSystem);
  }

  setPosition(position) {
    this.group.position.copy(position);
  }

  update(deltaTime) {
    if (this.isComplete) return;
    this.time += deltaTime;

    const count = this.config.particleCount;
    const gravity = this.config.gravity;

    for (let i = 0; i < count; i++) {
      const vel = this.velocities[i];
      this.positions[i * 3] += vel.x * deltaTime;
      this.positions[i * 3 + 1] += vel.y * deltaTime;
      this.positions[i * 3 + 2] += vel.z * deltaTime;
      vel.y += gravity * deltaTime;
      vel.x *= 0.98;
      vel.z *= 0.98;
    }

    this.particleSystem.geometry.attributes.position.needsUpdate = true;

    const progress = this.time / this.config.duration;
    this.particleSystem.material.opacity =
      0.9 * Math.max(0, 1 - progress * progress);

    if (this.time >= this.config.duration) {
      this.isComplete = true;
      if (this.onComplete) this.onComplete();
    }
  }

  addToScene(scene) {
    scene.add(this.group);
  }

  removeFromScene(scene) {
    scene.remove(this.group);
  }

  dispose() {
    if (this.particleSystem) {
      this.particleSystem.geometry.dispose();
      this.particleSystem.material.dispose();
      if (this.particleSystem.material.map) {
        this.particleSystem.material.map.dispose();
      }
    }
    this.group.clear();
  }
}

export default CalmBurstVFX;
