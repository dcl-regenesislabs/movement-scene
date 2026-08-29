// Stage 2 of the glider networking work: embed the glider model + its glide clip
// into the avatar gliding-animation GLBs, so the glider renders (and networks) for
// free via the scene-driven movement animation — see the engine's `_Prop`/prop_scene
// support (collectibles/src/emotes.rs, avatar/src/animate.rs). The merged GLB carries:
//   - the avatar skeleton clip, renamed to end with `_Avatar` (engine: avatar_animation)
//   - the glider model (mesh + skin) in the default scene (engine: prop_scene)
//   - one glider clip, renamed to contain `_Prop` (engine: prop_anim)
// Inputs are the pristine mesh-stripped avatar clips + Glider.glb; outputs are *Rig.glb
// so this stays re-runnable. Run from project root: node source/merge-glider-into-avatar.mjs
import { NodeIO } from '@gltf-transform/core';
import { mergeDocuments } from '@gltf-transform/functions';

const io = new NodeIO();
const dir = '../assets/animations';
const PROP_ROOT = 'Armature_Prop'; // glider skeleton root node in Glider.glb

const jobs = [
  // Steady glide: forward (fast) / idle (slow) both carry the same open-glider pose so a
  // forward<->idle swap doesn't move the prop.
  { src: 'Gliding_AvatarForward', out: 'Gliding_AvatarForwardRig', gliderClip: 'Glider_Forward' },
  { src: 'Gliding_AvatarIdle',    out: 'Gliding_AvatarIdleRig',    gliderClip: 'Glider_Forward' },
  // Deploy / stow: the avatar Start/End clips carry the glider open/close so the prop
  // deploys and stows with the body (replaces the old glider.ts prop state machine).
  // propSpeed 2.1: matches the old settings.gliderOpenSpeed, so the glider opens/closes in
  // OPEN/CLOSE_DURATION (0.5s) / 2.1 ~= 0.238s — the same time the old prop rig stopped at —
  // without changing the avatar clip speed. Keep in sync with GLIDER_PROP_SPEED in index.ts.
  { src: 'Gliding_AvatarStart',   out: 'Gliding_AvatarStartRig',   gliderClip: 'Glider_Open',  propSpeed: 2.1 },
  { src: 'Gliding_AvatarEnd',     out: 'Gliding_AvatarEndRig',     gliderClip: 'Glider_Close', propSpeed: 2.1 },
  // Landing while still gliding: a copy of the landing clip with the glider close
  // embedded, so the glider stows as the avatar lands (the stow can't be a separate
  // clip here — it has to play concurrently with the landing).
  { src: 'Hard_Landing',          out: 'Hard_Landing_GliderRig',   gliderClip: 'Glider_Close', propSpeed: 2.1 },
];

for (const job of jobs) {
  const avatar = await io.read(`${dir}/${job.src}.glb`);
  const glider = await io.read(`${dir}/Glider.glb`);
  const root = avatar.getRoot();

  // Name the avatar clip so the engine picks it as the body animation.
  const avatarAnim = root.listAnimations()[0];
  avatarAnim.setName(`${job.src}_Avatar`);

  const avatarScene = root.getDefaultScene() ?? root.listScenes()[0];

  // Pull in the glider model, skin, mesh and all its clips.
  mergeDocuments(avatar, glider);

  // Move the glider root into the avatar's scene; drop the glider's own (now-extra) scene.
  const propRoot = root.listNodes().find((n) => n.getName() === PROP_ROOT);
  if (!propRoot) throw new Error(`${job.src}: '${PROP_ROOT}' not found after merge`);
  for (const scene of root.listScenes()) {
    if (scene === avatarScene) continue;
    if (scene.listChildren().includes(propRoot)) scene.removeChild(propRoot);
    scene.dispose();
  }
  avatarScene.addChild(propRoot);
  root.setDefaultScene(avatarScene);

  // Keep only the chosen glider clip (renamed to a `_Prop` name); discard the rest.
  let propAnim = null;
  for (const anim of root.listAnimations()) {
    if (anim === avatarAnim) continue;
    if (anim.getName() === job.gliderClip) {
      anim.setName(`${job.gliderClip}_Prop`);
      propAnim = anim;
    } else {
      anim.dispose();
    }
  }

  // Optionally speed up the glider (prop) clip without touching the avatar clip, by
  // compressing the prop clip's keyframe times. The engine plays both clips at the same
  // playback speed, so this is the only way to make the glider open/close faster than the
  // body motion. Scale each unique input (time) accessor once (samplers may share one).
  if (propAnim && job.propSpeed && job.propSpeed !== 1) {
    const factor = 1 / job.propSpeed;
    const scaled = new Set();
    for (const ch of propAnim.listChannels()) {
      const input = ch.getSampler().getInput();
      if (input && !scaled.has(input)) {
        scaled.add(input);
        input.setArray(Float32Array.from(input.getArray(), (t) => t * factor));
      }
    }
  }

  // GLB needs a single binary buffer.
  const buffers = root.listBuffers();
  const main = buffers[0];
  for (const acc of root.listAccessors()) acc.setBuffer(main);
  for (let i = 1; i < buffers.length; i++) buffers[i].dispose();

  await io.write(`${dir}/${job.out}.glb`, avatar);
  console.log(`wrote ${job.out}.glb`);
}
