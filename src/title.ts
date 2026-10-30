import { glyph, slug } from '@pmndrs/glyph';
import { defineTextMaterial, type Text, ThreeConfig } from '@pmndrs/glyph/three';
import { TSL } from 'spark-radix';
import * as THREE from 'three';
import fontUrl from '../assets/fonts/paper-mono-light.font.glb?url';
import { type Physics, rayDistance } from './physics';

const { abs, floor, mod, screenCoordinate, uniform } = TSL;

const TITLE = {
    text: 'the kitchen',
    color: '#f6eedd',
    distance: 2.4,
    // Never closer than this share of the way to whatever's ahead.
    clearance: 0.7,
    // Share of the screen's width the word spans, landscape and portrait.
    width: { landscape: 0.46, portrait: 0.82 },
    // Up from the middle of the screen, as a share of its height: the upper third.
    raise: 0.17,
    // A dark copy just behind, down and to the right, in font-size units: lifts it off busy shelves.
    shadow: { color: '#0d0b09', opacity: 0.3, offset: [0.02, -0.028], depth: 0.01 },
};
const SWAY = { yaw: 0.008, pitch: 0.004, speed: 0.12 };
const EXIT_SECONDS = 0.7;
// Metres you walk from where you entered before the title dissolves: it stays up while you look round.
const WALK_AWAY = 1;
// Screen pixels per dither cell: chunky enough to read as a dissolve, not a fade.
const DITHER_PIXELS = 2;

export type Title = {
    text: Text<never>;
    shadow: Text<never>;
    group: THREE.Object3D;
    /** Measured at font size 1. */
    width: number;
    distance: number;
    origin: THREE.Vector3;
    facing: THREE.Quaternion;
    dissolve: ReturnType<typeof uniform>;
    entered: boolean;
    exit: number;
    // The sway's settling once you enter, 0 → 1.
    settle: number;
    time: number;
};

export async function initTitle(scene: THREE.Scene, camera: THREE.Camera, physics: Physics): Promise<Title> {
    await glyph.init();
    const three = glyph.handle('title', ThreeConfig);
    const font = await glyph.fontFace(fontUrl, { format: slug }).load();

    // Drawn after the splats, which write no depth: otherwise they'd blend over it.
    const dissolve = uniform(0);
    const group = three.createTextGroup({ renderOrder: 10, material: ditheredMaterial(dissolve) });
    // Created first, so it draws first.
    const shadow = three.createText({ font, text: TITLE.text, style: shadowStyle() }) as unknown as Text<never>;
    const text = three.createText({ font, text: TITLE.text, style: textStyle() }) as unknown as Text<never>;
    group.add(shadow, text);
    scene.add(group);

    // Laid out from its top-left corner: centre it on the group.
    const { width, height } = text.measure();
    text.position.set(-width / 2, height / 2, 0);
    shadow.position.set(-width / 2 + TITLE.shadow.offset[0], height / 2 + TITLE.shadow.offset[1], -TITLE.shadow.depth);

    const forward = camera.getWorldDirection(new THREE.Vector3());
    const { x, y, z } = camera.position;
    const ahead = rayDistance(physics, [x, y, z], [forward.x, forward.y, forward.z], 20);
    const distance = ahead === null ? TITLE.distance : Math.min(TITLE.distance, ahead * TITLE.clearance);

    return {
        text,
        shadow,
        group,
        width,
        distance,
        origin: camera.position.clone(),
        facing: camera.quaternion.clone(),
        dissolve,
        entered: false,
        exit: 0,
        settle: 0,
        time: 0,
    };
}

function textStyle() {
    return { fontSize: 1, color: TITLE.color };
}

function shadowStyle() {
    return { fontSize: 1, color: TITLE.shadow.color, opacity: TITLE.shadow.opacity };
}

// The default text material, with pixels dropping out in a 4×4 ordered (Bayer) pattern as `dissolve` goes 0 → 1.
function ditheredMaterial(dissolve: ReturnType<typeof uniform>) {
    return defineTextMaterial((context) => {
        const material = context.createDefaultMaterial();
        const cell = floor(screenCoordinate.xy.div(DITHER_PIXELS));
        const fine = mod(cell, 2);
        const coarse = mod(floor(cell.div(2)), 2);
        // A 2×2 Bayer value [[0, 2], [3, 1]] is 2·|x − y| + y.
        const bayer2 = (x: typeof fine.x, y: typeof fine.y) => abs(x.sub(y)).mul(2).add(y);
        const threshold = bayer2(fine.x, fine.y).mul(4).add(bayer2(coarse.x, coarse.y)).add(0.5).div(16);
        material.maskNode = threshold.greaterThan(dissolve);
        return material;
    });
}

const forward = new THREE.Vector3();
const up = new THREE.Vector3();

// Square to the screen and sized to it, so it reads the same on a phone as on a monitor.
function fitTitle(title: Title, camera: THREE.PerspectiveCamera) {
    const visibleHeight = 2 * title.distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const visibleWidth = visibleHeight * camera.aspect;
    const share = camera.aspect < 1 ? TITLE.width.portrait : TITLE.width.landscape;
    title.group.scale.setScalar((visibleWidth * share) / title.width);
    forward.set(0, 0, -1).applyQuaternion(title.facing);
    up.set(0, 1, 0).applyQuaternion(title.facing);
    title.group.position
        .copy(title.origin)
        .addScaledVector(forward, title.distance)
        .addScaledVector(up, visibleHeight * TITLE.raise);
    title.group.quaternion.copy(title.facing);
}

export function updateTitle(title: Title, entering: boolean, camera: THREE.PerspectiveCamera, dt: number): void {
    title.time += dt;
    if (entering && !title.entered) {
        title.entered = true;
        document.body.classList.remove('title');
    }
    if (title.entered) title.settle = Math.min(1, title.settle + dt / EXIT_SECONDS);
    const walked = Math.hypot(camera.position.x - title.origin.x, camera.position.z - title.origin.z);
    if (title.exit > 0 || (title.entered && walked > WALK_AWAY)) {
        title.exit = Math.min(1, title.exit + dt / EXIT_SECONDS);
        const eased = title.exit * title.exit * (3 - 2 * title.exit);
        title.dissolve.value = eased;
        title.group.visible = title.exit < 1;
    }

    if (title.group.visible) fitTitle(title, camera);

    // A slow sway before you enter, settling as you do.
    const sway = 1 - title.settle;
    if (sway <= 0) return;
    const t = title.time * SWAY.speed * Math.PI * 2;
    camera.rotation.y += Math.sin(t) * SWAY.yaw * sway;
    camera.rotation.x += Math.sin(t * 0.7 + 1) * SWAY.pitch * sway;
}

export function renderTitle(): void {
    glyph.shape();
}
