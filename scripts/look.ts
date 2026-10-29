// A CPU look at the scene, for working on it without a browser.
//   node scripts/look.ts render --eye x,y,z --yaw a --pitch b [--fov 70] [--size 960x600] [--out look.png] [--cut]
//   node scripts/look.ts pick   --eye x,y,z --yaw a --pitch b [--fov 70] [--size 960x600] --px u,v [--px u,v ...]
// Splats are drawn as round Gaussians, back to front; rough, but enough to see what's where.

import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, gunzipSync } from 'node:zlib';
import { NodeIO } from '@gltf-transform/core';
import {
    addBroadphaseLayer,
    addObjectLayer,
    CastRayStatus,
    castRay,
    createClosestCastRayCollector,
    createDefaultCastRaySettings,
    createWorld,
    createWorldSettings,
    filter,
    MotionType,
    registerAll,
    rigidBody,
    triangleMesh,
} from 'crashcat';

type Camera = { eye: number[]; yaw: number; pitch: number; fov: number; width: number; height: number };

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const camera: Camera = {
    eye: (args.eye?.[0] ?? '0,1.6,0').split(',').map(Number),
    yaw: Number(args.yaw?.[0] ?? 0),
    pitch: Number(args.pitch?.[0] ?? 0),
    fov: Number(args.fov?.[0] ?? 70),
    width: Number((args.size?.[0] ?? '960x600').split('x')[0]),
    height: Number((args.size?.[0] ?? '960x600').split('x')[1]),
};

if (command === 'render') render(args.out?.[0] ?? 'look.png');
else if (command === 'pick') await pick((args.px ?? []).map((p) => p.split(',').map(Number)));
else throw new Error('usage: look.ts render|pick ...');

function render(out: string) {
    const splats = readSpz('assets/scene.spz');
    const { width, height } = camera;
    const basis = cameraBasis(camera);
    const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360);

    const visible: number[] = [];
    const depth = new Float32Array(splats.count);
    const sx = new Float32Array(splats.count);
    const sy = new Float32Array(splats.count);
    const radius = new Float32Array(splats.count);
    for (let i = 0; i < splats.count; i++) {
        if (splats.opacity[i] < 0.05) continue;
        const p = [splats.position[i * 3], splats.position[i * 3 + 1], splats.position[i * 3 + 2]];
        const d = [p[0] - camera.eye[0], p[1] - camera.eye[1], p[2] - camera.eye[2]];
        const z = -dot(d, basis.back);
        if (z < 0.05) continue;
        const x = (dot(d, basis.right) / z) * focal + width / 2;
        const y = (-dot(d, basis.up) / z) * focal + height / 2;
        const r = (splats.scale[i] / z) * focal;
        if (x < -r - 2 || y < -r - 2 || x > width + r + 2 || y > height + r + 2) continue;
        depth[i] = z;
        sx[i] = x;
        sy[i] = y;
        radius[i] = Math.min(Math.max(r, 0.6), 40);
        visible.push(i);
    }
    visible.sort((a, b) => depth[b] - depth[a]);

    const image = new Float32Array(width * height * 3);
    for (const i of visible) {
        const sigma = radius[i];
        const reach = Math.ceil(sigma * 2.5);
        const [r, g, b] = [splats.colour[i * 3], splats.colour[i * 3 + 1], splats.colour[i * 3 + 2]];
        for (let py = Math.max(0, Math.floor(sy[i] - reach)); py <= Math.min(height - 1, sy[i] + reach); py++) {
            for (let px = Math.max(0, Math.floor(sx[i] - reach)); px <= Math.min(width - 1, sx[i] + reach); px++) {
                const dx = px + 0.5 - sx[i];
                const dy = py + 0.5 - sy[i];
                const a = Math.min(0.99, splats.opacity[i] * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)));
                if (a < 1 / 255) continue;
                const o = (py * width + px) * 3;
                image[o] += (r - image[o]) * a;
                image[o + 1] += (g - image[o + 1]) * a;
                image[o + 2] += (b - image[o + 2]) * a;
            }
        }
    }
    drawGrid(image, width, height);
    writePng(out, image, width, height);
    console.log(`${out}: ${visible.length.toLocaleString()} splats drawn`);
}

// Faint lines every 100 px, labelled by position, so a pixel can be read off the image.
function drawGrid(image: Float32Array, width: number, height: number) {
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (x % 100 !== 0 && y % 100 !== 0) continue;
            const o = (y * width + x) * 3;
            image[o] = image[o] * 0.5 + 0.5;
            image[o + 1] = image[o + 1] * 0.5 + 0.2;
            image[o + 2] = image[o + 2] * 0.5;
        }
    }
}

