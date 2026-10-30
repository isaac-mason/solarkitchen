import {
    GpuSplatMath,
    GpuSplats,
    getGpuCaps,
    SplatCollection,
    type SplatObject,
    TSL,
    type TslNode,
    WgpuBuffer,
    WgpuCompute,
    WgpuComputeBatch,
} from '@sparkjsdev/radix';
import * as THREE from 'three';
import { MeshBasicNodeMaterial, type WebGPURenderer } from 'three/webgpu';
import cloudUrl from '../assets/cloud.jpg?url';
import { ALONG, BANK_CENTRE, OUT } from './window';

const {
    clamp,
    cos,
    cross,
    dot,
    exp,
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
    positionLocal,
    pow,
    sin,
    smoothstep,
    texture,
    time,
    uint,
    uniform,
    vec2,
    vec3,
    vec4,
} = TSL;

// The meadow the kitchen's landed in: splat grass out past the left wall's windows, thick near the hull and thinning
// into rolling hills, wildflowers in drifts, under a soft afternoon sky. Laid out in the wall's own terms: `out` metres
// away from it, `side` metres along it, from the middle of the bank of windows.

const FIELD = { from: 0.8, ground: -0.35, slope: -0.015 };
// Blades only as far as you can see them as blades; past that the turf carries the field.
const BLADES = {
    // Near blades curve through four splats; further out a blade is a few pixels tall, and two splats, then one,
    // draw it as well. Each tier runs out from the last; `stretch` is a splat's length against its segment's.
    tiers: [
        { to: 8, count: 24000, segments: 4, stretch: 0.62 },
        { to: 25, count: 11000, segments: 2, stretch: 0.5 },
        { to: 60, count: 7000, segments: 1, stretch: 0.36 },
    ],
    // Fanned this wide, thinning to nothing at the far end so the grass has no edge.
    fan: 1.8,
    height: [0.22, 0.55],
    width: 0.012,
    thickness: 0.003,
    rootShade: 0.55,
    // Far blades draw wider, so none is thinner than a pixel.
    farFrom: 3,
    farGrowth: 6,
};
// The ground: rows stepping out geometrically from the window, each the same number of splats across, so a splat
// covers about the same of the screen near or far. Each lies flat in the hillside, sized to its row and column so
// neighbours just meet: one layer, few splats.
const TURF = { from: 0.8, to: 180, rows: 95, columns: 80, width: 2.2, spread: 1.5 };
// Cloud shadows, as the grass example casts them: one cloud picture, tiled in two drifting layers at the cloud
// layer's height, looked up from each point toward the sun.
const SHADOWS = {
    height: 160,
    drift: 1.5,
    layers: [
        { tile: 30, angle: 0, speed: 1, offset: 0, weight: 1 },
        { tile: 47, angle: 0.9, speed: 1.25, offset: 0.37, weight: 0.8 },
    ],
    cover: [0.08, 0.6],
    shade: [0.55, 1.1],
};
// A few soft clouds drifting along over the hills, each a cluster of puffs of big faint splats.
// Small puffs: big soft cloud splats overlap so much that a few clouds cost more than the whole room.
const CLOUDS = { count: 7, puffs: 9, perCloud: 1200, from: 70, to: 130, height: [35, 60], drift: 1.2, size: [0.7, 1.6] };
const WIND = { speed: 1.4, scale: 0.08, sway: 0.16 };
const HAZE = { from: 25, to: 170 };
const SKY = {
    horizon: vec3(0.86, 0.88, 0.86),
    zenith: vec3(0.36, 0.56, 0.86),
    sun: new THREE.Vector3(-0.5, 0.45, 0.75).normalize(),
};

const out = vec3(...OUT);
const along = vec3(...ALONG);
const centre = vec3(...BANK_CENTRE);

// Ground height at `o` metres out and `s` along: a gentle fall away from the hull, hills rising beyond.
function ground(o: TslNode, s: TslNode): TslNode {
    const hills = sin(s.mul(0.031).add(1.3))
        .mul(4)
        .add(sin(s.mul(0.017).sub(o.mul(0.021))).mul(6))
        .add(mx_noise_float(vec3(s.mul(0.02), o.mul(0.02), 0)).mul(5))
        .mul(smoothstep(25, 110, o));
    const bumps = mx_noise_float(vec3(s.mul(0.4), o.mul(0.4), 1)).mul(0.12);
    return o.mul(FIELD.slope).add(FIELD.ground).add(hills).add(bumps);
}

function at(o: TslNode, s: TslNode, y: TslNode): TslNode {
    return centre
        .add(out.mul(o))
        .add(along.mul(s))
        .add(vec3(0, y, 0));
}

// A spot out in the field: log-spread outward so each step further holds as many as the last, fanned across.
function spot(a: TslNode, b: TslNode, from: TslNode | number, to: TslNode | number, width: number): { o: TslNode; s: TslNode } {
    const o = exp(mix(float(from).log(), float(to).log(), a));
    return { o, s: b.sub(0.5).mul(2).mul(o.mul(width).add(3)) };
}

