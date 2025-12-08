/**
 * RobotScanManager.js - Robot scanning behavior with VFX and audio
 * =============================================================================
 *
 * ROLE: Manages periodic "scanning" behavior where robots stop, look around,
 * and emit laser VFX while making scanning sounds. Adds curiosity personality.
 *
 * SCAN TRIGGER: After reaching N random goals (configurable), robot stops and
 * scans for a random duration before resuming navigation.
 *
 * SCAN COMPONENTS:
 *   - ScannerLaserVFX: Rotating laser beams with raycasted hit points
 *   - RobotScanner audio: Scanning sound effect
 *   - Face emotion: Set to CURIOUS during scan
 *   - Head rotation: Continuous pan via RobotFaceManager.startScanRotation()
 *
 * KEY METHODS:
 *   - startScan(entityIndex, duration, position): Begin scanning
 *   - stopScan(entityIndex): End scan, reset state
 *   - isScanning(entityIndex): Check if robot is currently scanning
 *   - update(entityIndex, robotEntity, agent, deltaTime): Per-frame update
 *   - onGoalReached(entityIndex, position): Check if scan should trigger
 *
 * INTEGRATION:
 *   - Respects interaction state: won't start/continue scan during interactions
 *   - Stops navcat agent movement during scan
 *   - Uses RobotFaceManager for head rotation
 *
 * CONFIG (this.scanConfig):
 *   - enabled: Master toggle
 *   - minDuration/maxDuration: Scan length range (ms)
 *   - goalsBeforeScan: [min, max] goals before triggering scan
 *
 * FORCED MODE: this.forcedScanMode = true makes all robots scan continuously.
 * =============================================================================
 */
import { Raycaster, Vector3 } from "three";
import { crowd } from "navcat/blocks";
import {
  findNearestPoly,
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
} from "navcat";
import { ScannerLaserVFX } from "../vfx/ScannerLaserVFX.js";
import { RobotScanner } from "../audio/RobotScanner.js";
import { resumeAudioContext } from "../audio/audioContext.js";
import { Logger } from "../utils/Logger.js";
import { RobotEmotion } from "./RobotFaceManager.js";

export class RobotScanManager {
  constructor(robotSystem) {
    this.robotSystem = robotSystem;
    this.logger = new Logger("RobotScanManager", true);

    // Scan state per robot
    this.robotScanState = new Map();
    this.robotScanners = new Map();
    this.robotScanVFX = new Map();

    // Scan configuration
    this.scanConfig = {
      enabled: true,
      minDuration: 3000,
      maxDuration: 6000,
      goalsBeforeScan: [4, 10],
    };

    this.forcedScanMode = false;

    // Raycaster for laser hit tests
    this._laserRaycaster = new Raycaster();
    this._laserRaycaster.near = 0.05;
    this._laserRaycaster.far = 10;
    this._laserRaycaster.firstHitOnly = true;
    this._rayOrigin = new Vector3();
    this._rayDirection = new Vector3();

    // Raycast mesh caching
    this._cachedRaycastMeshes = [];
    this._lastRaycastMeshUpdate = 0;
    this._raycastMeshUpdateInterval = 500;
    this._laserUpdateIndex = 0;

    // Temp vectors
    this._tempVec3 = new Vector3();
  }

  getScanState(entityIndex) {
    let scanState = this.robotScanState.get(entityIndex);
    if (!scanState) {
      scanState = {
        isScanning: false,
        scanEndTime: 0,
        goalsUntilScan: this._randomGoalsUntilScan(),
      };
      this.robotScanState.set(entityIndex, scanState);
    }
    return scanState;
  }

  isScanning(entityIndex) {
    const state = this.robotScanState.get(entityIndex);
    return state?.isScanning || false;
  }

