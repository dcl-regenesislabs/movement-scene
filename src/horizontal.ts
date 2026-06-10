import { engine, InputAction, inputSystem, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math';
import { GLIDE_HORIZONTAL_SPEED, GLIDER_TURN_MAX_DEGREES_SEC, HORIZONTAL_ACCEL_TIME_AIR, HORIZONTAL_ACCEL_TIME_GROUND, HORIZONTAL_DAMP_TIME_AIR, HORIZONTAL_DAMP_TIME_GROUND, HORIZONTAL_STOP_DECEL_AIR, HORIZONTAL_STOP_DECEL_GROUND, TURN_FULL_TIME, TURN_MAX_DEGREES_SEC, VEC3_HORIZONTAL_MASK, VEC3_UP, VEC3_ZERO, VERTICAL_STOP_DECEL } from './constants';
import { landRecoverUntil, playerRotation, stepTime, time, velocity } from '.';
import { grounded } from './ground';
import { disableOrientation, jogSpeed, sprintSpeed, walkSpeed } from './parameters';
import { isGliding } from './vertical';
import { getWalkAxis } from './walk';
import { settings } from './settings';

export var orientation = 0;
export var movementAxis = Vector3.Zero();

export function updateHorizontalVelocity() {
  updateMovementAxis();
  updateVelocity();
  if (isGliding) {
    const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (speed > GLIDE_HORIZONTAL_SPEED) {
      const factor = GLIDE_HORIZONTAL_SPEED / speed;
      velocity.x *= factor;
      velocity.z *= factor;
    }
  }
  setOrientation();
}

var scratch: Vector3 = Vector3.Zero();
function updateMovementAxis() {
  // Auto-walk takes priority. getWalkAxis() also handles the IA_PRIMARY trigger and cancels
  // the walk (returning null) if any directional key is pressed, so we fall through to normal
  // manual input in that case.
  const walkAxis = getWalkAxis();
  if (walkAxis !== null) {
    Vector3.copyFrom(walkAxis, movementAxis);
    return;
  }

  const camera = Transform.get(engine.CameraEntity);
  var fwd = Vector3.rotate(Vector3.Forward(), camera.rotation);
  Vector3.multiplyToRef(fwd, VEC3_HORIZONTAL_MASK, fwd);
  Vector3.normalizeToRef(fwd, fwd);
  var right = Vector3.rotate(Vector3.Right(), camera.rotation);
  Vector3.multiplyToRef(right, VEC3_HORIZONTAL_MASK, right);
  Vector3.normalizeToRef(right, right);
  var back = Vector3.scale(fwd, -1);
  var left = Vector3.scale(right, -1);

  Vector3.copyFrom(VEC3_ZERO, movementAxis);
  if (inputSystem.isPressed(InputAction.IA_LEFT)) {
    Vector3.addToRef(movementAxis, left, movementAxis);
  }
  if (inputSystem.isPressed(InputAction.IA_RIGHT)) {
    Vector3.addToRef(movementAxis, right, movementAxis);
  }
  if (inputSystem.isPressed(InputAction.IA_FORWARD)) {
    Vector3.addToRef(movementAxis, fwd, movementAxis);
  }
  if (inputSystem.isPressed(InputAction.IA_BACKWARD)) {
    Vector3.addToRef(movementAxis, back, movementAxis);
  }

  Vector3.normalizeToRef(movementAxis, movementAxis);
}

// Damps horizontal axes always and the upward Y component only — so impulses
// fade but gravity-driven falling isn't capped to a slow terminal velocity.
// When grounded, also subtracts a fixed (speed-independent) horizontal
// deceleration so walking comes to rest near-instantly without weakening
// fast impulses. Called from applyMovement before vertical/horizontal so
// jump-rise overrides aren't damped after being set.
export function dampVelocity() {
  const tau = grounded ? settings.dampTimeGround : HORIZONTAL_DAMP_TIME_AIR;
  const damp = Math.exp(-stepTime / tau);
  velocity.x *= damp;
  velocity.z *= damp;
  if (velocity.y > 0) velocity.y *= damp;

  const stopDecel = grounded ? HORIZONTAL_STOP_DECEL_GROUND : HORIZONTAL_STOP_DECEL_AIR;
  if (stopDecel > 0) {
    const speed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
    if (speed > 0) {
      const newSpeed = Math.max(0, speed - stopDecel * stepTime);
      const factor = newSpeed / speed;
      velocity.x *= factor;
      velocity.z *= factor;
    }
  }

  if (velocity.y > 0) {
    velocity.y = Math.max(0, velocity.y - VERTICAL_STOP_DECEL * stepTime);
  }
}

export var horizontalVelocity = Vector3.Zero();
function updateVelocity() {
  const targetSpeed = inputSystem.isPressed(InputAction.IA_MODIFIER) ? sprintSpeed
    : inputSystem.isPressed(InputAction.IA_WALK) ? walkSpeed
    : jogSpeed;

  // Hard-landing recovery: ignore movement input for a beat after a heavy
  // touchdown (set in index.ts landingAnimation). The ground damp/decel above
  // brings the player to rest, so the recover clip plays in place instead of
  // the avatar sliding away under input.
  if (time < landRecoverUntil) {
    Vector3.multiplyToRef(velocity, VEC3_HORIZONTAL_MASK, horizontalVelocity);
    return;
  }

  if (Vector3.lengthSquared(movementAxis) === 0 || targetSpeed === 0) {
    Vector3.multiplyToRef(velocity, VEC3_HORIZONTAL_MASK, horizontalVelocity);
    return;
  }

  // Apply input force along movementAxis. accel sized for fast ramp-up
  // (independent of damp τ) plus enough headroom to overcome the constant
  // decel at steady state. Cap so along-axis component can't exceed
  // targetSpeed — accel maintains target speed but doesn't fight an impulse
  // that's already faster along the same axis. velocity here is post-damp,
  // post-decel (dampVelocity ran first), so headroom reflects current state.
  const accelTime = grounded ? settings.accelTimeGround : HORIZONTAL_ACCEL_TIME_AIR;
  const stopDecel = grounded ? HORIZONTAL_STOP_DECEL_GROUND : HORIZONTAL_STOP_DECEL_AIR;
  const accel = targetSpeed / accelTime + stopDecel;
  const along = velocity.x * movementAxis.x + velocity.z * movementAxis.z;
  const headroom = Math.max(0, targetSpeed - along);
  const delta = Math.min(accel * stepTime, headroom);
  velocity.x += movementAxis.x * delta;
  velocity.z += movementAxis.z * delta;

  Vector3.multiplyToRef(velocity, VEC3_HORIZONTAL_MASK, horizontalVelocity);
}

export var targetOrientation = 0;

// returns equivalent angle within 180 degrees of center
export function relativeDegrees(center: number, angle: number): number {
  return center + ((angle - center + 180) % 360 + 360) % 360 - 180;
}

function setOrientation() {
  if (disableOrientation) {
    targetOrientation = orientation;
    return;
  }

  let turnSpeed = isGliding ? GLIDER_TURN_MAX_DEGREES_SEC : TURN_MAX_DEGREES_SEC;

  orientation = Quaternion.toEulerAngles(playerRotation).y;

  // While gliding, face the direction of travel (momentum) rather than raw
  // input — so a glider banks/curves instead of snapping to face the stick, and
  // pressing back decelerates into a lean rather than spinning 180°. Falls back
  // to input direction when nearly stopped.
  let faceDir = movementAxis;
  if (isGliding) {
    const hv = Vector3.create(velocity.x, 0, velocity.z);
    if (Vector3.lengthSquared(hv) > 0.25) {
      faceDir = Vector3.normalize(hv);
    }
  }

  if (Vector3.length(faceDir) != 0) {
    const targetFacing = Quaternion.fromLookAt(VEC3_ZERO, faceDir, VEC3_UP);
    targetOrientation = Quaternion.toEulerAngles(targetFacing).y;
  } else {
    targetOrientation = orientation;
  }

  if (targetOrientation != orientation) {
    if (Math.abs(targetOrientation - orientation) < 1) {
      orientation = targetOrientation;
    } else {
      orientation = relativeDegrees(targetOrientation, orientation);
      let perc = Math.min(stepTime / TURN_FULL_TIME, 1);
      orientation = Math.max(
        orientation - turnSpeed * stepTime,
        Math.min(
          orientation + turnSpeed * stepTime,
          targetOrientation * perc + orientation * (1 - perc)
        ));
      orientation = relativeDegrees(180, orientation);
    }
  }
}