function hazed(rgb: TslNode, o: TslNode): TslNode {
    return mix(rgb, SKY.horizon, smoothstep(HAZE.from, HAZE.to, o).mul(0.85));
}

const cloudMap = new THREE.TextureLoader().load(cloudUrl);
cloudMap.wrapS = cloudMap.wrapT = THREE.RepeatWrapping;
const cloudTravel = uniform(new THREE.Vector2()) as TslNode & { value: THREE.Vector2 };
const DRIFT = new THREE.Vector2(ALONG[0], ALONG[2]).normalize();

// Sun reaching a world point, dimmed where a cloud's shadow falls.
function sunlit(p: TslNode): TslNode {
    const sun = vec3(SKY.sun.x, SKY.sun.y, SKY.sun.z);
    const up = float(SHADOWS.height).sub(p.y).div(sun.y);
    const xz = p.xz.add(sun.xz.mul(up));
    let dark: TslNode = float(0);
    for (const layer of SHADOWS.layers) {
        const c = Math.cos(layer.angle);
        const sn = Math.sin(layer.angle);
        const q = xz.sub(cloudTravel.mul(layer.speed));
        const turned = vec2(q.x.mul(c).sub(q.y.mul(sn)), q.x.mul(sn).add(q.y.mul(c)));
        dark = max(dark, texture(cloudMap, turned.div(layer.tile).add(layer.offset)).level(0).r.oneMinus().mul(layer.weight));
    }
    return mix(SHADOWS.shade[1], SHADOWS.shade[0], smoothstep(SHADOWS.cover[0], SHADOWS.cover[1], dark));
}

// Four independent numbers in [0, 1) for item `id` from an integer hash: a float hash of neighbouring indices
// correlates, and across a field shows as a lattice.
const hash4 = (id: TslNode, salt: number): TslNode => {
    const base = uint(id)
        .mul(uint(16))
        .add(uint(salt * 4));
    return vec4(hash(base), hash(base.add(uint(1))), hash(base.add(uint(2))), hash(base.add(uint(3))));
};

const alignY = (dir: TslNode): TslNode => normalize(vec4(cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));
const yaw = (half: TslNode): TslNode => vec4(0, sin(half), 0, cos(half));

// A point `s` (0 root, 1 tip) up a stem leant over by `bend` (world xz, its length the angle): bending from the root,
// curling most at the tip. The point, and the stem's direction there.
function stem(root: TslNode, height: TslNode, bend: TslNode, s: TslNode): { centre: TslNode; tangent: TslNode } {
    const angle = min(length(bend), 1.35).toVar();
    const over = vec3(bend.x, 0, bend.y)
        .div(max(length(bend), 1e-4))
        .toVar();
    const tip = root.add(
        over
            .mul(sin(angle))
            .add(vec3(0, cos(angle), 0))
            .mul(height),
    );
    const knee = root.add(vec3(0, height.mul(0.6), 0)).add(over.mul(height.mul(sin(angle)).mul(0.25)));
    const centre = root
        .mul(s.oneMinus().mul(s.oneMinus()))
        .add(knee.mul(s.oneMinus().mul(s).mul(2)))
        .add(tip.mul(s.mul(s)))
        .toVar();
    const tangent = normalize(knee.sub(root).mul(s.oneMinus()).add(tip.sub(knee).mul(s)));
    return { centre, tangent };
}

// Where each tier's blades start in the blade list, and how many there are in all.
const TIER_START = BLADES.tiers.map((_, t) => BLADES.tiers.slice(0, t).reduce((sum, tier) => sum + tier.count, 0));
const BLADE_COUNT = BLADES.tiers.reduce((sum, tier) => sum + tier.count, 0);
const BLADES_TO = BLADES.tiers[BLADES.tiers.length - 1].to;

// The stretch of field blade `blade`'s tier covers.
function tierReach(blade: TslNode): { from: TslNode; to: TslNode } {
    let from: TslNode = float(FIELD.from);
    let to: TslNode = float(BLADES.tiers[0].to);
    for (let t = 1; t < BLADES.tiers.length; t++) {
        const past = blade.greaterThanEqual(uint(TIER_START[t]));
        from = past.select(float(BLADES.tiers[t - 1].to), from);
        to = past.select(float(BLADES.tiers[t].to), to);
    }
    return { from, to };
}

// The wind's push at a spot: gusts rolling along the wall.
const gustAt = (o: TslNode, s: TslNode): TslNode =>
    mx_noise_float(vec3(s.mul(WIND.scale).add(time.mul(WIND.speed)), o.mul(WIND.scale), 3));

