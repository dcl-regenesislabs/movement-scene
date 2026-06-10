// Renders the glider prop attached to gliding avatars. The 8 separate
// Gliding_Prop*.glb were merged into one Glider.glb (all clips, one model) by
// source/merge-glider.mjs, so we switch Open/Forward/Close on a single loaded
// model via the Animator — no GltfContainer reload. The Animator is created ONCE
// with every state; switching just toggles which state is playing (replacing the
// whole Animator each switch corrupted the skeleton on replay).
//
// Networking: only AvatarMovement data travels between clients — scene-spawned
// props don't. So every client renders gliders locally for ALL avatars: the
// local player's is driven by isGliding/glideTurnRate directly (zero latency),
// and remote players' are driven by their received AvatarMovementInfo
// activeAnimationState (gliding <=> their avatar clip is a Gliding_Avatar*).
import { Animator, AvatarMovementInfo, engine, Entity, GltfContainer, PlayerIdentityData, Transform, VisibilityComponent } from '@dcl/sdk/ecs';
import { isGliding } from './vertical';
import { settings } from './settings';
import { glideTurnRate } from './index';

const GLIDER_SRC = 'assets/animations/Glider.glb';
const CLIP_OPEN = 'Glider_Open';
const CLIP_FORWARD = 'Glider_Forward';
const CLIP_LEFT = 'Glider_TurnLeft';
const CLIP_RIGHT = 'Glider_TurnRight';
const CLIP_CLOSE = 'Glider_Close';
const OPEN_DURATION = 0.5;
const CLOSE_DURATION = 0.5;
const GLIDE_LOOPS = [CLIP_FORWARD, CLIP_LEFT, CLIP_RIGHT];

type GliderState = 'hidden' | 'opening' | 'gliding' | 'closing';

// One glider prop + its deploy state machine, attached to one avatar entity.
type GliderRig = {
  entity: Entity;
  state: GliderState;
  timer: number;
  currentClip: string;
};

// avatar entity -> its glider rig (local player's keyed by engine.PlayerEntity)
const rigs = new Map<Entity, GliderRig>();

function createRig(parent: Entity): GliderRig {
  const entity = engine.addEntity();
  Transform.create(entity, { parent });
  GltfContainer.create(entity, {
    src: GLIDER_SRC,
    visibleMeshesCollisionMask: 0,
    invisibleMeshesCollisionMask: 0,
  });
  // Define every state once; none playing initially.
  Animator.create(entity, {
    states: [
      { clip: CLIP_OPEN, playing: false, loop: false, shouldReset: true },
      { clip: CLIP_FORWARD, playing: false, loop: true },
      { clip: CLIP_LEFT, playing: false, loop: true },
      { clip: CLIP_RIGHT, playing: false, loop: true },
      { clip: CLIP_CLOSE, playing: false, loop: false, shouldReset: true },
    ],
  });
  VisibilityComponent.create(entity, { visible: false });
  const rig: GliderRig = { entity, state: 'hidden', timer: 0, currentClip: '' };
  rigs.set(parent, rig);
  return rig;
}

// Toggle which pre-defined state plays; restart the newly-selected clip from
// frame 0 via shouldReset. No-op if already on that clip.
function playClip(rig: GliderRig, clip: string, loop: boolean, speed: number) {
  if (rig.currentClip === clip) return;
  rig.currentClip = clip;
  const anim = Animator.getMutable(rig.entity);
  for (const st of anim.states) {
    const on = st.clip === clip;
    st.playing = on;
    st.loop = on ? loop : st.loop;
    st.speed = on ? speed : st.speed;
    st.shouldReset = on;
  }
}

// Same threshold logic as the avatar's glide pose pick (index.ts), so the
// glider banks together with the avatar and the hands stay on the handles.
function localGlidingClip(): string {
  if (glideTurnRate > settings.glideLeanRate) return CLIP_RIGHT;
  if (glideTurnRate < -settings.glideLeanRate) return CLIP_LEFT;
  return CLIP_FORWARD;
}

// Map a remote avatar's published glide clip to the matching glider pose.
function remoteGlidingClip(avatarClipSrc: string): string {
  if (avatarClipSrc.includes('Gliding_AvatarLeft')) return CLIP_LEFT;
  if (avatarClipSrc.includes('Gliding_AvatarRight')) return CLIP_RIGHT;
  return CLIP_FORWARD; // Forward and Idle both ride the forward glider pose
}

