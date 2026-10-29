import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

const { cos, float, fract, hash, mix, sin, smoothstep, sqrt, step, time, uint, uniform, vec3, vec4 } = TSL;

// Splat cooking: two cast-iron pans on the stove's burners, and eggs you crack into them with E. Everything is worked
// out per splat from how long an egg's been in and how hot the pan is there, so it cooks with nothing stored.
// Sizes in metres; the burners were found on the cooker's top with scripts/look.ts.

// Each pan: on its burner's grate (picked in a screenshot of the cooker), its handle out toward a front corner
// (radians about y, 0 along +x, the room's side).
const BURNERS = [
    { centre: [-12.21, 1.096, -10.876] as const, heading: -0.6 },
    { centre: [-12.21, 1.096, -11.244] as const, heading: 0.6 },
];
const PAN = { radius: 0.13, rim: 0.035, base: 0.008, handle: 0.19 };
const EGG = {
    white: 7000,
    yolk: 1400,
    spread: 0.075,
    yolkRadius: 0.021,
    // Seconds: dropping in, the edges setting, the rim crisping.
    drop: 0.18,
    setRate: 0.035,
    brownFrom: [25, 70],
};
const STEAM = { count: 420, rise: 0.4, life: 2.4 };
const REACH = { distance: 3, angle: 0.3 };

type Uniform<T> = TslNode & { value: T };

type Burner = {
    centre: THREE.Vector3;
    // When on the cooking clock its egg went in (far in the past when there's none yet), and that egg's seed.
    crackedAt: Uniform<number>;
    seed: Uniform<number>;
};

export type Cooking = {
    objects: SplatObject[];
    now: Uniform<number>;
    burners: Burner[];
    clock: number;
    pressed: boolean;
    sizzle: Sizzle | null;
};

export function initCooking(): Cooking {
    const now = uniform(0) as Uniform<number>;
    // ?egg=seconds starts with eggs already that far along, for looking at how they cook.
    const head = Number(new URLSearchParams(location.search).get('egg') ?? Number.NaN);
    const objects: SplatObject[] = [];
    const burners = BURNERS.map((spot, i) => {
        const crackedAt = uniform(Number.isNaN(head) ? -1e6 : -head - i * 7) as Uniform<number>;
        const seed = uniform(i * 31) as Uniform<number>;
        const age = now.sub(crackedAt).toVar();
        const centre = vec3(...spot.centre);
        objects.push(pan(centre, spot.heading), hob(centre), egg(centre, PAN.base, age, seed), steam(centre, PAN.base, age));
        return { centre: new THREE.Vector3(...spot.centre), crackedAt, seed };
    });
    return { objects, now, burners, clock: 0, pressed: false, sizzle: null };
}

const toPan = new THREE.Vector3();
const looking = new THREE.Vector3();

// Press E while looking at a pan, close enough, to crack a fresh egg into it.
export function updateCooking(cooking: Cooking, keys: Set<string>, camera: THREE.Camera, dt: number): void {
    cooking.clock += dt;
    cooking.now.value = cooking.clock;
    const down = keys.has('KeyE');
    if (down && !cooking.pressed) {
        camera.getWorldDirection(looking);
        let aimed: Burner | null = null;
        let closest = REACH.angle;
        for (const burner of cooking.burners) {
            toPan.subVectors(burner.centre, camera.position);
            const angle = looking.angleTo(toPan);
            if (toPan.length() < REACH.distance && angle < closest) {
                closest = angle;
                aimed = burner;
            }
        }
        if (aimed) {
            aimed.crackedAt.value = cooking.clock;
            aimed.seed.value = Math.random() * 100;
            cooking.sizzle?.crack();
        }
    }
    cooking.pressed = down;
    if (!cooking.sizzle) return;
    let fry = 0;
    for (const burner of cooking.burners) {
        fry += frying(cooking.clock - burner.crackedAt.value) / (1 + camera.position.distanceToSquared(burner.centre) * 0.4);
    }
    cooking.sizzle.update(fry, dt);
}

// How hard an egg of this age is frying: a rush as it lands, settling to a steady fry, quieter as it cooks out.
function frying(age: number): number {
    if (age < 0.2) return 0;
    return Math.max(0.25, Math.exp(-(age - 0.2) / 6)) * (1 - Math.min(1, age / 240) * 0.6);
}

export function unlockCooking(cooking: Cooking): void {
    cooking.sizzle ??= initSizzle();
}

/* the pan */