// Everything about a blade, worked out once a frame by a kernel and read by its segments (or, without compute, by
// each segment itself): its root, height, bend, turn, colour, the light on it and the haze over it.
function bladeState(blade: TslNode) {
    const a = hash4(blade, 0).toVar();
    const b = hash4(blade, 1).toVar();
    const reach = tierReach(blade);
    const { o, s } = spot(a.x, a.y, reach.from, reach.to, BLADES.fan);
    const root = at(o, s, ground(o, s)).toVar();
    const lush = mx_noise_float(vec3(s.mul(0.15), o.mul(0.15), 6))
        .mul(0.5)
        .add(0.5);
    const height = mix(BLADES.height[0], BLADES.height[1], pow(b.x, 0.7))
        .mul(mix(0.7, 1.25, lush))
        .mul(smoothstep(BLADES_TO, BLADES_TO * 0.6, o));
    const lean = vec2(b.z, b.w).sub(0.5).mul(0.5);
    const sway = gustAt(o, s).mul(WIND.sway).add(lean.x);
    const bend = vec2(ALONG[0], ALONG[2]).mul(sway).add(vec2(OUT[0], OUT[2]).mul(lean.y));
    // Out where its flowers are too small to see, a drift still tints the grass.
    const bloom = smoothstep(FLOWERS.gather[0], FLOWERS.gather[1], driftAt(o, s)).mul(
        smoothstep(FLOWERS.to * 0.6, FLOWERS.to, o),
    );
    const petals = pick(
        driftKind(o, s).floor(),
        FLOWERS.kinds.map((k) => v3(k.petal)),
    );
    const green = mix(mix(vec3(0.16, 0.3, 0.06), vec3(0.3, 0.46, 0.1), a.z), petals, bloom.mul(FLOWERS.bloom));
    return { root, height, bend, turn: b.y, green, lit: sunlit(root), haze: smoothstep(HAZE.from, HAZE.to, o) };
}

type BladeState = ReturnType<typeof bladeState>;

// The blades' states, packed three vec4s a blade: root + height; bend + turn + lit; green + haze.
function bladeSet(renderer: WebGPURenderer | null): { read: (i: TslNode) => BladeState; kernel: WgpuCompute | null } {
    if (!renderer) return { read: bladeState, kernel: null };
    const buffers = [0, 1, 2].map(() => new WgpuBuffer({ renderer, format: 'float32x4', count: BLADE_COUNT }));
    const kernel = new WgpuCompute({
        label: 'meadow blades',
        body: ({ index }) => {
            If(index.lessThan(uint(BLADE_COUNT)), () => {
                const st = bladeState(index);
                buffers[0].element(index).assign(vec4(st.root, st.height));
                buffers[1].element(index).assign(vec4(st.bend, st.turn, st.lit));
                buffers[2].element(index).assign(vec4(st.green, st.haze));
            });
        },
    });
    const read = (i: TslNode): BladeState => {
        const [p, q, r] = buffers.map((buffer) => buffer.element(i).toVar());
        return { root: p.xyz, height: p.w, bend: q.xy, turn: q.z, lit: q.w, green: r.xyz, haze: r.w };
    };
    return { read, kernel };
}

// One tier of blades, each drawn in its tier's number of segments.
function blades(set: { read: (i: TslNode) => BladeState }, eye: TslNode, t: number): SplatObject {
    const { count, segments, stretch } = BLADES.tiers[t];
    return SplatCollection.object({
        count: count * segments,
        generator: {
            generateSplat(index: TslNode) {
                const blade = index.div(uint(segments)).add(uint(TIER_START[t]));
                const s = float(index.mod(uint(segments)))
                    .add(0.5)
                    .div(segments)
                    .toVar();
                const st = set.read(blade);
                const { centre, tangent } = stem(st.root, st.height, st.bend, s);
                const quaternion = GpuSplatMath.quatMul(alignY(tangent), yaw(st.turn.mul(Math.PI)));
                const widen = clamp(length(centre.sub(eye)).div(BLADES.farFrom), 1, BLADES.farGrowth);
                const taper = mix(1, 0.3, pow(s, 1.6));
                const scales = vec3(
                    float(BLADES.width).mul(taper).mul(widen),
                    st.height.div(segments).mul(stretch),
                    float(BLADES.thickness).mul(widen),
                );
                const body = mix(
                    st.green.mul(BLADES.rootShade),
                    mix(st.green, vec3(0.62, 0.7, 0.26), 0.55),
                    smoothstep(0.1, 1, s),
                );
                return GpuSplats.Splat(
                    centre,
                    scales,
                    quaternion,
                    mix(body.mul(st.lit), SKY.horizon, st.haze.mul(0.85)),
                    float(0.95),
                    uint(index),
                );
            },
        },
    });
}

