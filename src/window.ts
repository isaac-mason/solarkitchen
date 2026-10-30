import {
    type AnySplatObject,
    GpuArrays,
    GpuSplats,
    SplatCollection,
    type SplatData,
    SplatGenerator,
    type SplatNode,
    type SplatObject,
    Splats,
    TSL,
    type TslNode,
} from '@sparkjsdev/radix';
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const {
    abs,
    dot,
    float,
    floor,
    hash,
    If,
    length,
    max,
    min,
    mix,
    mx_noise_float,
    normalize,
    pow,
    smoothstep,
    step,
    uint,
    vec2,
    vec3,
    vec4,
} = TSL;

// The left wall's three rounded panes, found with scripts/look.ts: each from its bottom corner along the wall, out of
// the room along OUT. The wall runs a little off the x axis.
export const ALONG = [-0.993, 0, -0.118];
export const OUT = [-0.118, 0, 0.993];
const UP = [0, 1, 0];
// Measured where glass meets frame by scanning picks across each edge; each pane's glass sits at its own depth,
// and the frame's face stands `reveal` in front of it.
const PANES = [
    { corner: [-8.7053, 1.175, -5.9558], width: 0.64, reveal: 0.165 },
    { corner: [-9.5794, 1.175, -6.0999], width: 1.365, reveal: 0.125 },
    { corner: [-11.2615, 1.175, -6.2243], width: 1.585, reveal: 0.135 },
];
const PANE = { height: 1.595, radius: 0.17 };
// The middle of the bank of windows, at floor height: where the meadow outside is laid out from.
export const BANK_CENTRE = [-10.904, 0, -6.267];
// Cut: inside a pane's outline (grown by `margin`), from `front` into the room to `back` out of it; lower down, where
// the sill's clutter sits, only a little into the room. Pale glass-blue splats are cut a little further round.
const CUT = {
    margin: 0.04,
    front: 0.2,
    sillFront: 0.06,
    sill: 0.12,
    back: 2,
    haze: 0.26,
    hazeDepth: 0.45,
    speck: 0.012,
    speckReach: 0.1,
    speckDepth: 0.2,
    // Just past the glass round the opening's edge, in the reveal: outdoors, so junk. Narrow, or it eats the posts.
    pastGlass: 0.02,
    pastReach: 0.1,
};
// Specks: the capture's blend of frame and outdoors at the opening's edge, tiny splats of any colour. Cut round the
// sides and top only: the sill's clutter below is small too.
// Anything the capture saw beyond the wall, along the whole bank of windows.
const BEYOND = { from: -0.5, to: 4.6, bottom: 0.8, top: 3.2, past: 0.2 };

// Signed distance from a pane's rounded outline in its own plane: negative inside.
function outline(s: TslNode, t: TslNode, width: number): TslNode {
    const half = vec2(width / 2 - PANE.radius, PANE.height / 2 - PANE.radius);
    const q = abs(vec2(s.sub(width / 2), t.sub(PANE.height / 2))).sub(half);
    return length(max(q, vec2(0)))
        .add(min(max(q.x, q.y), 0))
        .sub(PANE.radius);
}

