import { AvatarAnimationState, AvatarMovement, AvatarMovementInfo, engine, MovementAnimation, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math';
import { getExplorerConfiguration } from '~system/EnvironmentApi';
import { grounded, initGroundRaycast, updateGroundAdjust } from './ground';
import { dampVelocity, movementAxis, orientation, relativeDegrees, updateHorizontalVelocity } from './horizontal';
import { initStepCasts, isDoubleJump, isGliding, jumpStartHeight, updateVerticalVelocity } from './vertical';
import { initParamters as initParameters } from './parameters';
import { initWalkSystem, updateEngineWalk, consumeWalkResult } from './walk';
import { MAX_SPEED } from './constants';
import { settings } from './settings';
import { setupUi } from './ui';
import { initGlider } from './glider';
import { initTestTower } from './testTower';

// Avatar-bus audio clip pools published via MovementAnimation.sounds. Engine
// plays each listed clip once per frame on the avatar's local audio bus — the
// `sounds` field is single-frame fire-and-forget, so we only include it on the
// tick the event actually fires. Timings and variant pools mirror the native
// built-ins in `crates/collectibles/src/emotes.rs` so this scene-driven path
// behaves the same as the velocity-based fallback.
const WALK_STEP_SOUNDS = [
  'assets/sounds/avatar/avatar_footstep_walk01.wav',
  'assets/sounds/avatar/avatar_footstep_walk02.wav',
  'assets/sounds/avatar/avatar_footstep_walk03.wav',
  'assets/sounds/avatar/avatar_footstep_walk04.wav',
  'assets/sounds/avatar/avatar_footstep_walk05.wav',
  'assets/sounds/avatar/avatar_footstep_walk06.wav',
  'assets/sounds/avatar/avatar_footstep_walk07.wav',
  'assets/sounds/avatar/avatar_footstep_walk08.wav',
];
const RUN_STEP_SOUNDS = [
  'assets/sounds/avatar/avatar_footstep_run01.wav',
  'assets/sounds/avatar/avatar_footstep_run02.wav',
  'assets/sounds/avatar/avatar_footstep_run03.wav',
  'assets/sounds/avatar/avatar_footstep_run04.wav',
  'assets/sounds/avatar/avatar_footstep_run05.wav',
  'assets/sounds/avatar/avatar_footstep_run06.wav',
  'assets/sounds/avatar/avatar_footstep_run07.wav',
  'assets/sounds/avatar/avatar_footstep_run08.wav',
];
const JUMP_SOUNDS = [
  'assets/sounds/avatar/avatar_footstep_jump01.wav',
  'assets/sounds/avatar/avatar_footstep_jump02.wav',
  'assets/sounds/avatar/avatar_footstep_jump03.wav',
];
const LAND_SOUNDS = [
  'assets/sounds/avatar/avatar_footstep_land01.wav',
  'assets/sounds/avatar/avatar_footstep_land02.wav',
];

function pickRandom(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Clip-relative playback times (seconds) at which the walk/run loops trigger
// a footstep. Native config: walk.(0.41, 0.91), run.(0.21, 0.54).
const WALK_STEP_TIMES = [0.41, 0.91];
const RUN_STEP_TIMES = [0.21, 0.54];

// New phased / per-locomotion animation set lives in assets/animations/.
// Locomotion is a real 3-tier system: walk -> jog (default move) -> run (sprint).
const ANIM = 'assets/animations/';
const CLIP_IDLE = ANIM + 'Idle.glb';
const CLIP_WALK = ANIM + 'Walk.glb';
const CLIP_JOG = ANIM + 'Jog.glb';
const CLIP_RUN = ANIM + 'Run.glb';

// Phased jump clip sets, picked by take-off locomotion. 'idle' is the plain
// "Jump_*" set (the standing jump). Each jump plays:
//   Start (once) -> Rise (loop, while ascending) -> Mid (once, at apex)
//   -> Fall (loop, while descending) -> End (once, on touchdown)
// Hard_Landing replaces End on big drops; Long_Fall_Loop replaces Fall on long ones.
type JumpVariation = 'idle' | 'jog' | 'run';
type JumpPhase = 'none' | 'start' | 'rise' | 'mid' | 'fall';
const JUMP_SETS: Record<JumpVariation, { start: string; rise: string; mid: string; fall: string; end: string }> = {
  idle: { start: ANIM + 'Jump_Start.glb', rise: ANIM + 'Jump_Rise_Loop.glb', mid: ANIM + 'Jump_Mid.glb', fall: ANIM + 'Jump_Fall_Loop.glb', end: ANIM + 'Jump_End.glb' },
  jog: { start: ANIM + 'Jog_Jump_Start.glb', rise: ANIM + 'Jog_Jump_Rise_Loop.glb', mid: ANIM + 'Jog_Jump_Mid.glb', fall: ANIM + 'Jog_Jump_Fall_Loop.glb', end: ANIM + 'Jog_Jump_End.glb' },
  run: { start: ANIM + 'Run_Jump_Start.glb', rise: ANIM + 'Run_Jump_Rise_Loop.glb', mid: ANIM + 'Run_Jump_Mid.glb', fall: ANIM + 'Run_Jump_Fall_Loop.glb', end: ANIM + 'Run_Jump_End.glb' },
};
const CLIP_LONG_FALL = ANIM + 'Long_Fall_Loop.glb';
const CLIP_HARD_LANDING = ANIM + 'Hard_Landing.glb';
const CLIP_JOG_STOP = ANIM + 'Jog_Stop.glb';

// Double-jump avatar clips, per take-off locomotion variation.
const DOUBLE_JUMP: Record<JumpVariation, string> = {
  idle: ANIM + 'DoubleJump_Base2.glb',
  jog: ANIM + 'DoubleJump_Jog2.glb',
  run: ANIM + 'DoubleJump_Run2.glb',
};
// Directional glide avatar poses (the glider model itself is a separate prop
// entity — see src/glider.ts).
const GLIDE_AVATAR = {
  forward: ANIM + 'Gliding_AvatarForward.glb', // pitched forward (moving fast)
  idle: ANIM + 'Gliding_AvatarIdle.glb',       // upright / lean-back (slow)
  left: ANIM + 'Gliding_AvatarLeft.glb',
  right: ANIM + 'Gliding_AvatarRight.glb',
};

// export all the functions required to make the scene work
export * from '@dcl/sdk'

// setup
var positionAdjust = Vector3.Zero();
export function main() {
  getExplorerConfiguration({}).then((config) => {
    positionAdjust = {
      "bevy-explorer": Vector3.Zero(),
      "": Vector3.create(0, -0.08, 0), // probably explorer alpha...
    }[config.clientUri] ?? (console.log(`unknown client ${config.clientUri}`), Vector3.Zero());
    updateGroundAdjust(positionAdjust.y);
  })

  initGroundRaycast();
  initStepCasts();
  initWalkSystem();
  initGlider();
  initTestTower();
  setupUi();

  engine.addSystem(initFrame, 100000 + 1);
  engine.addSystem(applyMovement, 100000 - 3);
}

export var time = 0;
export var tick = 0;
export var stepTime = 0;
export var prevStepTime = 0;
export var playerPosition: Vector3 = Vector3.Zero();
export var prevPlayerPosition: Vector3 = Vector3.Zero();
export var playerRotation: Quaternion = Quaternion.Identity();

export var velocity = Vector3.Zero();
export var velocityNorm = Vector3.Zero();
export var velocityLength = 0;
export var prevRequestedVelocity = Vector3.Zero();
export var prevActualVelocity = Vector3.Zero();
export var prevExternalVelocity = Vector3.Zero();

// What we published last frame. Compared against prevRequestedVelocity in
// initFrame to detect engine takeover (resync to prevActual when they differ).
var lastPublished = Vector3.Zero();

export function printvec(v: Vector3): string {
  return `(${v.x},${v.y},${v.z})`
}

function initFrame() {
  tick += 1;
  prevPlayerPosition = { ...playerPosition };
  const playerTransform = Transform.get(engine.PlayerEntity)
  Vector3.copyFrom(playerTransform.position, playerPosition);
  Vector3.addToRef(playerPosition, positionAdjust, playerPosition);
  playerRotation = playerTransform.rotation;

  const movementInfo = AvatarMovementInfo.getOrNull(engine.PlayerEntity);
  activeAnimationState = movementInfo?.activeAnimationState;
  if (movementInfo !== null) {
    Vector3.copyFrom(movementInfo.requestedVelocity ?? Vector3.Zero(), prevRequestedVelocity);
    Vector3.copyFrom(movementInfo.actualVelocity ?? Vector3.Zero(), prevActualVelocity);
    Vector3.copyFrom(movementInfo.externalVelocity ?? Vector3.Zero(), prevExternalVelocity);
    stepTime = movementInfo.stepTime;
    prevStepTime = movementInfo.previousStepTime;
  }
  time += stepTime;

  initParameters(movementInfo?.activeAvatarLocomotionSettings, movementInfo?.activeInputModifier);
  updateEngineWalk(movementInfo?.walkTarget, movementInfo?.walkThreshold);

  // If we are not in control (engine consumed a different velocity than we
  // published), resync velocity to prevActual. Also reset prevRequestedVelocity
  // so snap-to-ground is suppressed on this same tick.
  if (Vector3.distance(lastPublished, prevRequestedVelocity) > 0.1 || movementInfo?.requestedVelocity === undefined) {
    Vector3.copyFrom(prevActualVelocity, velocity);
    Vector3.copyFrom(prevActualVelocity, prevRequestedVelocity);
  }
}

// Tracks the last jumpStartHeight we observed so we can detect a new jump
// (undefined -> defined) and seek the jump clip back to 0 on its first frame.
var prevJumpStartHeight: number | undefined = undefined;
// True from touchdown until the engine reports the non-looped landing clip has
// played through. While true, keep re-requesting the landing so the engine
// holds it; once activeAnimationState shows it has completed, fall through.
var requestingLanding = false;
// Max Y reached while airborne; reset on landing. Used to gate the landing
// sound to drops of >0.5m so stepping off a small curb stays silent.
var maxUngroundedY = -Infinity;
var wasJumpingOrFalling = false;
// Mirror of the engine's currently-active scene animation state. Read in
// initFrame; consulted in selectAnimation to decide when to stop the landing.
// Exported so the debug HUD can show what the engine is actually playing.
export var activeAnimationState: AvatarAnimationState | undefined = undefined;
// Last MovementAnimation we published, exposed for the debug HUD so it can be
// compared against activeAnimationState (does the engine honor what we send?).
export var publishedAnimation: MovementAnimation | undefined = undefined;
// Last-observed playback phase of the currently-active scene animation, used to
// detect when the clip wrapped past a footstep trigger time since the previous
// frame. Keyed per src so switching clip resets tracking.
var prevSoundTrackedSrc: string | undefined = undefined;
var prevSoundTrackedTime: number = 0;

// --- Phased jump state machine ---
var jumpPhase: JumpPhase = 'none';
var prevJumpPhase: JumpPhase = 'none';
var jumpVariation: JumpVariation = 'idle';
// Chosen touchdown clip (a *_Jump_End or Hard_Landing), held across the landing.
var landingClip: string | undefined = undefined;
// True when the current landing came from a stunning drop (> stunDrop): the
// clip plays out fully since input is locked. Non-stunning landings are
// skippable/abortable by movement input.
var landingLocked = false;
// Scene time the current landing clip started, for the moving-landing blend-out.
var landingStartTime = -Infinity;
// Playback speed of the current landing clip (softLandSpeed for small drops).
var landingSpeed = 1;
// True when the current landing is a small-drop bob (sliced, see softLandTime).
var landingSoft = false;

// --- Glide turn rate ---
// Smoothed avatar turn rate (deg/s), used to pick the left/right glide lean.
// Computed each frame in applyMovement from the change in facing.
var glidePrevOrientation = 0;
export var glideTurnRate = 0;

// --- Hard-landing recovery (stun) ---
// Mirrors Unity explorer's StunCharacterSystem: movement input is suppressed
// for settings.landRecoverTime after landing a drop > settings.stunDrop.
// Tracked separately from maxUngroundedY because, like Unity, the stun
// fall-height resets continuously while gliding — a controlled glide
// touchdown only counts the drop after the glide ended, so it never stuns.
export var landRecoverUntil = -Infinity;
var stunTopY = -Infinity;

// True while the avatar is already showing a glide pose — used to blend fast
// on glide entry but slow (gliderFade) between glide poses.
var wasGlidingPose = false;

// --- Jog/run stop transition ---
// True while the one-shot stop clip is playing out before settling to idle.
var stopping = false;
// Last time (s) horizontal speed was at jog+ pace, so we can detect a recent
// fast move when the avatar comes to a halt (deceleration passes through walk
// speeds, so we can't rely on the immediately-previous frame's speed).
var lastFastMoveTime = -Infinity;
// When the current uninterrupted stretch of jog+ movement started — the stop
// clip only plays if the run lasted at least settings.jogStopMinRun.
var fastMoveStartTime = Infinity;

// True once the engine reports a non-looped clip has played to its end.
function clipFinished(src: string): boolean {
  const s = activeAnimationState;
  return s !== undefined && s.src === src && !s.loop
    && (s.loopCount >= 1 || s.playbackTime >= s.duration - 1e-3);
}

// Pick the jump clip set from take-off horizontal speed, reusing the locomotion
// tier thresholds: walk -> idle jump, jog -> jog jump, run/sprint -> run jump.
function variationForSpeed(h: number): JumpVariation {
  if (h <= settings.walkRunThreshold) return 'idle';
  if (h <= settings.sprintThreshold) return 'jog';
  return 'run';
}

// Airborne (rising/falling) jump animation. Advances the phase machine each
// frame from vertical velocity + clip-completion, and returns the phase clip.
function jumpPhaseAnimation(newJump: boolean, horizontalSpeed: number): MovementAnimation {
  const falling = velocity.y <= 0;

  // Enter / re-enter the machine: a fresh ground jump starts at 'start';
  // otherwise (passive walk-off, or resuming after a glide/double-jump ended
  // mid-air) we drop straight into the fall loop.
  if (newJump && jumpStartHeight !== undefined) {
    jumpVariation = variationForSpeed(horizontalSpeed);
    jumpPhase = 'start';
  } else if (jumpPhase === 'none') {
    jumpVariation = variationForSpeed(horizontalSpeed);
    jumpPhase = 'fall';
  }

  const set = JUMP_SETS[jumpVariation];

  // Advance the phase.
  switch (jumpPhase) {
    case 'start':
      if (falling) jumpPhase = 'mid';
      else if (clipFinished(set.start)) jumpPhase = 'rise';
      break;
    case 'rise':
      if (falling) jumpPhase = 'mid';
      break;
    case 'mid':
      if (clipFinished(set.mid)) jumpPhase = 'fall';
      break;
    // 'fall' holds until we touch down (handled in landingAnimation).
  }

  const dropSoFar = maxUngroundedY - playerPosition.y;
  const useLongFall = jumpPhase === 'fall' && dropSoFar > settings.longFallDrop;

  let src: string;
  let loop: boolean;
  switch (jumpPhase) {
    case 'start': src = set.start; loop = false; break;
    case 'rise': src = set.rise; loop = true; break;
    case 'mid': src = set.mid; loop = false; break;
    default: src = useLongFall ? CLIP_LONG_FALL : set.fall; loop = true; break;
  }

  // Seek to 0 on the first frame of a new phase so one-shots play in full.
  const phaseChanged = jumpPhase !== prevJumpPhase;
  prevJumpPhase = jumpPhase;

  // Fresh ground jump: snap into the start clip near-instantly (transJumpStart,
  // platformer-style responsiveness) and optionally skip the clip's anticipation
  // wind-up (jumpStartSkip) so the up-pose shows the moment the body launches.
  const freshStart = newJump && jumpPhase === 'start';

  return {
    src,
    speed: 1,
    loop,
    idle: false,
    transitionSeconds: freshStart ? settings.transJumpStart : settings.transAir,
    playbackTime: phaseChanged ? (freshStart ? settings.jumpStartSkip : 0) : undefined,
    sounds: newJump && jumpPhase === 'start' ? [pickRandom(JUMP_SOUNDS)] : [],
  };
}

// Touchdown animation: plays the chosen End / Hard_Landing clip once, then
// returns null to let locomotion resume. Returns null immediately if landing
// anim is disabled.
function landingAnimation(justLanded: boolean): MovementAnimation | null {
  if (settings.playLanding === 0) {
    requestingLanding = false;
    jumpPhase = 'none';
    if (justLanded) {
      if (stunTopY - playerPosition.y > settings.stunDrop) landRecoverUntil = time + settings.landRecoverTime;
      stunTopY = -Infinity;
      maxUngroundedY = -Infinity;
    }
    return null;
  }

  // Landing while moving (and not stunned) shows the touchdown briefly, then
  // blends out into locomotion after landRunBlend seconds instead of holding
  // the planted-feet clip to completion (which reads as a sliding crouch).
  // Only stunning drops (> stunDrop) play out compulsorily — there the input
  // lockout holds the player in place anyway.
  const moving = Vector3.lengthSquared(movementAxis) > 0;

  if (justLanded) {
    const drop = maxUngroundedY - playerPosition.y;
    // Every landing shows a crouch-absorb bob: small drops reuse the
    // Hard_Landing clip started partway in (softLandStart skips the deep
    // crouch) and sped up (softLandSpeed), so it reads as a quick head-bob
    // dip; big drops (> hardLandingDrop) play the clip in full from 0.
    const soft = drop <= settings.hardLandingDrop;
    landingClip = CLIP_HARD_LANDING;
    landingSoft = soft;
    landingSpeed = soft ? settings.softLandSpeed : 1;
    landingLocked = stunTopY - playerPosition.y > settings.stunDrop;
    landingStartTime = time;
    // Stun: lock movement input after big drops (Unity: JumpHeightStun=10m,
    // LongFallStunTime=0.75s). Uses the glide-aware stun tracker, so the
    // hard-landing *clip* (drop > hardLandingDrop) can play without stunning.
    if (landingLocked) landRecoverUntil = time + settings.landRecoverTime;
    stunTopY = -Infinity;
    maxUngroundedY = -Infinity;
    jumpPhase = 'none';
    prevJumpPhase = 'none';
    return {
      src: landingClip,
      speed: landingSpeed,
      loop: false,
      idle: false,
      transitionSeconds: settings.transAir,
      playbackTime: soft ? settings.softLandStart : 0,
      sounds: drop > 0.5 ? [pickRandom(LAND_SOUNDS)] : [],
    };
  }

  const clip = landingClip ?? JUMP_SETS[jumpVariation].end;
  // Moving + non-stunning: let the touchdown show for landRunBlend seconds,
  // then hand back to locomotion (which blends it out over transRun).
  if (moving && !landingLocked && time - landingStartTime >= settings.landRunBlend) {
    requestingLanding = false;
    landingClip = undefined;
    return null;
  }
  // Soft landings only show a slice of the clip (the absorb dip), then hand
  // back to idle/locomotion, which crossfades the rest out — the Hard_Landing
  // clip is too expressive to play out for a normal hop.
  if (landingSoft && !landingLocked && time - landingStartTime >= settings.softLandTime) {
    requestingLanding = false;
    landingClip = undefined;
    return null;
  }
  if (clipFinished(clip)) {
    requestingLanding = false;
    landingClip = undefined;
    return null;
  }
  return { src: clip, speed: landingSpeed, loop: false, idle: false, transitionSeconds: settings.transAir, sounds: [] };
}

// Detects whether the clip's playback time crossed any of the given trigger
// timestamps (in seconds) while playing forward between `prev` and `cur`.
// Backward motion (negative animation speed, e.g. while turning in place
// with the walk clip's speed driven by signed directional velocity) is
// ignored so we don't fire a storm of sounds as the clip scrubs back and
// forth. A genuine loop wrap is distinguished from backward play by
// requiring the apparent reverse jump to span more than half the clip.
function stepTriggered(prev: number, cur: number, duration: number, triggers: number[]): boolean {
  if (cur === prev) return false;
  const isLoopWrap = cur < prev && duration > 0 && prev - cur > duration * 0.5;
  if (cur < prev && !isLoopWrap) return false;
  for (const t of triggers) {
    if (isLoopWrap) {
      if (t > prev || t <= cur) return true;
    } else if (t > prev && t <= cur) {
      return true;
    }
  }
  return false;
}

function selectAnimation(): MovementAnimation {
  if (!isGliding) wasGlidingPose = false;
  const jumpingOrFalling = jumpStartHeight !== undefined || !grounded;
  const newJump = jumpStartHeight !== undefined && prevJumpStartHeight === undefined;
  prevJumpStartHeight = jumpStartHeight;

  if (jumpingOrFalling) {
    maxUngroundedY = Math.max(maxUngroundedY, playerPosition.y);
    // Gliding keeps resetting the stun height (Unity parity): only free-fall
    // after the glide ends counts toward the stun drop.
    stunTopY = isGliding ? playerPosition.y : Math.max(stunTopY, playerPosition.y);
  }
  // Ungrounded -> grounded transition: the frame the landing sound may fire.
  const justLanded = wasJumpingOrFalling && !jumpingOrFalling;
  wasJumpingOrFalling = jumpingOrFalling;

  const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  if (horizontalSpeed > settings.walkRunThreshold) {
    // Track when this stretch of jog+ movement began, so the stop clip can
    // require a sustained run — a quick reposition tap shouldn't foot-plant.
    if (time - lastFastMoveTime > 0.25) fastMoveStartTime = time;
    lastFastMoveTime = time;
  }

  if (jumpingOrFalling) {
    requestingLanding = true;
    stopping = false;

    if (isGliding) {
      jumpPhase = 'none';
      // Directional glide pose driven by how the avatar is actually turning
      // (smoothed turn rate, deg/s) and how fast it's moving:
      //   turning left/right -> lean left/right; fast & straight -> forward
      //   (pitched); slow -> idle (upright / lean-back). Sign of left vs right
      //   may need flipping depending on the avatar's yaw convention.
      let src: string;
      if (glideTurnRate > settings.glideLeanRate) src = GLIDE_AVATAR.right;
      else if (glideTurnRate < -settings.glideLeanRate) src = GLIDE_AVATAR.left;
      else if (horizontalSpeed > settings.glideForwardSpeed) src = GLIDE_AVATAR.forward;
      else src = GLIDE_AVATAR.idle;
      // Entering the glide blends fast (transAir) so the pose keeps up with
      // the glider deploying; once gliding, pose-to-pose changes crossfade at
      // gliderFade — same time as the glider prop's blend (glider.ts) — so
      // avatar and glider bank together and the hands stay on the handles.
      const enteringGlide = !wasGlidingPose;
      wasGlidingPose = true;
      return {
        src,
        speed: 1,
        loop: true,
        idle: false,
        transitionSeconds: enteringGlide ? settings.transAir : settings.gliderFade,
        sounds: [],
      };
    }

    if (isDoubleJump) {
      jumpPhase = 'none';
      // Use the variation captured by the first jump (persisted in jumpVariation).
      return {
        src: DOUBLE_JUMP[jumpVariation],
        speed: 1,
        loop: false,
        idle: false,
        transitionSeconds: settings.transAir,
        sounds: newJump ? [pickRandom(JUMP_SOUNDS)] : [],
      };
    }

    // Phased jump/fall: Start -> Rise -> Mid -> Fall (-> End on landing below).
    return jumpPhaseAnimation(newJump, horizontalSpeed);
  }

  // Touchdown: play the End / Hard_Landing clip once, then fall through.
  if (requestingLanding) {
    const landing = landingAnimation(justLanded);
    if (landing !== null) return landing;
  }

  // Directional (signed) forward speed — matches engine's damped_velocity projected
  // onto gt.forward(); lets the walk/run anim play reversed when moving backward.
  const forward = Vector3.rotate(Vector3.Forward(), playerRotation);
  const directionalVelLen = velocity.x * forward.x + velocity.z * forward.z;

  // Locomotion tiers only while there's actual movement input. With no keys
  // held, the residual decelerating velocity (jog -> 0 passes through walk
  // speeds for a few frames) would otherwise flash the walk clip — the
  // "residual walking" shuffle — instead of going straight to stop/idle.
  const hasMoveInput = Vector3.lengthSquared(movementAxis) > 0;
  if (horizontalSpeed > settings.moveGate && hasMoveInput) {
    stopping = false; // moving again — cancel any pending stop
    // Tier 1: walk
    if (horizontalSpeed <= settings.walkRunThreshold) {
      return {
        src: CLIP_WALK,
        speed: directionalVelLen / settings.walkPlaybackDiv,
        loop: true,
        idle: false,
        transitionSeconds: settings.transWalk,
        sounds: footstepsFor(CLIP_WALK, WALK_STEP_TIMES, WALK_STEP_SOUNDS),
      };
    }
    // Tier 2: jog (the default movement speed)
    if (horizontalSpeed <= settings.sprintThreshold) {
      return {
        src: CLIP_JOG,
        speed: directionalVelLen / settings.jogPlaybackDiv,
        loop: true,
        idle: false,
        transitionSeconds: settings.transRun,
        sounds: footstepsFor(CLIP_JOG, RUN_STEP_TIMES, RUN_STEP_SOUNDS),
      };
    }
    // Tier 3: run (sprint)
    return {
      src: CLIP_RUN,
      speed: directionalVelLen / settings.sprintPlaybackDiv,
      loop: true,
      idle: false,
      transitionSeconds: settings.transRun,
      sounds: footstepsFor(CLIP_RUN, RUN_STEP_TIMES, RUN_STEP_SOUNDS),
    };
  }

  // Jog/run stop: if we halted within a moment of moving at jog+ pace, play the
  // one-shot stop clip before settling into idle (Unity's Jog_Stop behaviour).
  if (settings.useJogStop !== 0) {
    let newStop = false;
    // Only foot-plant after a sustained run (jogStopMinRun) — brief taps and
    // small repositions settle straight into idle instead.
    const ranLongEnough = lastFastMoveTime - fastMoveStartTime >= settings.jogStopMinRun;
    if (!stopping && time - lastFastMoveTime < 0.25 && ranLongEnough) {
      stopping = true;
      newStop = true;
    }
    if (stopping) {
      if (clipFinished(CLIP_JOG_STOP)) {
        stopping = false;
      } else {
        return {
          src: CLIP_JOG_STOP,
          speed: settings.jogStopSpeed,
          loop: false,
          idle: false,
          transitionSeconds: settings.transWalk,
          // Skip past the clip's opening step if tuned (jogStopStart > 0).
          ...(newStop ? { playbackTime: settings.jogStopStart } : {}),
          sounds: [],
        };
      }
    }
  }

  return {
    src: CLIP_IDLE,
    speed: 1.0,
    loop: true,
    idle: true,
    transitionSeconds: settings.transIdle,
    sounds: [],
  };
}

// Detects a footstep trigger crossing for the currently-playing clip. Returns a
// single-frame sounds list (or empty) so remote clients see each step as an
// independent transition.
function footstepsFor(src: string, triggers: number[], pool: string[]): string[] {
  const s = activeAnimationState;
  if (s === undefined || s.src !== src) {
    prevSoundTrackedSrc = src;
    prevSoundTrackedTime = 0;
    return [];
  }
  const cur = s.playbackTime;
  const prev = prevSoundTrackedSrc === src ? prevSoundTrackedTime : cur;
  prevSoundTrackedSrc = src;
  prevSoundTrackedTime = cur;
  return stepTriggered(prev, cur, s.duration, triggers) ? [pickRandom(pool)] : [];
}

function writeMovement() {
  const animation = selectAnimation();
  publishedAnimation = animation;
  AvatarMovement.createOrReplace(engine.PlayerEntity, {
    velocity,
    orientation: -orientation,
    groundDirection: Vector3.Down(),
    walkSuccess: consumeWalkResult(),
    animation,
  })

  Vector3.copyFrom(velocity, lastPublished);
}

function applyMovement() {
  dampVelocity();
  updateVerticalVelocity();
  updateHorizontalVelocity();

  // Track smoothed turn rate (deg/s) from the change in facing, for glide lean.
  const turnDelta = relativeDegrees(0, orientation - glidePrevOrientation);
  glidePrevOrientation = orientation;
  const turnAlpha = 1 - Math.exp(-stepTime / 0.2);
  glideTurnRate += (turnDelta / Math.max(stepTime, 1e-3) - glideTurnRate) * turnAlpha;

  // External forces are added last so damping and horizontal stop-decel
  // can't zero small impulses before they have any visible effect. Damping
  // on subsequent frames still decays the persisted external contribution.
  velocity.x += prevExternalVelocity.x;
  velocity.y += prevExternalVelocity.y;
  velocity.z += prevExternalVelocity.z;

  const speed = Vector3.length(velocity);
  if (speed > MAX_SPEED) {
    Vector3.scaleToRef(velocity, MAX_SPEED / speed, velocity);
  }

  if (Vector3.length(velocity) < 0.01 || Number.isNaN(Vector3.length(velocity))) {
    velocity = Vector3.Zero();
  }
  Vector3.normalizeToRef(velocity, velocityNorm);
  velocityLength = Vector3.length(velocity);
  writeMovement();
}
