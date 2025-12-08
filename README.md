# IWSDK-Nano Project Documentation

## Project Overview

This is a WebXR application built using the Immersive Web SDK (IWSDK) framework. It's an AR application designed for Meta Quest 3 featuring:

- **Robot Swarm**: Three lifelike droids with procedural animation, navmesh navigation, and social interactions
- **Mixed Reality**: XR room capture, mesh detection, and real-world surface navigation
- Voice-controlled AI object detection and segmentation
- Hand tracking and controller input
- 3D spatial UI panels
- Data-driven audio and game state management

## Framework: Immersive Web SDK (IWSDK)

IWSDK is an ECS (Entity Component System) framework for building WebXR applications. Key concepts:

- **World**: The main container that manages the XR session, scene, and systems
- **Systems**: Logic that operates on entities matching specific component queries
- **Components**: Data containers attached to entities
- **Entities**: Objects in the scene (can be 3D objects, UI elements, etc.)

The framework uses `@iwsdk/core` which provides:

- ECS architecture (`createSystem`, `createComponent`)
- WebXR session management via `visibilityState` Signal
- Asset management with preloading priorities
- Three.js integration (via `super-three`)
- XR Input handling via `@iwsdk/xr-input`
- Spatial UI via UIKit and UIKitML

## Application Initialization Flow

```
Page Load
    ↓
Platform Detection (Quest-only, emulator bypass)
    ↓
├─ Non-Quest → UnsupportedScreen (STOP)
    ↓
Quest/Emulator → LoadingScreen (DOM)
    ↓
World.create() + Systems register
    ↓
Loading complete → StartScreen (UIKit spatial UI)
    ↓
User clicks START → ENTERING_XR
    ↓
world.launchXR()
    ↓
visibilityState → 'visible'
    ↓
GameStateSystem → XR_ACTIVE
    ↓
PLAYING (game begins)
```

## Game State Management

### GAME_STATES (`src/gameState.js`)

```javascript
GAME_STATES = {
  PLATFORM_CHECK: -2, // Initial platform detection
  UNSUPPORTED_PLATFORM: -1, // Non-Quest device
  LOADING: 0, // Assets loading
  START_SCREEN: 1, // Pre-XR menu
  ENTERING_XR: 2, // Launching XR session
  XR_ACTIVE: 3, // XR visible, ready for gameplay
  XR_PAUSED: 4, // Headset removed / system UI
  PLAYING: 5, // Active gameplay
  // Game-specific states added as needed
};
```

### Multi-Session Support

Users can enter/exit XR multiple times. Game progress persists:

- **XR Pause** (headset removed): `XR_PAUSED`, stores `stateBeforePause`
- **XR Resume** (headset back): Restores previous state
- **XR End** (session ended): Back to `START_SCREEN`

### Criteria System (`src/utils/criteriaHelper.js`)

Data-driven state matching with MongoDB-style operators:

```javascript
// Simple equality
criteria: { currentState: GAME_STATES.PLAYING }

// Comparison operators
criteria: { currentState: { $gte: GAME_STATES.XR_ACTIVE, $lt: GAME_STATES.PLAYING } }

// Array membership
criteria: { currentState: { $in: [GAME_STATES.XR_ACTIVE, GAME_STATES.PLAYING] } }

// Multiple conditions
criteria: { isXRActive: true, currentState: { $gte: GAME_STATES.PLAYING } }
```

**Supported Operators:** `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`

## Core Systems

### GameStateSystem (`src/systems/GameStateSystem.js`)

Syncs IWSDK's `visibilityState` Signal to `gameState`:

- Subscribes to `world.visibilityState` (values: `'non-immersive'`, `'visible'`, `'hidden'`, `'visible-blurred'`)
- Handles XR session enter/pause/resume/exit transitions
- Updates `isXRActive` and `currentState` accordingly

### AudioSystem (`src/systems/AudioSystem.js`)

Criteria-based audio playback using IWSDK's native audio:

- Uses `AudioSource` component and `AudioUtils` (no external libraries)
- Music tracks attached to player head (stereo playback)
- SFX can be positional (world-space) or non-positional
- Auto-plays/stops based on criteria matching current state

### AIManager (`src/aiManager.js`)

The main orchestrator for AI-powered object detection and 3D reconstruction:

- **Voice Recording**: Records audio commands to identify objects
- **Server Communication**: Sends images + audio to SAM3 segmentation server
- **Object Tracking**: Maintains tracked objects with confidence scoring
- **Depth Processing**: Fuses server depth maps with native WebXR hit test depth
- **3D Model Generation**: Requests Gaussian splat reconstructions
- **Label Management**: Creates floating 3D labels above detected objects

### HandInputSystem (`src/handInputSystem.js`)

Manages XR input from controllers and hand tracking:

- Initializes `XRInputManager` from `@iwsdk/xr-input`
- Provides access to gamepads, visual adapters, and XR origin spaces
- Detects pinch gestures for hand-tracked input