export function cutWindow(arrays: GpuArrays): AnySplatObject {
    const stored = SplatGenerator.fromSplats();
    const out = vec3(...OUT);
    const along = vec3(...ALONG);
    const up = vec3(...UP);
    const origin = PANES[0].corner;

    const cut = (centre: TslNode, rgb: TslNode, scales: TslNode): TslNode => {
        const tiny = max(scales.x, max(scales.y, scales.z)).lessThan(CUT.speck);
        const [r, g, b] = [rgb.x, rgb.y, rgb.z];
        // The old glass's haze and glare: pale and cool, or near white. The wood round it is warm, far less blue than red.
        const light = r.add(g).add(b).div(3);
        const hazy = b
            .greaterThanEqual(r.sub(0.03))
            .and(light.greaterThan(0.38))
            .or(min(r, min(g, b)).greaterThan(0.6));
        const fromBank = centre.sub(vec3(...origin)).toVar();
        const s = fromBank.dot(along);
        const y = centre.y;
        const beyond = s
            .greaterThan(BEYOND.from)
            .and(s.lessThan(BEYOND.to))
            .and(y.greaterThan(BEYOND.bottom))
            .and(y.lessThan(BEYOND.top))
            .and(fromBank.dot(out).greaterThan(BEYOND.past));
        let gone: TslNode = beyond;
        for (const pane of PANES) {
            const d = centre.sub(vec3(...pane.corner)).toVar();
            const ps = d.dot(along);
            const pt = d.dot(up);
            const away = d.dot(out).toVar();
            const edge = outline(ps, pt, pane.width).toVar();
            const front = pt.lessThan(CUT.sill).select(float(CUT.sillFront), float(CUT.front));
            const inside = edge.lessThan(CUT.margin).and(away.lessThan(CUT.back)).and(away.greaterThan(front.negate()));
            const haze = hazy.and(edge.lessThan(CUT.haze)).and(abs(away).lessThan(CUT.hazeDepth));
            const speck = tiny
                .and(edge.lessThan(CUT.speckReach))
                .and(abs(away).lessThan(CUT.speckDepth))
                .and(pt.greaterThan(CUT.sill));
            const past = away.greaterThan(CUT.pastGlass).and(edge.lessThan(CUT.pastReach));
            gone = gone.or(inside).or(haze).or(speck).or(past);
        }
        return gone;
    };

    return SplatCollection.object({
        count: arrays.count,
        data: { splats: arrays },
        generator: {
            generateSplat(index: TslNode) {
                const splat = stored.generateSplat?.(index).toVar() as SplatNode;
                If(cut(splat.get('center'), splat.get('rgb'), splat.get('scales')), () => {
                    splat.get('opacity').assign(0);
                });
                return splat;
            },
            bind(data: { splats: GpuArrays }) {
                stored.bind?.(data);
            },
        },
    });
}

/* the clean frame */

// The frame's real shape, modelled over the capture's ragged one: the reveal (the opening's inner sides, from the
// glass out to the frame's face), a rounded edge onto the face, and a strip of the face fading into the captured wood.
// Tiled with as few splats as hold it: each a thin Gaussian lying in the surface, stretched long along the frame where
// it runs straight, narrow across the profile only where the profile bends, turned to the surface's own directions,
// spaced about 1.6 of their own widths apart so they sum to a continuous surface. Built once, on the CPU, and coloured
// from the capture itself: each takes the colour of the real frame's splats around it, so it carries the room's own
// light and wear rather than a made-up wood.
const FRAME = { edge: 0.02, face: 0.07, along: 0.03, reveal: 0.04, spread: 1.6, thin: 0.0015, wood: [0.47, 0.35, 0.23] };
// Which captured splats lend their colour: near the windows, opaque enough, not glass haze or a speck.
const SAMPLE = {
    cell: 0.03,
    reach: 0.045,
    wider: 0.1,
    minOpacity: 0.3,
    minSize: 0.01,
    region: { from: -0.4, to: 4.7, bottom: 0.95, top: 3.05, front: -0.35, back: 0.25 },
};

type Row = { at: number; width: number; opacity: number };

function profileRows(reveal: number): { rows: Row[]; revealEnd: number; edgeEnd: number } {
    const revealEnd = reveal - FRAME.edge;
    const edgeEnd = revealEnd + (Math.PI / 2) * FRAME.edge;
    const rows: Row[] = [];
    const span = (from: number, to: number, count: number, opacities: number[] = []) => {
        const step = (to - from) / count;
        for (let k = 0; k < count; k++)
            rows.push({ at: from + step * (k + 0.5), width: step / FRAME.spread, opacity: opacities[k] ?? 1 });
    };
    span(0, revealEnd, Math.ceil(revealEnd / FRAME.reveal));
    span(revealEnd, edgeEnd, 2);
    span(edgeEnd, edgeEnd + FRAME.face, 2, [1, 0.45]);
    return { rows, revealEnd, edgeEnd };
}