  startScan(entityIndex, duration = 0, position = null) {
    const scanState = this.getScanState(entityIndex);
    if (scanState.isScanning) return;

    // Don't start regular scan if robot is panicking
    if (scanState.isPanicking) return;

    // Don't start scan if robot is in an interaction
    const rs = this.robotSystem;
    if (rs.interactionManager?.shouldPauseMovement(entityIndex)) return;

    scanState.isScanning = true;
    scanState.scanEndTime = duration > 0 ? Date.now() + duration : 0;

    // Stop the navcat agent at its current position
    const agentId = rs.robotAgentIds.get(entityIndex);
    if (agentId !== undefined && position && rs.navMesh && rs.agents) {
      const nearestResult = findNearestPoly(
        createFindNearestPolyResult(),
        rs.navMesh,
        position,
        [1, 1, 1],
        DEFAULT_QUERY_FILTER
      );
      if (nearestResult.found) {
        crowd.requestMoveTarget(
          rs.agents,
          agentId,
          nearestResult.nodeRef,
          nearestResult.position
        );
        this.logger.log(`Robot ${entityIndex} stopping at scan position`);
      }
    }

    // Start scanner audio
    let scanner = this.robotScanners.get(entityIndex);
    if (!scanner) {
      resumeAudioContext();
      scanner = new RobotScanner();
      this.robotScanners.set(entityIndex, scanner);
    }
    if (position) {
      scanner.setPosition(position[0], position[1], position[2]);
    }
    scanner.start();

    // Start scanner VFX - parent directly to antenna
    let vfx = this.robotScanVFX.get(entityIndex);
    const faceMgr = rs.getFaceManager(entityIndex);

    if (!vfx) {
      vfx = new ScannerLaserVFX();
      this.robotScanVFX.set(entityIndex, vfx);

      // Find and parent to AntennaTip mesh
      let antennaTip = null;
      if (faceMgr?.robotGroup) {
        faceMgr.robotGroup.traverse((child) => {
          if (child.name.includes("AntennaTip")) {
            antennaTip = child;
          }
        });
      }

      if (antennaTip) {
        // Compensate for robot's 0.5 scale
        vfx.group.scale.set(2, 2, 2);
        vfx.group.position.set(0, 0, 0);
        // Rotate to be perpendicular to ground (lasers spread horizontally)
        vfx.group.rotation.x = -Math.PI / 2;
        antennaTip.add(vfx.group);
        vfx.isParented = true;
      } else {
        // Fallback: add to scene
        rs.world.scene.add(vfx.group);
        vfx.isParented = false;
        this.logger.warn(`No antenna found, scanner VFX added to scene`);
      }
    }
    vfx.start();

    // Stop engine sound while scanning
    const engine = rs.audioManager.getEngine(entityIndex);
    if (engine) engine.setVolume(0);

    // Make curious sound and face when starting scan
    const voice = rs.audioManager.getVoice(entityIndex);
    if (voice) voice.curious();
    rs.setRobotFaceEmotion(entityIndex, RobotEmotion.CURIOUS);

    // Start face rotation
    const faceManager = rs.getFaceManager(entityIndex);
    if (faceManager && duration > 0) {
      faceManager.startScanRotation(duration);
    }

    this.logger.log(`Robot ${entityIndex} started scanning`);
  }

  stopScan(entityIndex) {
    const scanState = this.robotScanState.get(entityIndex);
    if (!scanState || !scanState.isScanning) return;

    const rs = this.robotSystem;

    scanState.isScanning = false;
    scanState.goalsUntilScan = this._randomGoalsUntilScan();

    const scanner = this.robotScanners.get(entityIndex);
    if (scanner) scanner.stop();

    const vfx = this.robotScanVFX.get(entityIndex);
    if (vfx) vfx.stop();

    // Make happy sound and face when done
    const voice = rs.audioManager.getVoice(entityIndex);
    if (voice) voice.happy();
    rs.setRobotFaceEmotion(entityIndex, RobotEmotion.EXCITED);

    // Stop face rotation
    const faceManager = rs.getFaceManager(entityIndex);
    if (faceManager) {
      faceManager.stopScanRotation();
    }

    this.logger.log(`Robot ${entityIndex} stopped scanning`);
  }

  setForcedScanMode(enabled) {
    this.forcedScanMode = enabled;
    this.logger.log(`Forced scan mode ${enabled ? "enabled" : "disabled"}`);

    if (!enabled) {
      for (const [entityIndex] of this.robotScanState) {
        this.stopScan(entityIndex);
      }
    }
  }