function pan(centre: TslNode, heading: number): SplatObject {
    const count = 9000;
    return SplatCollection.object({
        count,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const a = hash(i.mul(1.31));
                const b = hash(i.mul(2.77));
                const c = hash(i.mul(4.13));
                const angle = b.mul(Math.PI * 2);
                const around = vec3(cos(angle), 0, sin(angle));
                const out = vec3(Math.cos(heading), 0, -Math.sin(heading));
                const side = vec3(Math.sin(heading), 0, Math.cos(heading));
                // The base, the rim round it, the handle off one side.
                const base = centre.add(around.mul(sqrt(a).mul(PAN.radius))).add(vec3(0, PAN.base * 0.5, 0));
                const rim = centre.add(around.mul(PAN.radius)).add(vec3(0, c.mul(PAN.rim), 0));
                const handle = centre
                    .add(out.mul(a.mul(PAN.handle).add(PAN.radius)))
                    .add(side.mul(c.sub(0.5).mul(0.026)))
                    .add(vec3(0, a.mul(0.02).add(0.02), 0));
                const part = select3(i.lessThan(5200), base, i.lessThan(8000), rim, handle);
                const iron = mix(vec3(0.05, 0.05, 0.055), vec3(0.11, 0.1, 0.1), c);
                const size = select3(
                    i.lessThan(5200),
                    vec3(0.006, 0.0018, 0.006),
                    i.lessThan(8000),
                    vec3(0.0035),
                    vec3(0.004, 0.004, 0.004),
                );
                return GpuSplats.Splat(part, size, vec4(0, 0, 0, 1), iron, float(0.95), uint(index));
            },
        },
    });
}

// The hot plate's glow, a ring of warm light under the pan.
function hob(centre: TslNode): SplatObject {
    return SplatCollection.object({
        count: 1600,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const angle = hash(i.mul(1.7)).mul(Math.PI * 2);
                const r = mix(PAN.radius * 0.6, PAN.radius * 1.02, hash(i.mul(3.1)));
                const at = centre.add(vec3(cos(angle).mul(r), 0.002, sin(angle).mul(r)));
                const flicker = sin(time.mul(3).add(i)).mul(0.15).add(0.85);
                return GpuSplats.Splat(
                    at,
                    vec3(0.012, 0.002, 0.012),
                    vec4(0, 0, 0, 1),
                    vec3(1, 0.32, 0.08),
                    float(0.08).mul(flicker),
                    uint(index),
                );
            },
        },
    });
}

/* the egg */

function egg(centre: TslNode, floor: number, age: TslNode, seed: TslNode): SplatObject {
    const count = EGG.white + EGG.yolk;
    return SplatCollection.object({
        count,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const present = step(0, age);
                const isYolk = i.lessThan(EGG.yolk);
                const a = hash(i.mul(1.13).add(seed));
                const b = hash(i.mul(2.31).add(seed));
                const c = hash(i.mul(3.71).add(seed));
                const angle = b.mul(Math.PI * 2);

                // Dropping in, then spreading into a pool with a wobbly edge.
                const fall = smoothstep(0, EGG.drop, age);
                const spread = smoothstep(EGG.drop * 0.6, 1.4, age);
                const wobble = float(1)
                    .add(sin(angle.mul(3).add(seed)).mul(0.17))
                    .add(sin(angle.mul(5).add(seed.mul(2))).mul(0.09));
                const reach = mix(0.016, EGG.spread, spread).mul(wobble);
                const r = sqrt(a).mul(reach);
                const outward = r.div(reach.max(0.001));
                const lift = float(0.25).mul(float(1).sub(fall).pow(2));
                const thickness = float(0.006)
                    .mul(float(1).sub(outward.mul(outward)))
                    .add(0.0015);
                const white = centre.add(
                    vec3(cos(angle).mul(r), float(floor).add(c.mul(thickness)).add(lift), sin(angle).mul(r)),
                );

                // The yolk: a dome a little off-centre.
                const theta = c.mul(Math.PI * 0.5);
                const dome = vec3(cos(angle).mul(sin(theta)), cos(theta).mul(0.72), sin(angle).mul(sin(theta)));
                const yolk = centre
                    .add(vec3(0.008, float(floor).add(0.004).add(lift), -0.005))
                    .add(dome.mul(EGG.yolkRadius * 0.95));

                // Heat's highest in the middle of the pan; the thin edges set first, and the rim crisps.
                const heat = float(1).sub(outward.mul(outward).mul(0.35));
                const set = smoothstep(
                    0,
                    1,
                    age.mul(EGG.setRate).mul(heat).add(outward.mul(0.6)).sub(0.35).add(c.sub(0.5).mul(0.15)),
                );
                const brown = smoothstep(EGG.brownFrom[0], EGG.brownFrom[1], age).mul(smoothstep(0.82, 1, outward));
                const lace = step(0.55, hash(i.mul(9.7).add(seed))).mul(brown);
                const whiteColour = mix(mix(vec3(0.86, 0.86, 0.76), vec3(0.98, 0.97, 0.93), set), vec3(0.72, 0.45, 0.2), brown);
                const whiteOpacity = mix(0.16, 0.97, set).mul(float(1).sub(lace.mul(0.85)));
                const yolkColour = mix(vec3(1, 0.6, 0.05), vec3(0.95, 0.72, 0.3), smoothstep(30, 120, age));

                const at = select3(isYolk, yolk, isYolk, yolk, white);
                const rgb = select3(isYolk, yolkColour, isYolk, yolkColour, whiteColour);
                const opacity = select3(isYolk, float(1), isYolk, float(1), whiteOpacity).mul(present);
                const size = select3(isYolk, vec3(0.0042), isYolk, vec3(0.0042), vec3(0.0042, 0.0016, 0.0042));
                return GpuSplats.Splat(at, size, vec4(0, 0, 0, 1), rgb, opacity, uint(index));
            },
        },
    });
}