## Robot System (`src/robot/`)

The robot system manages a swarm of three animated droids navigating the real-world environment.

### Architecture

`RobotSystem.js` is the central ECS orchestrator (~1600 lines) that delegates to specialized managers:

| Manager                   | Responsibility                                          |
| ------------------------- | ------------------------------------------------------- |
| `RobotMovementManager`    | Tilt, bank, squash/stretch, anticipation/follow-through |
| `RobotNavigationManager`  | Goals, target selection, spawn return                   |
| `RobotInteractionManager` | Robot-to-robot proximity interactions                   |
| `RobotNavMeshManager`     | NavMesh generation, off-mesh connections                |
| `RobotJumpManager`        | Off-mesh traversal jump physics                         |
| `RobotScanManager`        | Scanning behavior with VFX/audio                        |
| `RobotAudioManager`       | Engine sounds, voice chatter                            |
| `RobotCharacterManager`   | Names, characters, name tags                            |
| `RobotRoomSetupManager`   | XR room capture flow                                    |
| `RobotStateMachine`       | Per-robot behavior state                                |

### State Machine

Robot behavior states defined in `RobotBehaviorState.js` and configured in `RobotStateConfig.js`:

```javascript
ROBOT_STATE = {
  IDLE,
  WANDERING,
  JUMPING,
  SCANNING,
  CHATTING,
  REACTING,
  APPROACHING,
  MOVING_TO_GOAL,
  STATIONARY,
};
```

### Per-Robot Managers

Each robot instance has dedicated animation managers:

- `RobotFaceManager` - Face emotion UV scrolling and look-at rotation
- `RobotArmManager` - Procedural arm animations with spring physics
- `RobotAntennaManager` - Secondary motion physics
- `RobotTieManager` - Tie swing animation

### Navigation