  /**
   * Start panic VFX (red lasers) - robot continues moving
   * Used during panic minigame
   */
  startPanicVFX(entityIndex) {
    const scanState = this.getScanState(entityIndex);
    const rs = this.robotSystem;

    // Stop any regular scanning first - prevents state conflicts
    if (scanState.isScanning) {
      this.stopScan(entityIndex);
    }

    // Get or create VFX
    let vfx = this.robotScanVFX.get(entityIndex);
    const faceMgr = rs.getFaceManager(entityIndex);

    if (!vfx) {
      vfx = new ScannerLaserVFX();
      this.robotScanVFX.set(entityIndex, vfx);

      // Find and parent to AntennaTip mesh
      let antennaTip = null;
      if (faceMgr?.robotGroup) {
        faceMgr.robotGroup.traverse((child) => {
          if (child.name.includes("AntennaTip")) {
            antennaTip = child;
          }
        });
      }

      if (antennaTip) {
        vfx.group.scale.set(2, 2, 2);
        vfx.group.position.set(0, 0, 0);
        vfx.group.rotation.x = -Math.PI / 2;
        antennaTip.add(vfx.group);
        vfx.isParented = true;
      } else {
        rs.world.scene.add(vfx.group);
        vfx.isParented = false;
      }
    } else {
      // VFX exists - ensure it's still parented and reset transform
      if (!vfx.group.parent) {
        // Re-parent if somehow detached
        let antennaTip = null;
        if (faceMgr?.robotGroup) {
          faceMgr.robotGroup.traverse((child) => {
            if (child.name.includes("AntennaTip")) {
              antennaTip = child;
            }
          });
        }
        if (antennaTip) {
          vfx.group.scale.set(2, 2, 2);
          vfx.group.position.set(0, 0, 0);
          vfx.group.rotation.set(-Math.PI / 2, 0, 0);
          antennaTip.add(vfx.group);
          vfx.isParented = true;
        } else {
          rs.world.scene.add(vfx.group);
          vfx.isParented = false;
        }
        this.logger.log(`Robot ${entityIndex} panic VFX re-parented`);
      } else {
        // Reset Y rotation but keep X rotation for correct orientation
        vfx.group.rotation.y = 0;
      }
    }

    // IMPORTANT: Explicitly reset VFX state before starting
    // This ensures clean state even if VFX was previously used for regular scanning
    vfx.isActive = false; // Reset first
    vfx.time = 0;

    // Set panic colors (red) - do this BEFORE start()
    vfx.setPanicMode();

    // Now start the VFX
    vfx.start();

    // Double-check all visual elements are visible
    vfx.group.visible = true;
    for (const laser of vfx.lasers) {
      laser.visible = true;
    }
    for (const dot of vfx.hitDots) {
      dot.visible = false; // Dots shown only on hit
    }
    if (vfx.emitter) {
      vfx.emitter.visible = true;
    }

    // Mark as panic mode - ensures update loop processes this VFX
    scanState.isPanicking = true;
    scanState.isScanning = false; // Explicitly ensure not in regular scan mode

    this.logger.log(
      `Robot ${entityIndex} started panic VFX (isActive=${vfx.isActive}, visible=${vfx.group.visible}, parent=${vfx.group.parent?.name})`
    );
  }

  /**
   * Stop panic VFX and reset colors
   */
  stopPanicVFX(entityIndex) {
    const scanState = this.getScanState(entityIndex);
    if (!scanState) return;

    scanState.isPanicking = false;

    const vfx = this.robotScanVFX.get(entityIndex);
    if (vfx) {
      vfx.stop();
      vfx.resetColor();
    }

    this.logger.log(`Robot ${entityIndex} stopped panic VFX`);
  }

  /**
   * Check if robot is in panic VFX mode
   */
  isPanicking(entityIndex) {
    const state = this.robotScanState.get(entityIndex);
    return state?.isPanicking || false;
  }