async function pick(pixels: number[][]) {
    const world = await loadCollider('assets/scene-collider.glb');
    const basis = cameraBasis(camera);
    const focal = camera.height / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const collector = createClosestCastRayCollector();
    const settings = createDefaultCastRaySettings();
    settings.collideWithBackfaces = true;
    const everything = filter.create(world.settings.layers);
    for (const [u, v] of pixels) {
        const x = (u - camera.width / 2) / focal;
        const y = -(v - camera.height / 2) / focal;
        const direction = [0, 1, 2].map((k) => basis.right[k] * x + basis.up[k] * y - basis.back[k]);
        const length = Math.hypot(...direction);
        collector.reset();
        castRay(
            world,
            collector,
            settings,
            camera.eye,
            direction.map((d) => d / length),
            30,
            everything,
        );
        if (collector.hit.status !== CastRayStatus.COLLIDING) {
            console.log(`${u},${v}: miss`);
            continue;
        }
        const t = collector.hit.fraction * 30;
        const hit = [0, 1, 2].map((k) => camera.eye[k] + (direction[k] / length) * t);
        console.log(`${u},${v}: [${hit.map((h) => h.toFixed(3)).join(', ')}]  (${t.toFixed(2)} m)`);
    }
}

function cameraBasis({ yaw, pitch }: Camera) {
    // three's YXZ order: yaw about y, then pitch about x.
    const [cy, sy, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
    return {
        right: [cy, 0, -sy],
        up: [sy * sp, cp, cy * sp],
        back: [sy * cp, -sp, cy * cp],
    };
}

function readSpz(path: string) {
    const bytes = gunzipSync(readFileSync(path));
    const count = bytes.readUInt32LE(8);
    const fractionalBits = bytes[13];
    const positions = 16;
    const alphas = positions + count * 9;
    const colours = alphas + count;
    const scales = colours + count * 3;
    const position = new Float32Array(count * 3);
    const opacity = new Float32Array(count);
    const colour = new Float32Array(count * 3);
    const scale = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        for (let k = 0; k < 3; k++) {
            const o = positions + i * 9 + k * 3;
            const v = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8;
            position[i * 3 + k] = v / (1 << fractionalBits);
            // Stored as the spherical-harmonic DC term, offset and scaled into a byte.
            colour[i * 3 + k] = Math.min(1, Math.max(0, 0.5 + 0.282095 * ((bytes[colours + i * 3 + k] / 255 - 0.5) / 0.15)));
        }
        opacity[i] = bytes[alphas + i] / 255;
        scale[i] = Math.exp(Math.max(...[0, 1, 2].map((k) => bytes[scales + i * 3 + k])) / 16 - 10);
    }
    return { count, position, opacity, colour, scale };
}

async function loadCollider(path: string) {
    registerAll();
    const settings = createWorldSettings();
    const layer = addObjectLayer(settings, addBroadphaseLayer(settings));
    const world = createWorld(settings);
    const document = await new NodeIO().read(path);
    const primitive = document.getRoot().listMeshes()[0].listPrimitives()[0];
    rigidBody.create(world, {
        shape: triangleMesh.create({
            positions: Array.from(primitive.getAttribute('POSITION')?.getArray() ?? []),
            indices: Array.from(primitive.getIndices()?.getArray() ?? []),
        }),
        motionType: MotionType.STATIC,
        objectLayer: layer,
    });
    return world;
}

function writePng(path: string, image: Float32Array, width: number, height: number) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width * 3; x++) {
            raw[y * (width * 3 + 1) + 1 + x] = Math.round(Math.min(1, Math.max(0, image[y * width * 3 + x])) ** (1 / 1.0) * 255);
        }
    }
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    writeFileSync(
        path,
        Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', header),
            chunk('IDAT', deflateSync(raw)),
            chunk('IEND', Buffer.alloc(0)),
        ]),
    );
}

function crc32(data: Buffer): number {
    let crc = ~0;
    for (const byte of data) {
        crc ^= byte;
        for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
}

function dot(a: number[], b: number[]) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function parseArgs(list: string[]) {
    const out: Record<string, string[]> = {};
    for (let i = 0; i < list.length; i++) {
        if (!list[i].startsWith('--')) continue;
        const key = list[i].slice(2);
        const value = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : '';
        out[key] = [...(out[key] ?? []), value];
    }
    return out;
}