// A point `u` (0..1) round a pane's rounded outline, in its own plane, and the outward direction there.
function outlinePoint(u: number, width: number): { at: [number, number]; normal: [number, number] } {
    const r = PANE.radius;
    const h = PANE.height;
    const lengths = [
        width - 2 * r,
        (Math.PI / 2) * r,
        h - 2 * r,
        (Math.PI / 2) * r,
        width - 2 * r,
        (Math.PI / 2) * r,
        h - 2 * r,
        (Math.PI / 2) * r,
    ];
    let d = u * lengths.reduce((x, y) => x + y, 0);
    const arc = (cx: number, cy: number, from: number): { at: [number, number]; normal: [number, number] } => {
        const angle = from + d / r;
        return { at: [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r], normal: [Math.cos(angle), Math.sin(angle)] };
    };
    const pieces = [
        () => ({ at: [r + d, 0] as [number, number], normal: [0, -1] as [number, number] }),
        () => arc(width - r, r, -Math.PI / 2),
        () => ({ at: [width, r + d] as [number, number], normal: [1, 0] as [number, number] }),
        () => arc(width - r, h - r, 0),
        () => ({ at: [width - r - d, h] as [number, number], normal: [0, 1] as [number, number] }),
        () => arc(r, h - r, Math.PI / 2),
        () => ({ at: [0, h - r - d] as [number, number], normal: [-1, 0] as [number, number] }),
        () => arc(r, r, Math.PI),
    ];
    for (const [k, length] of lengths.entries()) {
        if (d <= length || k === lengths.length - 1) return pieces[k]();
        d -= length;
    }
    return pieces[0]();
}

type ColourGrid = Map<number, number[]>;
const cellKey = (x: number, y: number, z: number) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);

// The captured frame's splats near the windows, bucketed for lookup: centre and colour, weighted by opacity.
function captureColours(capture: SplatData): ColourGrid {
    const bundle = capture.bundles.extSplats;
    const grid: ColourGrid = new Map();
    const centre = { x: 0, y: 0, z: 0 };
    const splat = Splats.makeSplat();
    const origin = PANES[0].corner;
    const { region } = SAMPLE;
    for (let i = 0; i < capture.count; i++) {
        Splats.loadCenter(bundle, i, centre);
        const d = [centre.x - origin[0], centre.y - origin[1], centre.z - origin[2]];
        const s = d[0] * ALONG[0] + d[2] * ALONG[2];
        const away = d[0] * OUT[0] + d[2] * OUT[2];
        if (s < region.from || s > region.to || centre.y < region.bottom || centre.y > region.top) continue;
        if (away < region.front || away > region.back) continue;
        Splats.load(bundle, i, splat);
        const { r, g, b } = splat.rgb;
        const light = (r + g + b) / 3;
        const hazy = (b >= r - 0.03 && light > 0.38) || Math.min(r, g, b) > 0.6;
        if (
            hazy ||
            splat.opacity < SAMPLE.minOpacity ||
            Math.max(splat.scales.x, splat.scales.y, splat.scales.z) < SAMPLE.minSize
        )
            continue;
        const key = cellKey(
            Math.floor(centre.x / SAMPLE.cell),
            Math.floor(centre.y / SAMPLE.cell),
            Math.floor(centre.z / SAMPLE.cell),
        );
        const bucket = grid.get(key) ?? [];
        bucket.push(centre.x, centre.y, centre.z, r, g, b, Math.min(splat.opacity, 1));
        grid.set(key, bucket);
    }
    return grid;
}

function colourAt(grid: ColourGrid, p: THREE.Vector3, reach: number): [number, number, number] | null {
    const cells = Math.ceil(reach / SAMPLE.cell);
    const [cx, cy, cz] = [Math.floor(p.x / SAMPLE.cell), Math.floor(p.y / SAMPLE.cell), Math.floor(p.z / SAMPLE.cell)];
    const sum = [0, 0, 0];
    let weight = 0;
    for (let x = cx - cells; x <= cx + cells; x++) {
        for (let y = cy - cells; y <= cy + cells; y++) {
            for (let z = cz - cells; z <= cz + cells; z++) {
                const bucket = grid.get(cellKey(x, y, z));
                if (!bucket) continue;
                for (let k = 0; k < bucket.length; k += 7) {
                    const d2 = (bucket[k] - p.x) ** 2 + (bucket[k + 1] - p.y) ** 2 + (bucket[k + 2] - p.z) ** 2;
                    if (d2 > reach * reach) continue;
                    const w = Math.exp(-d2 / (2 * (reach / 2) ** 2)) * bucket[k + 6];
                    sum[0] += bucket[k + 3] * w;
                    sum[1] += bucket[k + 4] * w;
                    sum[2] += bucket[k + 5] * w;
                    weight += w;
                }
            }
        }
    }
    return weight > 1e-3 ? [sum[0] / weight, sum[1] / weight, sum[2] / weight] : null;
}