// Crossfade between the looping glide poses: all three stay playing while
// gliding, and per-state weights drift toward the target clip over
// settings.gliderFade seconds, instead of the hard switch playClip does.
// `snap` jumps weights instantly (used on glide entry).
function blendGlideLoops(rig: GliderRig, dt: number, target: string, snap = false) {
  const anim = Animator.getMutable(rig.entity);
  const fade = Math.max(0.01, settings.gliderFade);
  // Stop the one-shot open/close clips so a finished clip's held end-pose
  // doesn't blend against the loops.
  for (const st of anim.states) if (!GLIDE_LOOPS.includes(st.clip)) st.playing = false;
  const states = anim.states.filter((st) => GLIDE_LOOPS.includes(st.clip));
  let sum = 0;
  for (const st of states) {
    const goal = st.clip === target ? 1 : 0;
    const w = snap ? goal : (st.weight ?? (goal ? 1 : 0)) + Math.sign(goal - (st.weight ?? 0)) * Math.min(Math.abs(goal - (st.weight ?? 0)), dt / fade);
    st.weight = w;
    sum += w;
  }
  for (const st of states) {
    st.weight = sum > 0 ? (st.weight ?? 0) / sum : st.clip === target ? 1 : 0;
    st.playing = (st.weight ?? 0) > 0.001;
    st.loop = true;
    st.speed = 1;
  }
  // Mark the blend as the active "clip" so a later playClip(CLIP_CLOSE) isn't
  // a no-op and properly stops all three loops.
  rig.currentClip = 'glide-blend:' + target;
}

// Advance one rig's deploy/stow state machine toward `gliding`, banking toward
// `targetClip` while deployed.
function updateRig(rig: GliderRig, dt: number, gliding: boolean, targetClip: string) {
  const deploy = Math.max(0.1, settings.gliderOpenSpeed); // clip speed multiplier
  switch (rig.state) {
    case 'hidden':
      if (gliding) {
        VisibilityComponent.getMutable(rig.entity).visible = true;
        playClip(rig, CLIP_OPEN, false, deploy); rig.timer = 0; rig.state = 'opening';
      }
      break;
    case 'opening':
      rig.timer += dt;
      if (!gliding) { playClip(rig, CLIP_CLOSE, false, deploy); rig.timer = 0; rig.state = 'closing'; }
      else if (rig.timer >= OPEN_DURATION / deploy) { blendGlideLoops(rig, 0, targetClip, true); rig.state = 'gliding'; }
      break;
    case 'gliding':
      if (!gliding) { playClip(rig, CLIP_CLOSE, false, deploy); rig.timer = 0; rig.state = 'closing'; }
      else blendGlideLoops(rig, dt, targetClip);
      break;
    case 'closing':
      rig.timer += dt;
      if (gliding) { playClip(rig, CLIP_OPEN, false, deploy); rig.timer = 0; rig.state = 'opening'; }
      else if (rig.timer >= CLOSE_DURATION / deploy) {
        VisibilityComponent.getMutable(rig.entity).visible = false;
        rig.state = 'hidden';
      }
      break;
  }
}

export function initGlider() {
  createRig(engine.PlayerEntity);
  engine.addSystem(updateGliders);
}

function updateGliders(dt: number) {
  const seen = new Set<Entity>();

  // Local player: driven by the live isGliding/glideTurnRate state — no
  // round-trip through the published animation, so it reacts the same frame.
  seen.add(engine.PlayerEntity);
  const local = rigs.get(engine.PlayerEntity);
  if (local !== undefined) updateRig(local, dt, isGliding, localGlidingClip());

  // Remote avatars: enumerate via PlayerIdentityData (the standard way player
  // entities are exposed to scenes), then read the engine's mirror of each
  // avatar's playing movement clip from AvatarMovementInfo on that entity.
  // A remote player is gliding exactly when their clip is a Gliding_Avatar*.
  for (const [avatar] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (avatar === engine.PlayerEntity) continue;
    seen.add(avatar);
    const src = AvatarMovementInfo.getOrNull(avatar)?.activeAnimationState?.src ?? '';
    const gliding = src.includes('Gliding_Avatar');
    const rig = rigs.get(avatar) ?? createRig(avatar);
    updateRig(rig, dt, gliding, remoteGlidingClip(src));
  }

  debugRemoteGliders(dt);

  // Drop rigs for avatars that left the scene.
  dropStaleRigs(seen);
}

// Periodic console diagnostics for multiplayer testing: lists every remote
// avatar entity found and what movement clip the engine reports for it, so a
// missing glider can be traced (no avatars found vs. no animation data).
let debugTimer = 0;
function debugRemoteGliders(dt: number) {
  debugTimer += dt;
  if (debugTimer < 5) return;
  debugTimer = 0;
  let count = 0;
  for (const [avatar, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (avatar === engine.PlayerEntity) continue;
    count++;
    const info = AvatarMovementInfo.getOrNull(avatar);
    const src = info?.activeAnimationState?.src;
    console.log(`[glider] remote avatar ${identity.address} entity=${avatar} movementInfo=${info !== null} clip=${src ?? '(none)'} rigState=${rigs.get(avatar)?.state ?? 'no-rig'}`);
  }
  if (count === 0) console.log('[glider] no remote avatars found via PlayerIdentityData');
}

function dropStaleRigs(seen: Set<Entity>) {
  for (const [avatar, rig] of rigs) {
    if (!seen.has(avatar)) {
      engine.removeEntity(rig.entity);
      rigs.delete(avatar);
    }
  }
}
