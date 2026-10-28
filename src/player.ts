import { capsule, type Filter, filter, type KCC, kcc, type Shape, transformed } from 'crashcat';
import { quat, type Vec3, vec3, vec4 } from 'mathcat';
import * as THREE from 'three';
import { consumeLook, type Input } from './input';
import { GRAVITY, type Physics } from './physics';

const PLAYER = { height: 1.7, radius: 0.25, eye: 1.6, walk: 1.6, run: 3.2, jump: 3.6, accel: 10, friction: 8 };
const CROUCH = { height: 1.0, eye: 0.9, speed: 0.8, eyeSeconds: 0.12 };
// Standing back up is refused if it would push into anything deeper than this.
const STAND_UP_TOLERANCE = 0.01;
const MAX_SLOPE = (50 * Math.PI) / 180;
// Floorboard lips and rugs, not counters or crates.
const STEP_UP = 0.12;
const LOOK_SENSITIVITY = 0.0022;
// Opt-in damped look: the view settles onto where the mouse aims.
const SMOOTH_LOOK_SECONDS = 0.06;
const ZOOM = { fov: 70, zoomedFov: 38, seconds: 0.12 };
// Head lowest as each foot lands; a dip on landing a jump, by how fast you came down.
const BOB = { stride: 0.75, height: 0.022, seconds: 0.15, landPerSpeed: 0.018, landMax: 0.09, landSeconds: 0.12 };
// Shorter than this off the ground is the collider's bumps, not a fall worth landing from.
const MIN_AIR_SECONDS = 0.15;

const SPAWN: Vec3 = [-7.52, 0.07, -10.99];
const SPAWN_LOOK = { yaw: 2.234, pitch: -0.2 };

export type Player = {
    controller: KCC;
    settings: kcc.UpdateSettings;
    filter: Filter;
    standing: Shape;
    crouching: Shape;
    crouched: boolean;
    eye: number;
    fov: number;
    yaw: number;
    pitch: number;
    aimYaw: number;
    aimPitch: number;
    smoothLook: boolean;
    /** Distance into the current stride, and whether a foot landed this update. */
    stride: number;
    stepped: boolean;
    landed: boolean;
    bob: number;
    dip: number;
    grounded: boolean;
    airborne: number;
};

export function initPlayer(physics: Physics): Player {
    const standing = capsuleOfHeight(PLAYER.height);
    const crouching = capsuleOfHeight(CROUCH.height);
    const controller = kcc.create(
        {
            shape: standing,
            up: [0, 1, 0],
            maxSlopeAngle: MAX_SLOPE,
            supportingVolumePlane: vec4.fromValues(0, 1, 0, -PLAYER.radius),
            backFaceMode: kcc.BackFaceMode.COLLIDE,
        },
        SPAWN,
        quat.create(),
    );
    kcc.add(physics.world, controller);
    const settings = kcc.createDefaultUpdateSettings();
    vec3.set(settings.walkStairsStepUp, 0, STEP_UP, 0);
    return {
        controller,
        settings,
        filter: filter.create(physics.world.settings.layers),
        standing,
        crouching,
        crouched: false,
        eye: PLAYER.eye,
        fov: ZOOM.fov,
        yaw: SPAWN_LOOK.yaw,
        pitch: SPAWN_LOOK.pitch,
        aimYaw: SPAWN_LOOK.yaw,
        aimPitch: SPAWN_LOOK.pitch,
        smoothLook: false,
        stride: 0,
        stepped: false,
        landed: false,
        bob: 0,
        dip: 0,
        grounded: true,
        airborne: 0,
    };
}

const wish = vec3.create();
const horizontal = vec3.create();
const before = vec3.create();