// Wildflowers, grown as the grass example grows them: in drifts, where a noise field says, each drift led by one
// kind with strays of every kind between. Each kind its own head (a poppy's four broad cupped petals, a daisy's
// yellow eye in a ring of rays, a buttercup's five glossy cups, a cornflower's ragged florets, a knapweed's upright
// tuft); no two petals quite alike, now and then one missing; heads tipped every which way; some still in bud.
// Only near: past `to` a head is a pixel. A little larger than life, to read from indoors.
const FLOWERS = {
    count: 2200,
    from: 1.2,
    to: 24,
    tries: 4,
    stemSegments: 2,
    // Petal slots per flower: the most any kind has.
    slots: 12,
    // Opacity past 1, drawn as a crisp edge.
    crisp: 1.5,
    drift: 0.18,
    gather: [0.15, 0.5],
    strays: 0.05,
    height: [0.28, 0.6],
    buds: 0.15,
    size: 1.6,
    // How far a drift tints the grass past where its flowers show.
    bloom: 0.25,
    stem: [0.2, 0.34, 0.1],
    kinds: [
        { petal: [0.8, 0.17, 0.09], centre: [0.1, 0.08, 0.07], petals: 4, length: 0.02, width: 0.85, cup: 0.55, eye: 0.32 },
        { petal: [0.33, 0.45, 0.84], centre: [0.26, 0.26, 0.55], petals: 9, length: 0.013, width: 0.35, cup: 0.35, eye: 0.38 },
        { petal: [0.9, 0.89, 0.83], centre: [0.9, 0.66, 0.12], petals: 12, length: 0.013, width: 0.34, cup: -0.06, eye: 0.7 },
        { petal: [0.92, 0.77, 0.16], centre: [0.82, 0.62, 0.14], petals: 5, length: 0.009, width: 0.75, cup: 0.75, eye: 0.32 },
        { petal: [0.58, 0.3, 0.58], centre: [0.4, 0.24, 0.32], petals: 10, length: 0.008, width: 0.3, cup: 1.15, eye: 0.7 },
    ],
};

const v3 = ([x, y, z]: readonly number[]): TslNode => vec3(x, y, z);

// `values[kind]`, for a kind held as a float.
function pick(kind: TslNode, values: TslNode[]): TslNode {
    let chosen = values[values.length - 1];
    for (let i = values.length - 2; i >= 0; i--) chosen = kind.lessThan(i + 0.5).select(values[i], chosen);
    return chosen;
}

// The drift field over the ground, 0..1: flowers gather where it's high.
const driftAt = (o: TslNode, s: TslNode): TslNode =>
    mx_noise_float(vec3(s.mul(FLOWERS.drift), o.mul(FLOWERS.drift), 41.7))
        .mul(0.5)
        .add(0.5)
        .sub(0.25);

// Which kind leads the drift there, as a float to floor.
const driftKind = (o: TslNode, s: TslNode): TslNode =>
    mx_noise_float(vec3(s.mul(FLOWERS.drift * 0.6), o.mul(FLOWERS.drift * 0.6), 5.1))
        .mul(0.5)
        .add(0.5)
        .mul(FLOWERS.kinds.length);

// Flower `flower`: where it grows, whether its drift lets it show, how tall, which kind, and how the wind bends it.
function flowerState(flower: TslNode) {
    const b = hash4(flower, 1).toVar();
    const c = hash4(flower, 2).toVar();
    // Each tries a few spots and takes the first in a drift: far fewer flowers for the same show.
    const spotOf = (r: TslNode) => spot(r.x, r.y, FLOWERS.from, FLOWERS.to, BLADES.fan);
    const inDrift = (r: TslNode) => {
        const { o, s } = spotOf(r);
        return driftAt(o, s).greaterThan(FLOWERS.gather[0] + 0.1);
    };
    let a: TslNode = hash4(flower, 0);
    let found: TslNode = inDrift(a);
    for (let k = 1; k < FLOWERS.tries; k++) {
        const next = hash4(flower.add(uint(FLOWERS.count * k)), 0);
        a = found.select(a, next);
        found = found.or(inDrift(next));
    }
    a = a.toVar();
    const { o, s } = spotOf(a);
    const root = at(o, s, ground(o, s)).toVar();
    const here = smoothstep(FLOWERS.gather[0], FLOWERS.gather[1], driftAt(o, s))
        .max(c.z.lessThan(FLOWERS.strays).select(float(1), float(0)))
        .mul(smoothstep(FLOWERS.to, FLOWERS.to * 0.7, o));
    const height = mix(FLOWERS.height[0], FLOWERS.height[1], b.x).toVar();
    // A little stiffer than the grass, each with a lean of its own.
    const sway = gustAt(o, s).mul(WIND.sway * 0.75);
    const bend = vec2(ALONG[0], ALONG[2])
        .mul(sway)
        .add(vec2(cos(b.y.mul(6.283)), sin(b.y.mul(6.283))).mul(0.15));
    // The drift's own kind, or now and then any kind.
    const kinds = FLOWERS.kinds.length;
    const kind = c.w
        .lessThan(0.25)
        .select(c.x.mul(kinds), driftKind(o, s))
        .floor()
        .clamp(0, kinds - 1)
        .toVar();
    return { root, o, here, height, bend, kind, tip: a.zw, b, c };
}