export function frameSplats(renderer: WebGPURenderer, capture: SplatData): AnySplatObject {
    const grid = captureColours(capture);
    const room = new THREE.Vector3(...OUT).negate();
    const alongWall = new THREE.Vector3(...ALONG);
    const up = new THREE.Vector3(...UP);
    const lengthAlong = FRAME.along / FRAME.spread;
    const splats: {
        centre: THREE.Vector3;
        quaternion: THREE.Quaternion;
        width: number;
        opacity: number;
        rgb: [number, number, number];
    }[] = [];
    const [n, t, across, normal] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const basis = new THREE.Matrix4();
    for (const pane of PANES) {
        const perimeter = 2 * (pane.width - 2 * PANE.radius) + 2 * (PANE.height - 2 * PANE.radius) + 2 * Math.PI * PANE.radius;
        const along = Math.ceil(perimeter / FRAME.along);
        const { rows, revealEnd, edgeEnd } = profileRows(pane.reveal);
        for (let a = 0; a < along; a++) {
            const outline = outlinePoint((a + 0.5) / along, pane.width);
            n.copy(alongWall).multiplyScalar(outline.normal[0]).addScaledVector(up, outline.normal[1]);
            t.copy(alongWall).multiplyScalar(-outline.normal[1]).addScaledVector(up, outline.normal[0]);
            for (const row of rows) {
                const l = row.at;
                const theta = THREE.MathUtils.clamp((l - revealEnd) / FRAME.edge, 0, Math.PI / 2);
                let offset: number;
                let depth: number;
                if (l < revealEnd) {
                    [offset, depth] = [0, l];
                    across.copy(room);
                } else if (l < edgeEnd) {
                    [offset, depth] = [FRAME.edge * (1 - Math.cos(theta)), revealEnd + Math.sin(theta) * FRAME.edge];
                    across.copy(n).multiplyScalar(Math.sin(theta)).addScaledVector(room, Math.cos(theta)).normalize();
                } else {
                    [offset, depth] = [l - edgeEnd + FRAME.edge, pane.reveal];
                    across.copy(n);
                }
                const centre = new THREE.Vector3(...pane.corner)
                    .addScaledVector(alongWall, outline.at[0])
                    .addScaledVector(up, outline.at[1])
                    .addScaledVector(n, offset)
                    .addScaledVector(room, depth);
                normal.crossVectors(t, across).normalize();
                basis.makeBasis(t, across, normal);
                const shade = 0.45 + 0.5 * Math.max(0, normal.y * 0.85 + Math.abs(normal.dot(room)) * 0.55);
                const fallback = FRAME.wood.map((c) => c * shade) as [number, number, number];
                const rgb = colourAt(grid, centre, SAMPLE.reach) ?? colourAt(grid, centre, SAMPLE.wider) ?? fallback;
                splats.push({
                    centre,
                    quaternion: new THREE.Quaternion().setFromRotationMatrix(basis),
                    width: row.width,
                    opacity: row.opacity,
                    rgb,
                });
            }
        }
    }
    const data = Splats.make(splats.length);
    const bundle = data.bundles.extSplats;
    const out = Splats.makeSplat();
    for (const [i, s] of splats.entries()) {
        out.center = { x: s.centre.x, y: s.centre.y, z: s.centre.z };
        out.scales = { x: lengthAlong, y: s.width, z: FRAME.thin };
        out.quaternion = { x: s.quaternion.x, y: s.quaternion.y, z: s.quaternion.z, w: s.quaternion.w };
        out.rgb = { r: s.rgb[0], g: s.rgb[1], b: s.rgb[2] };
        out.opacity = s.opacity;
        Splats.store(bundle, i, out);
    }
    return SplatCollection.arrays(GpuArrays.fromData(renderer, data), { params: { lodInflate: false } });
}

const paneBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...ALONG),
    new THREE.Vector3(...UP),
    new THREE.Vector3(...OUT).negate(),
);