export function updatePlayer(player: Player, physics: Physics, input: Input, dt: number): void {
    const [lookX, lookY] = consumeLook(input);
    const fovGoal = input.zoom ? ZOOM.zoomedFov : ZOOM.fov;
    player.fov += (fovGoal - player.fov) * (1 - 0.5 ** (dt / ZOOM.seconds));
    // Slower look when zoomed, so the view moves the same on screen.
    const sensitivity = LOOK_SENSITIVITY * (player.fov / ZOOM.fov);
    player.aimYaw -= lookX * sensitivity;
    player.aimPitch = THREE.MathUtils.clamp(player.aimPitch - lookY * sensitivity, -1.5, 1.5);
    const settle = player.smoothLook ? 1 - 0.5 ** (dt / SMOOTH_LOOK_SECONDS) : 1;
    player.yaw += (player.aimYaw - player.yaw) * settle;
    player.pitch += (player.aimPitch - player.pitch) * settle;

    const [strafe, forward] = input.move;
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    vec3.set(wish, strafe * cos - forward * sin, 0, -strafe * sin - forward * cos);
    const { controller } = player;
    const wantsCrouch = input.crouch;
    if (wantsCrouch && !player.crouched) {
        player.crouched = kcc.setShape(physics.world, controller, player.crouching, player.filter, undefined, Infinity);
    } else if (!wantsCrouch && player.crouched) {
        const stood = kcc.setShape(physics.world, controller, player.standing, player.filter, undefined, STAND_UP_TOLERANCE);
        player.crouched = !stood;
    }
    const eyeGoal = player.crouched ? CROUCH.eye : PLAYER.eye;
    player.eye += (eyeGoal - player.eye) * (1 - 0.5 ** (dt / CROUCH.eyeSeconds));

    const speed = player.crouched ? CROUCH.speed : input.run ? PLAYER.run : PLAYER.walk;

    kcc.updateGroundVelocity(physics.world, controller);
    const grounded = isGrounded(player);
    const velocity = controller.linearVelocity;
    vec3.set(horizontal, velocity[0], 0, velocity[2]);
    const blend = 1 - Math.exp(-(vec3.length(wish) > 0 ? PLAYER.accel : PLAYER.friction) * dt * (grounded ? 1 : 0.2));
    horizontal[0] += (wish[0] * speed - horizontal[0]) * blend;
    horizontal[2] += (wish[2] * speed - horizontal[2]) * blend;

    let vertical = grounded ? Math.max(velocity[1], 0) : velocity[1];
    const jumping = grounded && !player.crouched && input.jump;
    if (jumping) vertical = PLAYER.jump;
    vertical += GRAVITY[1] * dt;
    vec3.set(velocity, horizontal[0], vertical, horizontal[2]);

    if (jumping) vec3.zero(player.settings.stickToFloorStepDown);
    else vec3.set(player.settings.stickToFloorStepDown, 0, -0.5, 0);
    vec3.copy(before, controller.position);
    const fallSpeed = -velocity[1];
    kcc.update(physics.world, controller, dt, GRAVITY, player.settings, undefined, player.filter);
    const moved = Math.hypot(controller.position[0] - before[0], controller.position[2] - before[2]);
    updateStride(player, moved, fallSpeed, dt);
}

function updateStride(player: Player, moved: number, fallSpeed: number, dt: number) {
    const grounded = isGrounded(player);
    const landed = grounded && player.airborne >= MIN_AIR_SECONDS;
    player.airborne = grounded ? 0 : player.airborne + dt;
    player.grounded = grounded;
    player.stepped = landed;
    player.landed = landed;
    if (landed) {
        player.dip = Math.min(BOB.landMax, Math.max(player.dip, fallSpeed * BOB.landPerSpeed));
        player.stride = 0;
    }
    player.dip *= 0.5 ** (dt / BOB.landSeconds);
    if (!grounded) return;

    player.stride += moved;
    if (player.stride >= BOB.stride) {
        player.stride -= BOB.stride;
        player.stepped = true;
    }
    const pace = Math.min(moved / dt / PLAYER.walk, 1.5);
    player.bob += (pace * BOB.height - player.bob) * (1 - 0.5 ** (dt / BOB.seconds));
}

/** 0 at rest, 1 fully zoomed. */
export function zoomAmount(player: Player): number {
    return (ZOOM.fov - player.fov) / (ZOOM.fov - ZOOM.zoomedFov);
}

export function isGrounded(player: Player): boolean {
    return player.controller.ground.state === kcc.GroundState.ON_GROUND;
}

export function applyPlayerCamera(player: Player, camera: THREE.PerspectiveCamera): void {
    const [x, y, z] = player.controller.position;
    const step = Math.cos((Math.PI * player.stride) / BOB.stride);
    camera.position.set(x, y + player.eye - player.bob * step * step - player.dip, z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    if (Math.abs(camera.fov - player.fov) > 1e-3) {
        camera.fov = player.fov;
        camera.updateProjectionMatrix();
    }
}

function capsuleOfHeight(height: number): Shape {
    return transformed.create({
        shape: capsule.create({ halfHeightOfCylinder: height / 2 - PLAYER.radius, radius: PLAYER.radius }),
        position: [0, height / 2, 0],
        quaternion: quat.create(),
    });
}