function flowers(eye: TslNode): SplatObject {
    const { stemSegments, slots, kinds } = FLOWERS;
    const parts = stemSegments + slots + 1;
    const of = (key: 'petals' | 'length' | 'width' | 'cup' | 'eye', kind: TslNode) =>
        pick(
            kind,
            kinds.map((k) => float(k[key])),
        );
    const sun = vec3(SKY.sun.x, SKY.sun.y, SKY.sun.z);
    return SplatCollection.object({
        count: FLOWERS.count * parts,
        params: { lodInflate: false },
        generator: {
            generateSplat(index: TslNode) {
                const flower = index.div(uint(parts));
                const part = float(index.mod(uint(parts))).toVar();
                // This petal's own numbers, so no two are alike.
                const own = hash4(index, 3).toVar();
                const { root, o, here, height, bend, kind, tip, b, c } = flowerState(flower);
                const bud = c.y.lessThan(FLOWERS.buds);

                const isStem = part.lessThan(stemSegments);
                const isEye = part.equal(parts - 1);
                const slot = part.sub(stemSegments);
                const along = stem(root, height, bend, part.add(0.5).div(stemSegments).min(1));
                const head = stem(root, height, bend, float(1));

                // The head nods with the stem, turns a little to the sun and the house, and is tipped its own way.
                const tipAngle = tip.x.mul(6.283);
                const tipped = vec3(cos(tipAngle), 0, sin(tipAngle)).mul(tip.y.mul(0.9));
                const facing = normalize(
                    head.tangent
                        .add(vec3(0, 0.5, 0))
                        .add(sun.mul(0.25))
                        .sub(out.mul(0.35))
                        .add(tipped),
                ).toVar();

                // Petals round the head, evenly but not exactly, each its own size, cupped.
                const count = of('petals', kind);
                const scale = b.w.mul(0.5).add(0.75).mul(FLOWERS.size);
                const petal = of('length', kind).mul(scale).mul(own.x.mul(0.4).add(0.8)).toVar();
                const width = of('width', kind).mul(own.y.mul(0.4).add(0.8));
                const cup = of('cup', kind).add(own.z.sub(0.5).mul(0.3));
                const turn = slot.add(own.w.sub(0.5).mul(0.35)).div(count).add(b.z).mul(Math.PI);
                const headTurn = GpuSplatMath.quatMul(alignY(facing), yaw(turn)).toVar();
                const petalTurn = GpuSplatMath.quatMul(headTurn, vec4(0, 0, sin(cup.mul(0.5)), cos(cup.mul(0.5))));
                const eyeSize = of('eye', kind)
                    .mul(of('length', kind))
                    .mul(scale)
                    .mul(bud.select(float(1.4), float(1)))
                    .toVar();
                // Petals radiate from the eye's edge; the eye sits a little proud of them, a dome.
                const petalAt = head.centre.add(
                    GpuSplatMath.quatRotate(petalTurn, vec3(eyeSize.mul(0.8).add(petal.mul(0.95)), 0, 0)),
                );
                const eyeAt = head.centre.add(facing.mul(eyeSize.mul(0.35)));

                const centre = isStem.select(along.centre, isEye.select(eyeAt, petalAt)).toVar();
                const quaternion = isStem.select(alignY(along.tangent), isEye.select(headTurn, petalTurn));
                const scales = isStem.select(
                    vec3(0.003, height.div(stemSegments).mul(0.6), 0.003),
                    isEye.select(vec3(eyeSize, eyeSize.mul(0.6), eyeSize), vec3(petal, 0.0012, petal.mul(width))),
                );

                // The stem and eye always; petals this kind has, one in twenty-five gone, none on a bud.
                const petalShows = slot.lessThan(count).and(own.z.greaterThan(0.04)).and(bud.not());
                const shows = isStem.or(isEye).or(petalShows).select(float(1), float(0));

                // Muted colours, each petal a touch different; a bud green going over to its colour.
                const petalColour = pick(
                    kind,
                    kinds.map((k) => v3(k.petal)),
                ).mul(own.y.mul(0.16).add(0.92));
                const eyeColour = bud.select(
                    mix(
                        v3(FLOWERS.stem),
                        pick(
                            kind,
                            kinds.map((k) => v3(k.petal)),
                        ),
                        0.35,
                    ),
                    pick(
                        kind,
                        kinds.map((k) => v3(k.centre)),
                    ),
                );
                const body = isStem.select(v3(FLOWERS.stem), isEye.select(eyeColour, petalColour));
                // Lit like the grass, brighter turned to the sun, and glowing a little with it behind.
                const faceSun = dot(GpuSplatMath.quatRotate(quaternion, vec3(0, 1, 0)), sun)
                    .abs()
                    .mul(0.5)
                    .add(0.5);
                const through = pow(max(dot(normalize(centre.sub(eye)), sun), 0), 4).mul(isStem.select(float(0), float(0.3)));
                const rgb = body.mul(sunlit(root).mul(faceSun.mul(0.6).add(0.45).add(through)));
                return GpuSplats.Splat(
                    centre,
                    scales,
                    quaternion,
                    hazed(rgb.min(0.95), o),
                    here.mul(shows).mul(isStem.select(float(1), float(FLOWERS.crisp))),
                    uint(index),
                );
            },
        },
    });
}