/* the glass */

// Glass as a sheet of very faint flat splats in each pane: sorted with everything else, so it sits between the room
// and the meadow. A sheen brighter toward the top, and here and there a smudge or a fleck of dust.
// Spaced well apart for their size: overlapping much, a sheet of them costs as much as the rest of the room.
// The glass: barely there head-on, but catching a warm reflection of the room as you look across it, a couple of soft
// diagonal glints of sky, and a little grime gathered in the corners and along the bottom.
const GLASS = {
    spacing: 0.05,
    opacity: 0.04,
    smudge: 0.1,
    dust: 0.004,
    reflection: { strength: 0.5, colour: [0.86, 0.72, 0.55] },
    glint: { every: 1.15, width: 0.09, strength: 0.16 },
    grime: { reach: 0.09, strength: 0.22, colour: [0.55, 0.5, 0.43] },
};

export function glassSplats(eye: TslNode): SplatObject {
    const counts = PANES.map((pane) => Math.ceil(pane.width / GLASS.spacing) * Math.ceil(PANE.height / GLASS.spacing));
    const total = counts.reduce((a, b) => a + b, 0);
    return SplatCollection.object({
        count: total,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                let where: TslNode = vec3(0);
                let edge: TslNode = float(1);
                let start = 0;
                for (const [k, pane] of PANES.entries()) {
                    const columns = Math.ceil(pane.width / GLASS.spacing);
                    const local = i.sub(start);
                    const u = local.mod(columns).add(0.5).mul(GLASS.spacing);
                    const v = floor(local.div(columns)).add(0.5).mul(GLASS.spacing);
                    const here = vec3(...pane.corner)
                        .add(vec3(...ALONG).mul(u))
                        .add(vec3(0, v, 0));
                    where = i.greaterThanEqual(start).select(here, where);
                    edge = i.greaterThanEqual(start).select(outline(u, v, pane.width), edge);
                    start += counts[k];
                }
                const height = where.y.sub(PANES[0].corner[1]).div(PANE.height);
                const smudge = smoothstep(0.55, 0.85, mx_noise_float(where.mul(3.1)));
                const dust = step(1 - GLASS.dust, hash(i.mul(1.73)));
                const sheen = mix(0.6, 1.2, height);
                // Looked at across the glass rather than through it, it reflects more.
                const facing = abs(dot(normalize(where.sub(eye)), vec3(...OUT)));
                const reflection = pow(float(1).sub(facing), 2).mul(GLASS.reflection.strength);
                // Two glints, a wide one and a thin one beside it, slanting across the panes.
                const slant = dot(where, vec3(...ALONG))
                    .add(where.y.mul(0.7))
                    .div(GLASS.glint.every)
                    .fract();
                const band = (from: number, width: number) =>
                    smoothstep(from, from + width * 0.4, slant).mul(smoothstep(from + width, from + width * 0.6, slant));
                const glint = band(0.3, GLASS.glint.width / GLASS.glint.every)
                    .add(band(0.42, (GLASS.glint.width * 0.35) / GLASS.glint.every).mul(0.7))
                    .mul(GLASS.glint.strength);
                const grime = smoothstep(-GLASS.grime.reach, -0.005, edge)
                    .mul(mix(1, 0.35, height))
                    .mul(GLASS.grime.strength);
                const opacity = step(edge, -0.005).mul(
                    float(GLASS.opacity)
                        .mul(sheen)
                        .add(smudge.mul(GLASS.smudge))
                        .add(dust.mul(0.25))
                        .add(reflection)
                        .add(glint)
                        .add(grime),
                );
                const tint = mix(
                    mix(vec3(0.9, 0.93, 0.96), vec3(...GLASS.reflection.colour), reflection.div(opacity.max(1e-3)).min(1)),
                    vec3(...GLASS.grime.colour),
                    grime.div(opacity.max(1e-3)).min(1),
                );
                const size = vec3(GLASS.spacing * 0.45, GLASS.spacing * 0.45, 0.001);
                const flat = new THREE.Quaternion().setFromRotationMatrix(paneBasis);
                return GpuSplats.Splat(where, size, vec4(flat.x, flat.y, flat.z, flat.w), tint, opacity, uint(index));
            },
        },
    });
}