/* steam */

function steam(centre: TslNode, floor: number, age: TslNode): SplatObject {
    return SplatCollection.object({
        count: STEAM.count,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const life = fract(time.div(STEAM.life).add(hash(i.mul(1.9))));
                const angle = hash(i.mul(2.9)).mul(Math.PI * 2);
                const from = sqrt(hash(i.mul(4.1))).mul(EGG.spread);
                const curl = sin(life.mul(5).add(i)).mul(0.03).mul(life);
                const at = centre.add(
                    vec3(
                        cos(angle).mul(from).add(curl),
                        float(floor).add(0.01).add(life.mul(STEAM.rise)),
                        sin(angle).mul(from).add(curl.mul(0.6)),
                    ),
                );
                // Strongest while the egg's fresh and wet, fading as it cooks out.
                const amount = smoothstep(0.2, 1, age)
                    .mul(
                        float(1)
                            .sub(smoothstep(40, 120, age))
                            .mul(0.7)
                            .add(0.3),
                    )
                    .mul(step(0, age));
                const opacity = float(0.1)
                    .mul(smoothstep(0, 0.15, life))
                    .mul(float(1).sub(life))
                    .mul(amount);
                const size = vec3(mix(0.012, 0.05, life));
                return GpuSplats.Splat(at, size, vec4(0, 0, 0, 1), vec3(0.92, 0.92, 0.95), opacity, uint(index));
            },
        },
    });
}

// Three-way pick: a when first, b when second, else c.
function select3(first: TslNode, a: TslNode, second: TslNode, b: TslNode, c: TslNode): TslNode {
    return TSL.select(first, a, TSL.select(second, b, c));
}

/* the sizzle */

type Sizzle = { crack(): void; update(fry: number, dt: number): void };

const SIZZLE_URLS = Object.values(
    import.meta.glob<string>('../assets/sounds/cooking/sizzle.*.ogg', { eager: true, query: '?url', import: 'default' }),
);
const CRACK_URL = Object.values(
    import.meta.glob<string>('../assets/sounds/cooking/crack.ogg', { eager: true, query: '?url', import: 'default' }),
)[0];
// A bed of short recorded sizzles, layered at random: more of them the harder it fries, each a little different.
const SIZZLE = { perSecond: 9, volume: 0.09, cents: 300, soften: [3500, 7000], crack: 0.35 };

function initSizzle(): Sizzle {
    const context = new AudioContext();
    const load = async (url: string) => context.decodeAudioData(await (await fetch(url)).arrayBuffer());
    let clips: AudioBuffer[] = [];
    let crackClip: AudioBuffer | null = null;
    Promise.all(SIZZLE_URLS.map(load)).then((loaded) => {
        clips = loaded;
    });
    load(CRACK_URL).then((loaded) => {
        crackClip = loaded;
    });

    const play = (clip: AudioBuffer, volume: number, cents: number, soften: number) => {
        const source = context.createBufferSource();
        source.buffer = clip;
        source.detune.value = cents;
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = soften;
        const gain = context.createGain();
        gain.gain.value = volume;
        source.connect(filter).connect(gain).connect(context.destination);
        source.start();
    };

    return {
        crack() {
            if (crackClip) play(crackClip, SIZZLE.crack, (Math.random() - 0.5) * 200, 9000);
        },
        update(fry, dt) {
            if (clips.length === 0 || Math.random() > fry * SIZZLE.perSecond * dt) return;
            const clip = clips[Math.floor(Math.random() * clips.length)];
            const soften = SIZZLE.soften[0] + Math.random() * (SIZZLE.soften[1] - SIZZLE.soften[0]);
            play(
                clip,
                Math.min(fry, 1.5) * SIZZLE.volume * (0.6 + Math.random() * 0.4),
                (Math.random() - 0.5) * SIZZLE.cents * 2,
                soften,
            );
        },
    };
}