// The ground itself, under the blades: a surface over the same hills, behind everything like the sky, so the
function turf(): SplatObject {
    const ratio = (TURF.to / TURF.from) ** (1 / TURF.rows);
    // Turned so the splat's x runs along the wall, its z out from it; then tipped to the slope.
    const facing = Math.atan2(-ALONG[2], ALONG[0]);
    return SplatCollection.object({
        count: TURF.rows * TURF.columns,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const row = floor(i.div(TURF.columns));
                const column = i.sub(row.mul(TURF.columns));
                const o = float(TURF.from).mul(pow(float(ratio), row.add(0.5)));
                const reach = o.mul(TURF.width).add(3);
                const s = column.add(0.5).div(TURF.columns).sub(0.5).mul(2).mul(reach);
                const deep = o.mul(ratio - 1);
                const wide = reach.mul(2 / TURF.columns);
                const y = ground(o, s);
                const slopeOut = ground(o.add(0.5), s).sub(y).div(0.5);
                const slopeAlong = ground(o, s.add(0.5)).sub(y).div(0.5);
                const normal = normalize(vec3(0, 1, 0).sub(out.mul(slopeOut)).sub(along.mul(slopeAlong)));
                const where = at(o, s, y);
                const tone = mx_noise_float(vec3(s.mul(0.05), o.mul(0.05), 4))
                    .mul(0.5)
                    .add(0.5);
                const rgb = mix(vec3(0.16, 0.3, 0.07), vec3(0.34, 0.48, 0.13), tone).mul(sunlit(where));
                const colour = mix(hazed(rgb, o), SKY.horizon, smoothstep(TURF.to * 0.7, TURF.to, o));
                const quaternion = GpuSplatMath.quatMul(alignY(normal), yaw(float(facing / 2)));
                const scales = vec3(wide.div(TURF.spread), 0.002, deep.div(TURF.spread));
                return GpuSplats.Splat(where, scales, quaternion, colour, float(1), uint(index));
            },
        },
    });
}

function clouds(): SplatObject {
    return SplatCollection.object({
        count: CLOUDS.count * CLOUDS.perCloud,
        generator: {
            generateSplat(index: TslNode) {
                const cloud = floor(float(index).div(CLOUDS.perCloud));
                const r = hash4(index, 3);
                const c = hash4(cloud, 4);
                const o = mix(CLOUDS.from, CLOUDS.to, c.x);
                const span = o.mul(0.9);
                const s = c.y.mul(2).sub(1).mul(span).add(time.mul(CLOUDS.drift)).add(span).mod(span.mul(2)).sub(span);
                const height = mix(CLOUDS.height[0], CLOUDS.height[1], c.z);
                const puff = floor(r.x.mul(CLOUDS.puffs));
                const p = hash4(cloud.mul(CLOUDS.puffs).add(puff), 5);
                const radius = mix(3.5, 7, p.w).mul(c.w.mul(0.6).add(0.7));
                const offset = vec3(p.x.sub(0.5).mul(30), p.y.mul(5), p.z.sub(0.5).mul(14));
                const angle = r.y.mul(Math.PI * 2);
                const z = r.z.mul(2).sub(1);
                const ring = max(float(1).sub(z.mul(z)), 0).sqrt();
                const inside = vec3(cos(angle).mul(ring), z, sin(angle).mul(ring)).mul(pow(r.w, 0.4)).mul(radius);
                const local = offset.add(vec3(inside.x, max(inside.y, radius.mul(-0.35)), inside.z));
                const where = at(o, s, height)
                    .add(along.mul(local.x))
                    .add(vec3(0, local.y, 0))
                    .add(out.mul(local.z));
                const lift = smoothstep(-6, 10, local.y);
                const sun = vec3(SKY.sun.x, SKY.sun.y, SKY.sun.z);
                const facing = dot(normalize(inside.add(vec3(0, 0.001, 0))), sun)
                    .mul(0.5)
                    .add(0.5);
                const rgb = mix(vec3(0.82, 0.85, 0.9), vec3(1, 0.99, 0.97), lift.mul(0.6).add(facing.mul(0.4)));
                const size = mix(CLOUDS.size[0], CLOUDS.size[1], hash(float(index).mul(7.3)));
                return GpuSplats.Splat(where, vec3(size), vec4(0, 0, 0, 1), mix(rgb, SKY.horizon, 0.25), float(0.6), uint(index));
            },
        },
    });
}

// Butterflies working the flowers near the house, as the grass example has them: each rests on a flower (wings closed
// upright, opening flat now and then to bask, swaying with it), takes off, flies an eased, curving path with a rise in
// the middle and lands on the next. The flowers are the real ones: of a few at random, the one nearest its patch that
// its drift lets show. Kept simple: a body and each side a forewing and a hindwing, the underside duller seen from
// below.
const BUTTERFLIES = {
    count: 16,
    // Where their patches lie: metres out from the wall, and fanned only as wide as the windows see.
    from: 1.5,
    to: 9,
    fan: 0.5,
    choices: 6,
    // Seconds per flower, rest and flight together, and the share spent resting.
    visit: [9, 15],
    rest: [0.25, 0.45],
    // How far a flight swings to the side and rises in the middle, metres.
    swing: 1.2,
    rise: [0.3, 0.8],
    // Wingbeats a second, and a wing's span from the body, metres.
    flap: [3.5, 5.5],
    span: [0.022, 0.03],
    kinds: [
        { fore: [0.96, 0.95, 0.88], hind: [0.95, 0.94, 0.85], under: [0.88, 0.9, 0.7] },
        { fore: [0.94, 0.5, 0.12], hind: [0.86, 0.44, 0.12], under: [0.84, 0.7, 0.45] },
        { fore: [0.45, 0.6, 0.97], hind: [0.47, 0.57, 0.9], under: [0.76, 0.73, 0.68] },
        { fore: [0.97, 0.92, 0.45], hind: [0.95, 0.9, 0.45], under: [0.84, 0.9, 0.55] },
    ],
    body: [0.1, 0.08, 0.06],
};

