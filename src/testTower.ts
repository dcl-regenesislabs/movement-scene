// Test structure for long glides: a zig-zag staircase of platforms climbing to
// ~150m, plus an elevator platform that continuously cycles ground <-> top.
// All platforms are plain boxes with physics colliders so the ground raycast
// (ground.ts, CL_PHYSICS) treats them as walkable.
import { ColliderLayer, engine, Material, MeshCollider, MeshRenderer, Transform } from '@dcl/sdk/ecs';
import { Color4, Vector3 } from '@dcl/sdk/math';

const TOWER_X = 40;
const TOWER_Z = 40;
const TOP_Y = 150;
const STEP_COUNT = 100; // 1.5m rise per step — comfortably jumpable
const PLATFORM_SIZE = 6;
const PLATFORM_THICKNESS = 0.5;

const ELEVATOR_SPEED = 8; // m/s
const ELEVATOR_PAUSE = 3; // seconds parked at each end

function platform(pos: Vector3, scale: Vector3, color: Color4) {
  const e = engine.addEntity();
  Transform.create(e, { position: pos, scale });
  MeshRenderer.setBox(e);
  MeshCollider.setBox(e, ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER);
  Material.setPbrMaterial(e, { albedoColor: color });
  return e;
}

export function initTestTower() {
  // Zig-zag staircase: platforms alternate between two columns, each one a
  // jumpable rise above the last, so you can climb on foot to any height.
  for (let i = 0; i < STEP_COUNT; i++) {
    const y = ((i + 1) * TOP_Y) / STEP_COUNT;
    // Half-platform side offset: consecutive steps overlap in both axes, so
    // every step is a short hop, never a long jump.
    const side = i % 2 === 0 ? 0 : PLATFORM_SIZE / 2;
    platform(
      Vector3.create(TOWER_X + side, y, TOWER_Z + i * 1.5),
      Vector3.create(PLATFORM_SIZE, PLATFORM_THICKNESS, PLATFORM_SIZE),
      Color4.create(0.4, 0.5 + (0.4 * i) / STEP_COUNT, 0.9, 1)
    );
  }

  // Big launch deck at the top — room to take a running glide start.
  platform(
    Vector3.create(TOWER_X + 4, TOP_Y + 2, TOWER_Z + STEP_COUNT * 1.5 + 8),
    Vector3.create(16, PLATFORM_THICKNESS, 16),
    Color4.create(0.9, 0.6, 0.2, 1)
  );

  // Elevator: rides ground <-> deck height on a timer, pausing at both ends.
  const elevator = platform(
    Vector3.create(TOWER_X - 12, 0.25, TOWER_Z),
    Vector3.create(4, PLATFORM_THICKNESS, 4),
    Color4.create(0.9, 0.3, 0.3, 1)
  );
  let y = 0.25;
  let dir = 1; // 1 = up, -1 = down
  let pause = 0;
  engine.addSystem((dt) => {
    if (pause > 0) { pause -= dt; return; }
    y += dir * ELEVATOR_SPEED * dt;
    if (y >= TOP_Y + 2) { y = TOP_Y + 2; dir = -1; pause = ELEVATOR_PAUSE; }
    if (y <= 0.25) { y = 0.25; dir = 1; pause = ELEVATOR_PAUSE; }
    Transform.getMutable(elevator).position.y = y;
  });
}
