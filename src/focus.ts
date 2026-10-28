import type { SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import { type Physics, rayDistance } from './physics';

// Splat-level depth of field: each splat widens by its circle of confusion, opacity spread to match.
const APERTURE_TAN = 0.0024;
// The title screen's dreamy focus, eased back to normal on entering.
const TITLE_APERTURE_TAN = APERTURE_TAN * 4;
const RELEASE_SECONDS = 0.5;
const PULL_SECONDS = 0.1;
const MAX_FOCUS = 20;

export type Focus = {
    distance: number;
    aperture: number;
};

export function initFocus(splats: SplatRenderer): Focus {
    splats.objectParams.apertureTan = TITLE_APERTURE_TAN;
    return { distance: 2, aperture: TITLE_APERTURE_TAN };
}

const forward = new THREE.Vector3();

export function updateFocus(
    focus: Focus,
    physics: Physics,
    camera: THREE.Camera,
    splats: SplatRenderer,
    dt: number,
    dreamy: boolean,
): void {
    camera.getWorldDirection(forward);
    const { x, y, z } = camera.position;
    const goal = rayDistance(physics, [x, y, z], [forward.x, forward.y, forward.z], MAX_FOCUS) ?? MAX_FOCUS;
    focus.distance += (goal - focus.distance) * (1 - 0.5 ** (dt / PULL_SECONDS));
    splats.objectParams.focalDistance = focus.distance;
    const aperture = dreamy ? TITLE_APERTURE_TAN : APERTURE_TAN;
    focus.aperture += (aperture - focus.aperture) * (1 - 0.5 ** (dt / RELEASE_SECONDS));
    splats.objectParams.apertureTan = focus.aperture;
}
