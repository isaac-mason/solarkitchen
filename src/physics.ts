import {
    addBroadphaseLayer,
    addObjectLayer,
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    createWorld,
    createWorldSettings,
    enableCollision,
    filter,
    MotionType,
    registerAll,
    rigidBody,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const GRAVITY: Vec3 = [0, -9.81, 0];

registerAll();

export const worldSettings = createWorldSettings();
worldSettings.gravity = GRAVITY;
const BROADPHASE_MOVING = addBroadphaseLayer(worldSettings);
const BROADPHASE_STATIC = addBroadphaseLayer(worldSettings);
export const LAYER_MOVING = addObjectLayer(worldSettings, BROADPHASE_MOVING);
export const LAYER_STATIC = addObjectLayer(worldSettings, BROADPHASE_STATIC);
enableCollision(worldSettings, LAYER_MOVING, LAYER_STATIC);
enableCollision(worldSettings, LAYER_MOVING, LAYER_MOVING);

export type Physics = {
    world: World;
    collider: { positions: number[]; indices: number[] } | null;
};

export function initPhysics(): Physics {
    return { world: createWorld(worldSettings), collider: null };
}

export function updatePhysics(physics: Physics, dt: number): void {
    updateWorld(physics.world, undefined, dt);
}

export async function loadCollider(physics: Physics, url: string): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(url);
    gltf.scene.updateMatrixWorld(true);
    const positions: number[] = [];
    const indices: number[] = [];
    const v = new THREE.Vector3();
    gltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const geometry = object.geometry as THREE.BufferGeometry;
        const position = geometry.getAttribute('position');
        const base = positions.length / 3;
        for (let i = 0; i < position.count; i++) {
            v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
            positions.push(v.x, v.y, v.z);
        }
        const index = geometry.getIndex();
        for (let i = 0; i < (index ? index.count : position.count); i++) indices.push(base + (index ? index.getX(i) : i));
    });
    physics.collider = { positions, indices };
    rigidBody.create(physics.world, {
        shape: triangleMesh.create({ positions, indices }),
        motionType: MotionType.STATIC,
        objectLayer: LAYER_STATIC,
    });
}

const staticOnly = filter.createEmpty();
filter.disableAllLayers(staticOnly, worldSettings.layers);
filter.enableObjectLayer(staticOnly, worldSettings.layers, LAYER_STATIC);
staticOnly.collisionMask = -1;
staticOnly.collisionGroups = -1;
const rayCollector = createClosestCastRayCollector();
const raySettings = createDefaultCastRaySettings();
raySettings.collideWithBackfaces = true;

export function rayDistance(physics: Physics, origin: Vec3, direction: Vec3, maxDistance: number): number | null {
    rayCollector.reset();
    castRay(physics.world, rayCollector, raySettings, origin, direction, maxDistance, staticOnly);
    if (rayCollector.hit.status !== CastRayStatus.COLLIDING) return null;
    return rayCollector.hit.fraction * maxDistance;
}
