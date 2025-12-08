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

### AIManager (`src/ai/AIManager.js`)

The main orchestrator for AI-powered speech processing and robot interaction:

- **Voice Recording**: Records audio via Web Audio API
- **Transcription**: Sends audio to OpenAI Whisper (via Lambda proxy in prod)
- **Interpretation**: Analyzes transcription with AWS Bedrock Llama 3.3
- **Robot Reactions**: Triggers appropriate robot responses based on intent/sentiment
- **Object Tracking**: Maintains tracked objects with confidence scoring (SAM3)
- **Depth Processing**: Fuses server depth maps with native WebXR hit test depth
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

### Architecture Overview

The AI system uses cloud-based services for speech processing and intent analysis:

```
User Speech → OpenAI Whisper → Transcription → AWS Bedrock (Llama 3.3) → Intent/Sentiment
```

**Production**: Requests route through an AWS Lambda proxy to protect API keys.
**Local Dev**: Direct API calls using keys from `.env` file.

### Services

| Service            | Provider                | Purpose                                                    |
| ------------------ | ----------------------- | ---------------------------------------------------------- |
| **Transcription**  | OpenAI Whisper API      | Speech-to-text conversion                                  |
| **Interpretation** | AWS Bedrock (Llama 3.3) | Intent classification, sentiment analysis, name correction |

### Configuration (`src/ai/config.js`)

```javascript
// Automatically uses Lambda proxy in production, direct API in local dev
USE_LAMBDA_PROXY = !isLocalDev; // true on GitHub Pages, false on localhost
LAMBDA_PROXY_URL = "https://xxx.lambda-url.us-east-1.on.aws";

// Local dev only (from .env):
OPENAI_API_KEY; // OpenAI API key for transcription
AWS_BEDROCK_API_KEY; // AWS Bedrock API key for Llama 3.3
AWS_REGION; // Default: us-east-1
AWS_BEDROCK_MODEL_ID; // Default: us.meta.llama3-3-70b-instruct-v1:0
```

### Environment Variables (`.env`)

For local development, create a `.env` file (not committed to git):

```bash
VITE_OPENAI_API_KEY=sk-proj-...
VITE_AWS_BEDROCK_API_KEY=ABSK...
VITE_AWS_REGION=us-east-1
```

### Lambda Proxy (`lambda/index.mjs`)

For production deployment (GitHub Pages), API keys are stored securely in AWS Lambda environment variables. The Lambda handles:

- `/transcribe` - Proxies audio to OpenAI Whisper API
- `/interpret` - Proxies text to AWS Bedrock Converse API

### Interpretation Response Format

The Llama 3.3 model returns structured JSON:

```json
{
  "intent": "greeting|farewell|command|question|acknowledgment|reassuring|negative|other",
  "confidence": 0.95,
  "is_greeting": true,
  "is_reassuring": false,
  "is_goodbye": false,
  "sentiment": "friendly|neutral|unfriendly|hostile",
  "score": 0.8,
  "is_rude": false,
  "corrected_transcription": "Hello Blit!",
  "robot_directive": { ... }
}
```

**Special Features:**

- **Name Correction**: Automatically corrects sound-alikes to robot names (Blit, Baud, Modem)
- **Game State Evaluation**: Evaluates `is_greeting`, `is_reassuring`, `is_goodbye` for game logic
- **Sentiment Analysis**: Detects emotional tone for robot reactions

### Module Reference

| Module              | Responsibility                             |
| ------------------- | ------------------------------------------ |
| `AIManager.js`      | Central AI orchestration                   |
| `ApiClient.js`      | HTTP client for OpenAI & Bedrock APIs      |
| `config.js`         | API endpoints, keys, Lambda proxy config   |
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

## Backend Services

### Cloud AI Services (Required)

| Service            | Endpoint                                  | Purpose                             |
| ------------------ | ----------------------------------------- | ----------------------------------- |
| **OpenAI Whisper** | `api.openai.com/v1/audio/transcriptions`  | Speech-to-text                      |
| **AWS Bedrock**    | `bedrock-runtime.us-east-1.amazonaws.com` | Llama 3.3 inference                 |
| **Lambda Proxy**   | Custom Function URL                       | Secure API key proxy for production |

### SAM3 Server (Optional)

For object detection features, a SAM3 server at `localhost:8002`:

- **`/segment/voice`**: Accepts image + audio, returns detections with masks
- **`/segment/json`**: Accepts image + text prompts, returns detections
- **`/generate3d`**: Accepts mask + image, returns Gaussian splat model

## Development

```bash
npm run dev    # Start Vite dev server with HTTPS (port 8081)
```

**Requirements:**

- Node.js >= 20.19.0
- Meta Quest 3 (or desktop browser with IWER extension)
- OpenAI API key (for transcription)
- AWS Bedrock API key (for interpretation)

**Environment Setup:**

Create `.env` in project root:

```bash
VITE_OPENAI_API_KEY=sk-proj-your-key-here
VITE_AWS_BEDROCK_API_KEY=your-bedrock-api-key
```

**Emulator Mode:**

- Detected via `localhost` hostname OR non-Quest user agent
- Bypasses Quest-only platform check
- Disables camera features (suppresses "No back-facing camera" errors)
- Uses IWER (Immersive Web Emulation Runtime) for WebXR

## Deployment

### GitHub Pages

```bash
npm run build           # Build to dist/
npx gh-pages -d dist    # Deploy to gh-pages branch
```

**Important:** The `base` path in `vite.config.js` must match your GitHub Pages path (e.g., `/nano/`).

### Lambda Proxy Setup

For production, deploy the Lambda proxy to hide API keys:

1. Create Lambda function from `lambda/index.mjs`
2. Set environment variables:
   - `OPENAI_API_KEY`
   - `AWS_BEDROCK_API_KEY`
   - `BEDROCK_REGION` (default: us-east-1)
3. Create Function URL with CORS enabled for your domain
4. Update `LAMBDA_PROXY_URL` in `src/ai/config.js`

## Dependencies

### Runtime

- **`@iwsdk/core`** (0.2.1) - Core framework
- **`@iwsdk/xr-input`** - XR input handling
- **`@pmndrs/uikit-horizon`** - UI kit for spatial interfaces
- **`three`** (via `super-three@0.177.0`) - 3D graphics
- **`tslib`** - TypeScript runtime helpers

### Build

- **Vite** - Build tool and dev server
- **`@iwsdk/vite-plugin-iwer`** - IWER injection for emulator
- **`@iwsdk/vite-plugin-uikitml`** - UIKitML compilation
- **`gh-pages`** - GitHub Pages deployment

### Cloud Services

- **OpenAI Whisper API** - Speech-to-text
- **AWS Bedrock** - Llama 3.3 70B inference
- **AWS Lambda** - Secure API proxy
