# Claude Code context — movement scene

DCL SDK7 portable movement/animation scene. `npm install && npm start`, preview
at localhost:8000 (or as a portable in the Bevy web client — see CHANGES.md
"How to test"). History of the 2026-06 fine-tuning pass: CHANGES.md →
"Tuning pass (2026-06-10)". PR: dcl-regenesislabs/movement-scene#2.

## Environment gotcha

`@dcl/sdk-commands`'s file watcher watches `node_modules`; on macOS, fsevents
noise causes an endless rebuild → hot-reload loop ("scene keeps refreshing").
After every `npm install`, re-add `'**/node_modules/**', '**/bin/**'` to the
chokidar `ignored` array in
`node_modules/@dcl/sdk-commands/dist/logic/bundle.js` (~line 242).

## Architecture notes (hard-won, don't rediscover)

- **Networking**: only `AvatarMovement` data crosses between clients. Scene
  props (glider, dust, etc.) are NOT networked — each client must render them
  locally for every avatar. src/glider.ts does this: local player from live
  glide state, remote players by reading
  `AvatarMovementInfo.activeAnimationState.src` for `Gliding_Avatar*` clips on
  entities found via `PlayerIdentityData`. Remote glider visibility is STILL
  BROKEN — a `[glider]` console diagnostic (every 5s) reports each remote
  avatar's entity/movement-info/clip to identify why; get those lines from a
  two-client test before changing anything.
- **Unity reference**: behavior parity questions are answered by reading
  `decentraland/unity-explorer`, `Explorer/Assets/DCL/Character/CharacterMotion`
  (sparse git clone works). Already mined: StunCharacterSystem (stun = drop >
  JumpHeightStun 10m, lasts LongFallStunTime 0.75s, fall tracker resets while
  gliding), AnimationStatesLogic (glide lean = continuous smoothed
  velocity·right dot — GlideBlendValue), AnimationMovementBlendLogic
  (animation driven by input intent, decoupled from raw velocity).
- **Hard_Landing.glb anatomy** (1.0s, hips Y): 0–0.17 impact drop, 0.17–0.47
  static deep hold (avoid starting slices here), 0.5–0.67 sinks to lowest,
  0.67–1.0 recovery rise. The soft-landing bob slices 0.6→1.0.
- Asset surgery tooling lives in `source/` (`merge-glider.mjs`,
  `strip-meshes.mjs`); meshes embedded in animation glbs DO render in the
  engine (that's why avatar clips are mesh-stripped).

## Active proposal (waiting on engine answers)

Team wants to **embed the glider mesh into the `Gliding_Avatar*.glb` player
animation clips** (glider then networks for free via the animation src; the
remote-rig code in glider.ts gets deleted), paired with an engine change making
`AvatarMovement.orientation` a **quaternion** instead of a yaw angle.

Agreed buildable with the `source/` tooling. Two blocking questions sent to the
engine dev:
1. Does a mesh inside a movement-animation GLB render only while its clip
   plays, or whenever the GLB is loaded? And do crossfades between two glide
   clips show two gliders mid-blend?
2. With quaternion orientation, does the scene stay authority over it during
   glide?

If both answers are favorable: build the merged GLBs, then use the quaternion
for continuous procedural banking (port Unity's GlideBlendValue), replacing the
discrete left/right lean clips — top remaining "feel" gap vs Unity.

## Other TODO

See CHANGES.md → "Known limitations / TODO" (remote landing smoothness,
elevator parent-attach, Gliding_Start/End + AFK/Slide clips, footstep timings,
strip debug tooling for production).