Uses [navcat](https://github.com/recast-navigation/recast-navigation-js) for crowd simulation:

- NavMesh generated from XR mesh detection surfaces
- Off-mesh connections for jumping between disconnected surfaces
- Crowd-based pathfinding with obstacle avoidance

## VFX System (`src/vfx/`)

Visual effects managed by `VFXManager.js`:

| VFX                              | Purpose                              |
| -------------------------------- | ------------------------------------ |
| `RobotEngineThrustVFX`           | Fusion propulsion rings under robots |
| `ScannerVFX` / `ScannerLaserVFX` | Robot scanning effect                |
| `PortalVFX`                      | Robot spawn portal                   |
| `ContactShadowVFX`               | Dynamic contact shadows              |
| `Starfield`                      | Background particle effect           |

## UI Screens

### Loading Screen (`src/ui/loadingScreen.js`)

DOM-based loading UI with progress tracking:

- `registerTask(name)` - Register a loading task
- `updateTask(name, progress)` - Update progress (0-1)
- `completeTask(name)` - Mark task complete
- Auto-hides and transitions to START_SCREEN when all tasks complete

### Start Screen (`src/ui/startScreen.js` + `ui/startScreen.uikitml`)

UIKit spatial UI menu:

- START button → launches XR session
- OPTIONS button → (placeholder for settings)
- Keyboard/gamepad navigation support

### Unsupported Screen (`src/ui/unsupportedScreen.js`)

Blocking message for non-Quest browsers with instructions.

## Audio Data (`src/data/audioData.js`)

Unified audio definitions for music and SFX:

```javascript
{
  id: "trackName",
  src: "/audio/music/track.mp3",
  type: "music" | "sfx",
  priority: "critical" | "background",
  loop: true,
  volume: 0.7,
  spatial: false,  // true for positional SFX
  position: { x, y, z },  // for spatial audio
  criteria: { ... },  // auto-play conditions
}
```

## AI System (`src/ai/`)

| Module              | Responsibility                             |
| ------------------- | ------------------------------------------ |
| `AIManager.js`      | Central AI orchestration                   |
| `ApiClient.js`      | HTTP communication with SAM3 server        |
| `CameraCapture.js`  | Camera frame capture, head transform       |
| `ObjectTracker.js`  | Multi-view object tracking with confidence |
| `DepthProcessor.js` | Depth map processing, world positioning    |
| `LabelManager.js`   | Floating text labels above objects         |
| `ModelGenerator.js` | 3D model generation from masks             |

## Audio System (`src/audio/`)

| Module            | Responsibility                      |
| ----------------- | ----------------------------------- |
| `audioContext.js` | Web Audio context and master volume |
| `RobotEngine.js`  | Procedural engine hum synthesis     |
| `RobotVoice.js`   | Robot voice/chatter synthesis       |
| `RobotScanner.js` | Scanner sound effect                |

## Project Structure

```
src/
├── index.js                    # Application entry point
├── gameState.js                # Central state management
├── systems/
│   ├── GameStateSystem.js      # visibilityState → gameState sync
│   └── AudioSystem.js          # Criteria-based audio playback
├── robot/
│   ├── RobotSystem.js          # Central robot orchestrator
│   ├── RobotMovementManager.js # Procedural animation
│   ├── RobotNavigationManager.js # Goals and targeting
│   ├── RobotInteractionManager.js # Robot-to-robot social
│   ├── RobotStateMachine.js    # Per-robot state
│   ├── RobotBehaviorState.js   # State enum
│   ├── RobotStateConfig.js     # State config
│   └── ...                     # Other managers (19 files total)
├── vfx/
│   ├── VFXManager.js           # VFX lifecycle management
│   ├── RobotEngineThrustVFX.js # Propulsion rings
│   ├── ScannerVFX.js           # Scan effect
│   └── ...                     # Other VFX (9 files total)
├── ui/
│   ├── loadingScreen.js        # DOM loading screen
│   ├── startScreen.js          # UIKit start menu
│   └── unsupportedScreen.js    # Non-Quest blocking screen
├── audio/
│   └── audioContext.js         # Web Audio context
├── data/
│   └── audioData.js            # Audio definitions with criteria
├── utils/
│   ├── criteriaHelper.js       # State matching operators
│   ├── platformDetection.js    # Quest/emulator detection
│   ├── navSurfaces.js          # NavMesh surface collection
│   └── Logger.js               # Logging utility
├── ai/
│   ├── AIManager.js            # AI orchestration
│   ├── ObjectTracker.js        # Multi-view tracking
│   ├── DepthProcessor.js       # Depth estimation
│   └── ...                     # Other AI modules (19 files)
├── components/
│   └── Robot.js                # Robot ECS component
└── handInputSystem.js          # XR input management

ui/
├── startScreen.uikitml         # Start screen UIKit markup
└── voice-panel.uikitml         # Voice panel markup
```

## XR Session Configuration

```javascript
xr: {
  sessionMode: SessionMode.ImmersiveAR,
  offer: "none",  // Manual launch via world.launchXR()
  features: {
    handTracking: true,
    anchors: true,
    hitTest: true,
    planeDetection: true,
    meshDetection: true,
    layers: true,
  },
},
features: {
  locomotion: false,
  grabbing: true,
  physics: true,
  sceneUnderstanding: true,
  camera: !IS_EMULATOR,
  spatialUI: {
    kits: [horizonKit, { MicIcon }],
  },
}
```

## User Interaction Flow

1. **Platform Check**: Verify Meta Quest browser (emulator allowed for dev)
2. **Loading**: Show progress while assets preload
3. **Start Screen**: UIKit menu with START button
4. **Launch XR**: User clicks START → `world.launchXR()`
5. **XR Active**: `visibilityState` becomes `'visible'`
6. **Voice Panel**: Floating panel attached to right controller
7. **Record**: Press A button or tap panel to start recording
8. **Speak**: Describe objects to detect ("Find the guitar")
9. **Detection**: Server returns segmentation masks + bounding boxes
10. **Placement**: Objects placed in 3D using depth fusion
11. **Labels**: Floating labels appear above detected objects
12. **3D Generation**: Click label to request Gaussian splat model

## Controller Mapping

| Button          | Action                            |
| --------------- | --------------------------------- |
| A (right/left)  | Toggle voice recording            |
| B (right/left)  | Reset all tracked objects         |
| Trigger (right) | Place sphere at hit test position |

## Backend Server (SAM3)

The application expects a SAM3 server running at `localhost:8002`:

- **`/segment/voice`**: Accepts image + audio, returns detections with masks
- **`/segment/json`**: Accepts image + text prompts, returns detections
- **`/generate3d`**: Accepts mask + image, returns Gaussian splat model

## Development

```bash
npm run dev    # Start Vite dev server with HTTPS
```

**Requirements:**

- Node.js >= 20.19.0
- SAM3 server running on port 8002
- Meta Quest 3 (or Quest Browser with passthrough)

**Emulator Mode:**

- Detected via `localhost` hostname
- Bypasses Quest-only platform check
- Disables camera features
- Hit tests may not work

## Dependencies

- **`@iwsdk/core`** (0.2.1) - Core framework
- **`@iwsdk/xr-input`** - XR input handling
- **`@pmndrs/uikit-horizon`** - UI kit for spatial interfaces
- **`three`** (via `super-three@0.177.0`) - 3D graphics
- **Vite plugins**: IWER injection, UIKitML compilation, GLTF optimization

## Web Preview Images

The following preview images are referenced in `index.html` meta tags and should be added to the `public/images/` directory:

- **`preview-og.jpg`** - Open Graph preview image (1200x630px recommended)

  - Used for Facebook, LinkedIn, and other Open Graph platforms
  - Should showcase the robot swarm in mixed reality environment

- **`preview-twitter.jpg`** - Twitter Card preview image (1200x675px recommended)
  - Used for Twitter/X link previews
  - Should showcase the robot swarm in mixed reality environment

Update the `og:url` and `twitter:url` meta tags in `index.html` with your actual domain when deploying.