function butterflies(eye: TslNode): SplatObject {
    const { kinds } = BUTTERFLIES;
    // The body and two wings each side.
    const parts = 5;
    const sun = vec3(SKY.sun.x, SKY.sun.y, SKY.sun.z);
    return SplatCollection.object({
        count: BUTTERFLIES.count * parts,
        params: { lodInflate: false },
        generator: {
            generateSplat(index: TslNode) {
                const fly = index.div(uint(parts));
                const part = float(index.mod(uint(parts))).toVar();
                const id = fly.add(uint(100000));
                const a = hash4(id, 0).toVar();
                const b = hash4(id, 1).toVar();
                const c = hash4(id, 2).toVar();
                const t = time;

                const patch = spot(a.x, a.y, BUTTERFLIES.from, BUTTERFLIES.to, BUTTERFLIES.fan);
                const home = at(patch.o, patch.s, float(0)).xz;

                // The flower of visit k: of a few at random, the nearest that shows; where its head is now.
                const flowerFor = (k: TslNode): TslNode => {
                    let best: TslNode | null = null;
                    let bestScore: TslNode | null = null;
                    for (let j = 0; j < BUTTERFLIES.choices; j++) {
                        const chosen = uint(
                            hash(
                                uint(fly)
                                    .mul(uint(7919))
                                    .add(uint(k).mul(uint(131)))
                                    .add(uint(j)),
                            ).mul(FLOWERS.count),
                        );
                        const flower = flowerState(chosen);
                        const head = stem(flower.root, flower.height, flower.bend, float(1)).centre;
                        const score = length(flower.root.xz.sub(home)).add(flower.here.oneMinus().mul(50));
                        if (!best || !bestScore) {
                            best = head;
                            bestScore = score;
                        } else {
                            const better = score.lessThan(bestScore);
                            best = better.select(head, best);
                            bestScore = better.select(score, bestScore);
                        }
                    }
                    return (best as TslNode).toVar();
                };

                // Visits: rest on one flower, then fly to the next.
                const period = mix(BUTTERFLIES.visit[0], BUTTERFLIES.visit[1], b.x);
                const clock = t.div(period).add(b.y.mul(10));
                const k = clock.floor().toVar();
                const u = clock.fract().toVar();
                const restShare = mix(BUTTERFLIES.rest[0], BUTTERFLIES.rest[1], b.z);
                const before = flowerFor(k.sub(1));
                const from = flowerFor(k);
                const to = flowerFor(k.add(1));

                const v = clamp(u.sub(restShare).div(restShare.oneMinus()), 0, 1).toVar();
                const eased = v.mul(v).mul(v.mul(-2).add(3));
                const across = to.xz.sub(from.xz);
                const side = normalize(vec2(across.y.negate(), across.x).add(1e-5));
                const swing = c.x.sub(0.5).mul(2 * BUTTERFLIES.swing);
                const arc = sin(v.mul(Math.PI));
                const rise = mix(BUTTERFLIES.rise[0], BUTTERFLIES.rise[1], c.y);
                const flying = smoothstep(0, 0.04, v)
                    .mul(smoothstep(1, 0.96, v))
                    .toVar();

                // Wingbeats, now and then a brief glide; resting, closed upright, opening flat now and then.
                const rate = mix(BUTTERFLIES.flap[0], BUTTERFLIES.flap[1], c.z);
                const beat = sin(
                    t
                        .mul(rate)
                        .mul(Math.PI * 2)
                        .add(c.w.mul(6.283)),
                );
                const glide = smoothstep(0.88, 0.97, sin(t.mul(0.8).add(c.z.mul(6.283))));
                const flapping = mix(beat, beat.mul(0.15).add(0.35), glide).mul(0.65).add(0.35);
                const bask = smoothstep(0.55, 0.9, sin(t.mul(0.7).add(a.w.mul(6.283))));
                const wing = mix(mix(1.45, 0.12, bask), flapping, flying);

                const path = mix(from, to, eased)
                    .add(vec3(side.x, 0, side.y).mul(swing.mul(arc.mul(arc))))
                    .add(vec3(0, 1, 0).mul(rise.mul(arc)))
                    .add(vec3(0, 1, 0).mul(beat.mul(0.01).mul(flying)));
                const body = path.add(vec3(0, 0.01, 0)).toVar();

                // Facing the way it last flew while resting, the way it's going in flight.
                const landedFacing = normalize(from.xz.sub(before.xz).add(1e-5));
                const goingFacing = normalize(
                    across.mul(eased.sub(eased.mul(eased)).add(0.02)).add(side.mul(swing.mul(sin(v.mul(Math.PI * 2))).mul(0.6))),
                );
                const ahead = normalize(mix(landedFacing, goingFacing, smoothstep(0, 0.15, v)));
                const facing = yaw(TSL.atan(ahead.x, ahead.y).mul(0.5)).toVar();

                // Parts: 0 the body, then each side a forewing and a hindwing.
                const isBody = part.equal(0);
                const wingPart = part.sub(1).max(0);
                const isHind = wingPart.mod(2).equal(1);
                const flank = wingPart.lessThan(1.5).select(float(-1), float(1));
                const span = mix(BUTTERFLIES.span[0], BUTTERFLIES.span[1], a.z);

                const roll = flank.mul(wing).mul(0.5);
                const hinged = GpuSplatMath.quatMul(facing, vec4(0, 0, sin(roll), cos(roll)));
                const place = isHind.select(vec3(0.4, 0, -0.28), vec3(0.55, 0, 0.2));
                const sweep = isHind.select(float(-0.35), float(0.5));
                const size = isHind.select(vec3(0.3, 0, 0.26), vec3(0.42, 0, 0.28));
                const wingTurn = GpuSplatMath.quatMul(hinged, yaw(flank.mul(sweep).mul(0.5)));
                const wingAt = body.add(GpuSplatMath.quatRotate(hinged, place.mul(vec3(flank, 1, 1)).mul(span)));

                const where = isBody.select(body, wingAt).toVar();
                const quaternion = isBody.select(facing, wingTurn).toVar();
                const scales = isBody.select(vec3(0.0018, 0.0018, span.mul(0.5)), size.mul(span).add(vec3(0, 0.0006, 0)));

                // The kind's wing, or the duller underside seen from below; lit like the flowers, and glowing
                // through towards the sun.
                const kind = a.w.add(c.x).fract().mul(kinds.length).floor();
                const choose = (key: 'fore' | 'hind' | 'under') =>
                    pick(
                        kind,
                        kinds.map((kd) => v3(kd[key])),
                    );
                const view = normalize(where.sub(eye));
                const normal = GpuSplatMath.quatRotate(quaternion, vec3(0, 1, 0));
                const fromBelow = dot(normal, view).greaterThan(0);
                const wingColour = fromBelow.select(choose('under'), isHind.select(choose('hind'), choose('fore')));
                const colour = isBody.select(v3(BUTTERFLIES.body), wingColour);
                const through = pow(max(dot(view, sun), 0), 4).mul(isBody.select(float(0), float(0.5)));
                const faceSun = dot(normal, sun).abs().mul(0.5).add(0.5);
                const rgb = colour.mul(sunlit(where).mul(faceSun.mul(0.6).add(0.45).add(through)));
                const crisp = isBody.select(float(1), float(1.25));
                return GpuSplats.Splat(
                    where,
                    scales,
                    quaternion,
                    hazed(rgb.min(0.97), dot(where.sub(centre), out)),
                    crisp,
                    uint(index),
                );
            },
        },
    });
}

