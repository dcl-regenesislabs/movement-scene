# Movement scene — animation overhaul

> Status: **work in progress.** The movement/animation feel is dramatically
> closer to the Unity client, but several items still need polish/tuning (see
> [Known limitations](#known-limitations--todo)).

This branch reworks the portable movement scene's avatar **animation** system to
match the Decentraland **Unity client**, where the original was lacking — locomotion
phasing, per-gait jumps, landing, and gliding. Movement *physics* is largely
unchanged; this is about what the avatar (and remote avatars) actually *play*.

## Highlights

- **3-tier locomotion** — real `Walk` / `Jog` / `Run` clips selected by speed
  (previously walk + run only, so jog and sprint looked identical).
- **Phased jump state machine** — `Start → Rise → Mid → Fall → End` per take-off
  gait (idle / jog / run jumps), replacing the single-clip jump that caused the
  awkward forward-lean. Adds `Hard_Landing` (big drops) and `Long_Fall_Loop`.
- **Per-gait double jumps** — `Double_Jump_Base / Jog / Run`.
- **Jog stop** — plays `Jog_Stop` when decelerating to a halt.
- **Gliding** — directional avatar poses (forward / lean-back idle / bank
  left-right by turn rate) **plus a rendered glider prop** that deploys (opens)
  and stows (closes), attached to the avatar. Glide now faces its direction of
  travel (banks/curves) instead of snapping to face input.
- **In-scene live-tuning panel** (toggle top-right) for dialing feel without a
  rebuild — speeds, blend times, jump drop thresholds, glide tuning.
- **20×20 parcel scene** (was 1×1) for testing long-distance movement.

## New animation assets — `assets/animations/`

Mesh-free, single-clip glbs on the DCL `Avatar_*` rig (skeleton + animation only;
the embedded character meshes from the source exports were stripped — see
[Asset tooling](#asset-tooling)). Provided by the Regenesis Labs team from a
Blender source file.

- Locomotion: `Idle`, `Walk`, `Jog`, `Run`, `Jog_Stop`, `Slide`*
- Base jump (= standing/idle jump): `Jump_Start/Rise_Loop/Mid/Fall_Loop/End`,
  `Long_Fall_Loop`, `Hard_Landing`
- Jog/Run jumps: `Jog_Jump_*`, `Run_Jump_*`
- Double jumps: `DoubleJump_Base2/Jog2/Run2` (+ `_Right`*)
- Glide avatar poses: `Gliding_Avatar{Forward,Idle,Left,Right}` (+ `Start/End`*)
- Glider prop: `Glider.glb` — the 8 `Gliding_Prop*` exports merged into one model
  with all clips (Open/Close/Forward/Idle/Turn*) so it can be animated without
  reloading.
- AFK*: `AFK_Start/Loop/Action/End`

`*` = present but not yet wired (staged for upcoming polish).

## Code changes — `src/`

| File | Change |
|------|--------|
| `index.ts` | Animation selection rewritten: 3-tier locomotion, phased-jump state machine (`jumpPhaseAnimation` / `landingAnimation`), per-gait double jumps, directional glide poses, Jog_Stop, glide turn-rate tracking. Debug HUD + clip maps. |
| `glider.ts` *(new)* | Glider prop rigs — one per avatar (local + remote), deploy/glide/stow Animator state machine, turn-clip banking with weight crossfade, remote glide detection via `AvatarMovementInfo`. |
| `testTower.ts` *(new)* | Staircase / launch deck / elevator test structure for long glides. |
| `settings.ts` *(new)* | Runtime-mutable tuning values + metadata that drives the panel. |
| `ui.tsx` *(new)* | The in-scene live-tuning panel (`@dcl/sdk/react-ecs`). |
| `horizontal.ts` | While gliding, face the direction of travel (momentum) instead of raw input, so the glider banks/curves and back-press leans rather than spins 180°. Movement input suppressed during landing stun. |
| `parameters.ts` | Speeds/jump-heights can come from the tuner (`forceLocalSpeeds`). |
| `scene.json` | Expanded to a 20×20 parcel grid. |

Removed the now-unused original clips from `assets/` root (replaced by the
`assets/animations/` set).

## Live-tuning panel

Click **TUNE** (top-right) to open. Per-row `−`/`+` steppers and a type-in field;
**RESET DEFAULTS** for A/B comparison; **LOG VALUES** dumps current numbers to the
browser console. Slimmed to the actively-tuned knobs: **SPEEDS**, **BLENDS**,
**JUMP** (drop thresholds), **GLIDE** (lean rate, forward-pose speed, glider
deploy speed). Other tuned values live in `settings.ts` and can be re-exposed on
request. The panel is debug tooling — strip it for a production build if desired.

## Asset tooling — `source/`

One-time Node scripts (require `npm i -D @gltf-transform/core @gltf-transform/functions`):

- `strip-meshes.mjs` — strips the embedded character mesh from animation glbs,
  leaving skeleton + animation (the exports rendered a stray mesh otherwise;
  19.6 MB → 4.5 MB).
- `merge-glider.mjs` — merges the 8 `Gliding_Prop*` glbs into one `Glider.glb`
  (one model, all clips) by retargeting animation channels to the shared
  skeleton by node name.

The Blender source (`*.blend`) is git-ignored (too large for git — use LFS or
external storage).

## How to test

Run `npm i` then `npm start`, and open the served scene as a portable in the Bevy
web client, e.g.:

```
https://decentraland.zone/bevy-web/?portables=http%3A%2F%2Flocalhost%3A8000
```

Then exercise: walk / jog / sprint, jump from each gait, big-drop landings, double
jumps, and gliding (bank left/right, push back to lean, deploy/stow).

## Tuning pass (2026-06-10)

A feel-polish session against the Unity client's actual source
(`decentraland/unity-explorer`, `Explorer/Assets/DCL/Character/CharacterMotion`),
which was consulted directly for thresholds and behaviour parity.

### Gliding

- **Glider banks with the avatar** — the prop now plays its own
  `Glider_TurnLeft/TurnRight` clips (they were in `Glider.glb` but unused),
  picked with the same turn-rate threshold as the avatar lean, so hands stay on
  the handles.
- **Pose crossfading** — the three glide loops (forward/left/right) blend by
  Animator weights (normalized to sum 1; fully-faded clips stop playing, which
  also fixed a stretched-polygon glitch from partial-weight skeleton blends)
  over a new `gliderFade` time (default 0.5s, panel: "glider lean blend").
  Avatar glide pose transitions use the same time, except glide *entry* which
  blends fast (`transAir`) so the deploy stays snappy.

### Landing / stun (Unity parity)

- **Landing stun** — drops > `stunDrop` (10m, Unity's `JumpHeightStun`) lock
  movement input for `landRecoverTime` (0.75s, Unity's `LongFallStunTime`).
  Like Unity, the stun fall-height tracker resets continuously while gliding, so
  controlled glide touchdowns never stun.
- **Landing is no longer an exclusive state** — landing while holding movement
  shows the touchdown for `landRunBlend` (0.2s) then folds into locomotion,
  killing the planted-feet slide. Only stunning drops play the clip out in full.
- **Soft-landing bob** — every landing (even small hops) plays a *slice* of
  `Hard_Landing`: clip-time 0.6→1.0 (the dip-into-recovery arc, mapped from the
  clip's hips curve; 0–0.47s is a long static crouch hold to avoid) at 1.5×
  speed for ~0.27s, reading as a natural absorb-bob. Tunables: `softLandStart`,
  `softLandSpeed`, `softLandTime`.

### Locomotion / jump feel

- **Locomotion clips require input** — clip choice no longer keys off raw speed
  alone, so decelerating through walk speeds after releasing keys can't flash
  the walk clip ("residual walking"). Matches Unity's intent-driven blending.
- **Jog_Stop polish** — starts at `jogStopStart` (0.1s, tuned in testing) to
  skip the clip's opening shuffle-step; `jogStopSpeed` tunable; and only plays
  after a *sustained* run (`jogStopMinRun`, 0.7s) so reposition taps settle
  straight to idle.
- **Jump start responsiveness** — fresh jumps blend into the start clip over
  `transJumpStart` (0.03s instead of 0.1s) with an optional `jumpStartSkip`
  wind-up skip, platformer-style. Physics was already same-frame; the lag was
  purely the blend-in.

### Networking (in progress)

- Glider props are rendered locally per-client for every avatar: the local
  player from live glide state (zero latency), remote players by watching their
  received `AvatarMovementInfo.activeAnimationState` for `Gliding_Avatar*`
  clips (only `AvatarMovement` data crosses the wire — scene props don't).
  Remote discovery enumerates `PlayerIdentityData`. A `[glider]` console
  diagnostic logs every remote avatar + its reported clip every 5s.

### Test scaffolding

- `testTower.ts` — 100-step zig-zag staircase to 150m (1.5m jumpable rises,
  overlapping platforms), a 16×16 launch deck, and an auto-cycling elevator
  platform (ground ↔ top, 8 m/s), around x=40 z=40, for long-glide testing.
- Patched the `sdk-commands` file watcher (in `node_modules` — **reapply after
  `npm install`**) to ignore `node_modules`/`bin`: macOS fsevents noise was
  triggering endless rebuild→hot-reload cycles ("scene keeps refreshing").
  Patch: add `'**/node_modules/**', '**/bin/**'` to the chokidar `ignored` list
  in `@dcl/sdk-commands/dist/logic/bundle.js`.

### New tuning-panel rows

BLENDS: jog stop clip/speed/start/min-run · JUMP: jump start blend/skip,
stun drop, stun time, land→run blend, soft land start/speed/time ·
GLIDE: glider lean blend.

## Known limitations / TODO

- **Fix glider visibility over the network** — remote gliders still not
  showing in multiplayer tests. Next step: read the `[glider]` console
  diagnostics in a two-client session to see whether remote avatars are
  missing `PlayerIdentityData`, missing `AvatarMovementInfo`, or reporting
  unexpected clip paths — then pick the right glide signal accordingly.
- Remote landing/animation smoothness: the landing is now several quick clip
  changes (slice + seek + blend-out within ~0.3s); network jitter can swallow
  the short beats on the receiving side. May need a simplified, longer-lived
  published animation for landings.
- Glide lean is still threshold-based (3 discrete poses). Unity drives a
  *continuous* blend (velocity·right dot, smoothed — `GlideAnimBlendSpeed` /
  `GlideAnimMaxAngle`); porting that would make banking fully proportional.
- Elevator platform may not "carry" the avatar in all clients (no
  parent-attach yet).
- Wire the `Gliding_Start/End` avatar transition poses and the
  staged-but-unused clips: `AFK_*`, `Slide`, `DoubleJump_*_Right`.
- Recalibrate footstep sound trigger timings for the new clips.
- Glide steering still rotates somewhat snappily (turn speed 200°/s) — may want
  softening for a more Unity-like bank.
- Production: strip the debug tuning panel + `[glider]` diagnostics + test
  tower; consider Git LFS for the `.blend`.
