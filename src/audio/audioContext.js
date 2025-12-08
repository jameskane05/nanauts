const audioContext = new (window.AudioContext || window.webkitAudioContext)();

let masterVolume = 1.0;
let isPaused = false;
const visibilityCallbacks = new Set();

export function setMasterVolume(volume) {
  masterVolume = Math.max(0, Math.min(1, volume));
}

export function getMasterVolume() {
  return masterVolume;
}

export function updateListenerPosition(x, y, z, forwardX = 0, forwardY = 0, forwardZ = -1) {
  const listener = audioContext.listener;
  if (listener.positionX) {
    listener.positionX.setValueAtTime(x, audioContext.currentTime);
    listener.positionY.setValueAtTime(y, audioContext.currentTime);
    listener.positionZ.setValueAtTime(z, audioContext.currentTime);
    listener.forwardX.setValueAtTime(forwardX, audioContext.currentTime);
    listener.forwardY.setValueAtTime(forwardY, audioContext.currentTime);
    listener.forwardZ.setValueAtTime(forwardZ, audioContext.currentTime);
  } else {
    listener.setPosition(x, y, z);
    listener.setOrientation(forwardX, forwardY, forwardZ, 0, 1, 0);
  }
}

export function createPanner() {
  const panner = audioContext.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.maxDistance = 20;
  panner.rolloffFactor = 1.5;
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 1;
  return panner;
}

export function resumeAudioContext() {
  if (audioContext.state === 'suspended' && !isPaused) {
    audioContext.resume();
  }
}

export function suspendAudioContext() {
  isPaused = true;
  if (audioContext.state === 'running') {
    audioContext.suspend();
  }
}

export function isAudioPaused() {
  return isPaused;
}

export function onVisibilityChange(callback) {
  visibilityCallbacks.add(callback);
  return () => visibilityCallbacks.delete(callback);
}

function handleVisibilityChange() {
  const visible = document.visibilityState === 'visible';
  isPaused = !visible;
  
  if (visible) {
    audioContext.resume();
  } else {
    audioContext.suspend();
  }
  
  for (const cb of visibilityCallbacks) {
    cb(visible);
  }
}

document.addEventListener('visibilitychange', handleVisibilityChange);

export { audioContext, masterVolume };