export type Meadow = {
    parts: { ground: SplatObject; grass: SplatObject[]; flowers: SplatObject; butterflies: SplatObject; clouds: SplatObject };
    eye: TslNode & { value: THREE.Vector3 };
    kernel: WgpuCompute | null;
    batch: WgpuComputeBatch | null;
};

export function initMeadow(scene: THREE.Scene, renderer: WebGPURenderer): Meadow {
    scene.add(sky());
    const compute = getGpuCaps(renderer).compute ? renderer : null;
    const set = bladeSet(compute);
    const eye = uniform(new THREE.Vector3()) as TslNode & { value: THREE.Vector3 };
    return {
        parts: {
            ground: turf(),
            grass: BLADES.tiers.map((_, t) => blades(set, eye, t)),
            flowers: flowers(eye),
            butterflies: butterflies(eye),
            clouds: clouds(),
        },
        eye,
        kernel: set.kernel,
        batch: compute ? new WgpuComputeBatch(compute) : null,
    };
}

export function updateMeadow(meadow: Meadow, camera: THREE.Camera, dt: number): void {
    meadow.eye.value.copy(camera.position);
    cloudTravel.value.addScaledVector(DRIFT, SHADOWS.drift * dt);
    if (!meadow.kernel || !meadow.batch) return;
    meadow.batch.add(meadow.kernel, BLADE_COUNT);
    meadow.batch.submit();
}

// The sky, only out past this wall: elsewhere it's black as before, so no other gap in the capture shows it.
function sky(): THREE.Mesh {
    const material = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false });
    const dir = normalize(positionLocal).toVar();
    const sun = vec3(SKY.sun.x, SKY.sun.y, SKY.sun.z);
    const gradient = mix(SKY.horizon, SKY.zenith, pow(max(dir.y, 0), 0.6));
    const glow = pow(max(dot(dir, sun), 0), 24)
        .mul(0.6)
        .add(pow(max(dot(dir, sun), 0), 400).mul(2));
    const colour = gradient.add(vec3(1, 0.9, 0.7).mul(glow));
    material.colorNode = colour.mul(smoothstep(-0.35, 0.05, dot(dir, out)));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(185, 48, 24), material);
    mesh.position.set(...(BANK_CENTRE as [number, number, number]));
    mesh.renderOrder = -2;
    return mesh;
}