  _randomGoalsUntilScan() {
    const [min, max] = this.scanConfig.goalsBeforeScan;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  _randomScanDuration() {
    return (
      this.scanConfig.minDuration +
      Math.random() *
        (this.scanConfig.maxDuration - this.scanConfig.minDuration)
    );
  }

  _updateLaserHitTests(vfx) {
    const now = performance.now();
    if (now - this._lastRaycastMeshUpdate > this._raycastMeshUpdateInterval) {
      this._lastRaycastMeshUpdate = now;
      const navSurfacesSystem = this.robotSystem.world.navSurfacesSystem;
      if (navSurfacesSystem) {
        this._cachedRaycastMeshes = navSurfacesSystem.getRaycastMeshes(true);
      }
    }

    if (this._cachedRaycastMeshes.length === 0) return;

    const numLasers = vfx.numLasers || 8;
    const lasersPerFrame = 2;

    for (let j = 0; j < lasersPerFrame; j++) {
      const i = (this._laserUpdateIndex + j) % numLasers;
      const ray = vfx.getLaserRay(i);
      if (!ray) continue;

      this._rayOrigin.copy(ray.origin);
      this._rayDirection.copy(ray.direction).normalize();
      this._laserRaycaster.set(this._rayOrigin, this._rayDirection);

      const intersections = this._laserRaycaster.intersectObjects(
        this._cachedRaycastMeshes,
        false
      );

      if (intersections.length > 0) {
        const hit = intersections[0];
        vfx.setHitPosition(i, {
          x: hit.point.x,
          y: hit.point.y,
          z: hit.point.z,
        });
      } else {
        vfx.setHitPosition(i, null);
      }
    }

    this._laserUpdateIndex =
      (this._laserUpdateIndex + lasersPerFrame) % numLasers;
  }

  update(entityIndex, robotEntity, agent, deltaTime) {
    const rs = this.robotSystem;
    const scanState = this.getScanState(entityIndex);

    // Don't start or continue scans during robot-robot interactions
    if (rs.interactionManager?.shouldPauseMovement(entityIndex)) {
      if (scanState.isScanning) {
        this.stopScan(entityIndex);
      }
      return scanState.isScanning;
    }

    // Handle forced scan mode
    if (this.forcedScanMode && !scanState.isScanning) {
      this.startScan(entityIndex, 0, agent.position);
    }

    // Check if timed scan should end
    if (
      scanState.isScanning &&
      scanState.scanEndTime > 0 &&
      Date.now() >= scanState.scanEndTime
    ) {
      this.stopScan(entityIndex);
    }

    // Update scanner audio and VFX position while scanning
    if (scanState.isScanning) {
      const scanner = this.robotScanners.get(entityIndex);
      if (scanner) {
        scanner.setPosition(
          agent.position[0],
          agent.position[1],
          agent.position[2]
        );
      }

      const vfx = this.robotScanVFX.get(entityIndex);
      if (vfx) {
        // If parented to antenna, position is automatic. But we still need
        // to apply the local scan sweep rotation for the lasers to spin.
        const faceMgr = rs.getFaceManager(entityIndex);
        if (vfx.isParented) {
          // Apply scan sweep rotation locally (the spinning of lasers)
          if (faceMgr && faceMgr.isScanning) {
            const elapsed = performance.now() - faceMgr.scanStartTime;
            const progress = Math.min(elapsed / faceMgr.scanDuration, 1);
            const scanRotation = progress * Math.PI * 2 * faceMgr.scanRotations;
            vfx.group.rotation.y = scanRotation;
          }
        } else {
          // Fallback: manual position/rotation tracking
          vfx.setPosition(
            agent.position[0],
            agent.position[1] + 0.35,
            agent.position[2]
          );
          if (faceMgr && faceMgr.isScanning) {
            const elapsed = performance.now() - faceMgr.scanStartTime;
            const progress = Math.min(elapsed / faceMgr.scanDuration, 1);
            const easedProgress =
              progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            const scanRotation =
              easedProgress * Math.PI * 2 * faceMgr.scanRotations;
            const rot = robotEntity.getVectorView(rs.Transform, "orientation");
            rs._tempQuat.set(rot[0], rot[1], rot[2], rot[3]);
            rs._tempEuler.setFromQuaternion(rs._tempQuat, "YXZ");
            const robotYaw = rs._tempEuler.y;
            vfx.group.quaternion.setFromAxisAngle(
              this._tempVec3.set(0, 1, 0),
              robotYaw + scanRotation
            );
          }
        }

        vfx.group.updateMatrixWorld(true);
        vfx.update(deltaTime);

        if (vfx.getLaserRay) {
          this._updateLaserHitTests(vfx);
        }
      }

      return true; // Signal that robot is scanning (skip movement)
    }

    // Update panic VFX (separate from normal scanning)
    if (scanState.isPanicking) {
      const vfx = this.robotScanVFX.get(entityIndex);
      if (vfx) {
        vfx.group.updateMatrixWorld(true);
        vfx.update(deltaTime);

        // Spin panic lasers
        vfx.group.rotation.y += deltaTime * 3.0;

        if (vfx.getLaserRay) {
          this._updateLaserHitTests(vfx);
        }
      }
    }

    return false; // Not scanning
  }

  onGoalReached(entityIndex, agentPosition) {
    if (!this.scanConfig.enabled || this.robotSystem.goalPosition) return false;

    // Don't trigger normal scans during panic mode (panic VFX runs separately)
    const scanState = this.getScanState(entityIndex);
    if (scanState?.isPanicking) {
      return false;
    }

    // Don't trigger scans during interactions
    if (this.robotSystem.interactionManager?.shouldPauseMovement(entityIndex)) {
      return false;
    }

    scanState.goalsUntilScan--;

    this.logger.log(
      `Robot ${entityIndex} reached goal, goalsUntilScan: ${scanState.goalsUntilScan}`
    );

    if (scanState.goalsUntilScan <= 0) {
      const duration = this._randomScanDuration();
      this.startScan(entityIndex, duration, agentPosition);
      return true;
    }
    return false;
  }

  stopAll() {
    for (const [, scanner] of this.robotScanners) {
      scanner.stop();
    }
    for (const [, vfx] of this.robotScanVFX) {
      vfx.stop();
      vfx.group.removeFromParent();
      vfx.dispose();
    }
    this.robotScanners.clear();
    this.robotScanVFX.clear();
    this.robotScanState.clear();
  }

  dispose() {
    this.stopAll();
  }
}
