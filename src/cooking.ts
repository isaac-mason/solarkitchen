import { GpuSplatMath, GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from '@sparkjsdev/radix';
import * as THREE from 'three';

const {
    cos,
    dot,
    exp,
    float,
    fract,
    hash,
    max,
    mix,
    normalize,
    pow,
    sin,
    smoothstep,
    sqrt,
    step,
    time,
    uint,
    uniform,
    vec3,
    vec4,
} = TSL;

// Splat cooking: two cast-iron pans on the stove's burners, an egg in one and rashers in the other. E shakes the egg
// round its pan or turns the rashers; F swaps in a fresh egg or fresh rashers. Everything is worked out per splat from how long an egg's been in and how hot the pan is there, so it cooks with nothing stored.
// Sizes in metres; the burners were found on the cooker's top with scripts/look.ts.

// Each pan: on its burner's grate (picked in a screenshot of the cooker), its handle out toward a front corner
// (radians about y, 0 along +x, the room's side).
const BURNERS = [
    { centre: [-12.27, 1.096, -10.876] as const, heading: -0.6, food: 'egg' as const, use: 'shake', replace: 'cook eggs' },
    { centre: [-12.27, 1.096, -11.244] as const, heading: 0.6, food: 'bacon' as const, use: 'flip', replace: 'cook bacon' },
];
type Food = (typeof BURNERS)[number]['food'];
const PAN = { radius: 0.13, rim: 0.035, base: 0.008, handle: 0.19 };
const EGG = {
    // Each egg's surface: the white in rings out from under the yolk, the yolk a cap of rings over it.
    rings: 14,
    spokes: 52,
    yolkRings: 9,
    yolkAround: 30,
    spread: 0.062,
    // Where the two eggs land either side of the pan's middle (metres in x and z), and how much later the second.
    apart: [0.03, 0.035],
    second: 0.3,
    yolkRadius: 0.021,
    // How flat the yolk sits, and how far round its cap goes (radians from the top).
    yolkHeight: 0.72,
    yolkCap: 1.35,
    // The white's height: a thick collar round the yolk, thinning to a frilly edge, metres.
    thick: 0.0042,
    thin: 0.0011,
    // Seconds: dropping in, the edges setting, the rim crisping.
    drop: 0.18,
    setRate: 0.28,
    brownFrom: [5, 14],
};
// The light the eggs shine in, and roughly where you see them from, for the gloss on the yolk and the raw white.
const SHINE = { light: [0.5, 1, 0.25], eye: [1, 1.3, 0] };
const BACON = {
    rashers: 3,
    // Each rasher a strip of long thin splats lying along it: this many along, this many across.
    along: 32,
    across: 7,
    length: 0.19,
    width: 0.03,
    gap: 0.052,
    // Seconds: laying in, cooked through, crisp; how much it shrinks and how high its ripples and ends curl.
    drop: 0.2,
    cooked: [0.8, 5],
    crisp: [7, 16],
    shrink: 0.22,
    ripple: 0.006,
    curl: 0.018,
    // Turning, rasher after rasher: seconds each takes, the gap between them, and how high it's tossed, metres.
    turn: 0.7,
    stagger: 0.12,
    toss: 0.06,
    // How far its ends hang below its middle in the air, and its little bounce on landing (metres, Hz, how fast it dies).
    droop: 0.025,
    bounce: [0.004, 22, 9],
};
// A mug of coffee on the island, steaming: ceramic shell and handle, the coffee's surface with a crema ring.
const COFFEE = {
    at: [-10.81, 0.995, -10.95] as const,
    radius: 0.042,
    height: 0.095,
    wall: 0.005,
    shell: 4200,
    handle: 900,
    surface: 900,
    wisps: 3,
    perWisp: 110,
};
const STEAM = { wisps: 6, perWisp: 160, rise: 0.45, life: 3.2, opacity: 0.05, strength: { egg: 0.7, bacon: 1 } };
const REACH = { distance: 3, angle: 0.3 };
// A shake: how hard (metres), how fast it swings (radians a second) and settles; the egg slides after the pan, and
// the yolk after the egg.
const SHAKE = { pan: 0.006, egg: 0.016, yolk: 0.007, swing: 15, settle: 3.5, slide: [0.06, 9, 2.2], wobble: [0.12, 8, 2] };

type Uniform<T> = TslNode & { value: T };

type Burner = {
    centre: THREE.Vector3;
    heading: number;
    // What E and F do to it, as the prompt by the crosshair says.
    actions: { use: string; replace: string };
    food: Food;
    // When on the cooking clock the food went in (far in the future while the pan's empty), and its seed.
    crackedAt: Uniform<number>;
    seed: Uniform<number>;
    shake: Shake;
};

// The last shake of a pan: when, how long ago, and which way.
type Shake = { at: number; since: Uniform<number>; way: Uniform<THREE.Vector3>; count: Uniform<number> };

export type Cooking = {
    objects: SplatObject[];
    now: Uniform<number>;
    burners: Burner[];
    clock: number;
    held: Set<string>;
    prompt: { box: HTMLElement; use: HTMLElement; replace: HTMLElement; showing: string };
    sizzle: Sizzle | null;
};

export function initCooking(): Cooking {
    const now = uniform(0) as Uniform<number>;
    // ?egg=seconds starts with eggs already that far along, for looking at how they cook.
    const head = Number(new URLSearchParams(location.search).get('egg') ?? Number.NaN);
    const objects: SplatObject[] = [];
    const burners = BURNERS.map((spot, i) => {
        const crackedAt = uniform(Number.isNaN(head) ? 1e6 : -head - i * 7) as Uniform<number>;
        const seed = uniform(i * 31) as Uniform<number>;
        const age = now.sub(crackedAt).toVar();
        const centre = vec3(...spot.centre);
        const shake = {
            at: -1e6,
            since: uniform(1e6) as Uniform<number>,
            way: uniform(new THREE.Vector3()) as Uniform<THREE.Vector3>,
            count: uniform(0) as Uniform<number>,
        };
        const shaken = centre.add(swing(shake, 0, SHAKE.swing, SHAKE.settle, SHAKE.pan));
        const food = spot.food === 'bacon' ? bacon(shaken, PAN.base, age, seed, shake) : egg(shaken, PAN.base, age, seed, shake);
        objects.push(pan(shaken, spot.heading), hob(centre), food, steam(centre, PAN.base, age, STEAM.strength[spot.food]));
        return {
            centre: new THREE.Vector3(...spot.centre),
            heading: spot.heading,
            actions: { use: spot.use, replace: spot.replace },
            food: spot.food,
            crackedAt,
            seed,
            shake,
        };
    });
    objects.push(coffee(), coffeeSteam());
    const box = document.getElementById('prompt') as HTMLElement;
    const prompt = {
        box,
        use: box.querySelector('.use') as HTMLElement,
        replace: box.querySelector('.replace') as HTMLElement,
        showing: '',
    };
    return { objects, now, burners, clock: 0, held: new Set(), prompt, sizzle: null };
}

const toPan = new THREE.Vector3();
const looking = new THREE.Vector3();

// The pan you're looking at, close enough to reach.
function aimedAt(cooking: Cooking, camera: THREE.Camera): Burner | null {
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
    return aimed;
}

// E only once there's something in the pan to shake or turn.
function showPrompt(prompt: Cooking['prompt'], aimed: Burner | null, full: boolean): void {
    const showing = aimed ? `${aimed.food} ${full}` : '';
    if (prompt.showing === showing) return;
    prompt.showing = showing;
    prompt.box.classList.toggle('shown', aimed !== null);
    if (!aimed) return;
    prompt.use.textContent = aimed.actions.use;
    (prompt.use.parentElement as HTMLElement).hidden = !full;
    prompt.replace.textContent = aimed.actions.replace;
}

// E, the main action: shake the eggs' pan, or turn the rashers (with a smaller jolt of their pan).
function use(cooking: Cooking, burner: Burner): void {
    const { shake } = burner;
    shake.at = cooking.clock;
    // Mostly along the handle, as you'd shake it, a little either side.
    const angle = burner.heading + (Math.random() - 0.5) * 1.2;
    const strength = burner.food === 'bacon' ? 0.4 : 1;
    shake.way.value.set(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(strength);
    shake.count.value += 1;
    cooking.sizzle?.stir(strength);
}

// F, the other: fresh eggs cracked in, or fresh rashers laid.
function replace(cooking: Cooking, burner: Burner): void {
    burner.crackedAt.value = cooking.clock;
    burner.seed.value = Math.random() * 100;
    burner.shake.at = -1e6;
    burner.shake.count.value = 0;
    cooking.sizzle?.start(burner.food);
}

export function updateCooking(cooking: Cooking, keys: Set<string>, camera: THREE.Camera, dt: number): void {
    cooking.clock += dt;
    cooking.now.value = cooking.clock;
    const aimed = aimedAt(cooking, camera);
    showPrompt(cooking.prompt, aimed, aimed !== null && cooking.clock >= aimed.crackedAt.value);
    const pressed = (key: string) => keys.has(key) && !cooking.held.has(key);
    if (aimed && pressed('KeyE')) use(cooking, aimed);
    else if (aimed && pressed('KeyF')) replace(cooking, aimed);
    cooking.held = new Set(['KeyE', 'KeyF'].filter((key) => keys.has(key)));
    for (const { shake } of cooking.burners) shake.since.value = cooking.clock - shake.at;
    if (!cooking.sizzle) return;
    let fry = 0;
    for (const burner of cooking.burners) {
        fry +=
            frying(burner.food, cooking.clock - burner.crackedAt.value) /
            (1 + camera.position.distanceToSquared(burner.centre) * 0.4);
    }
    cooking.sizzle.update(fry, dt);
}

// How hard food of this age is frying: a rush as it lands, settling to a steady fry, quieter as it cooks out. Bacon
// renders its fat and keeps spitting for longer.
function frying(food: Food, age: number): number {
    if (age < 0.2) return 0;
    if (food === 'bacon') return 1.3 * Math.max(0.5, Math.exp(-(age - 0.2) / 4)) * (1 - Math.min(1, age / 25) * 0.5);
    return Math.max(0.25, Math.exp(-(age - 0.2) / 2.5)) * (1 - Math.min(1, age / 20) * 0.6);
}

export function unlockCooking(cooking: Cooking): void {
    cooking.sizzle ??= initSizzle();
}

/* the pan */

// Where a shake has something now: swinging along the shake's way, starting `delay` seconds after it, dying away.
function swing(shake: Shake, delay: number, rate: number, settle: number, amount: number): TslNode {
    const t = max(shake.since.sub(delay), 0);
    return shake.way.mul(
        sin(t.mul(rate))
            .mul(exp(t.mul(-settle)))
            .mul(amount),
    );
}

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

// The burner's flames: a ring of gas tongues licking out from under the pan and up its side, blue at the root and
// orange at the tip, each flickering to its own beat; over a faint ember glow on the grate. All outside the pan's
// rim and below its base, so none shows through the iron.
const FLAME = { tongues: 30, perTongue: 28, embers: 400, reach: 0.01, climb: 0.022, flicker: [9, 23] };

function hob(centre: TslNode): SplatObject {
    const flames = FLAME.tongues * FLAME.perTongue;
    return SplatCollection.object({
        count: flames + FLAME.embers,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const isEmber = i.greaterThanEqual(flames);

                // A tongue: out from under the rim, then bending up the pan's side, its length dancing.
                const tongue = TSL.floor(i.div(FLAME.perTongue));
                const t = i
                    .mod(FLAME.perTongue)
                    .add(hash(i.mul(5.3)).sub(0.5))
                    .div(FLAME.perTongue)
                    .clamp(0, 1);
                const own = hash(tongue.mul(3.7));
                const dance = sin(time.mul(FLAME.flicker[0]).add(own.mul(40)))
                    .mul(0.25)
                    .add(sin(time.mul(FLAME.flicker[1]).add(own.mul(17))).mul(0.15))
                    .add(0.75);
                const along = t.mul(dance);
                const sway = sin(time.mul(6).add(own.mul(30)))
                    .mul(0.06)
                    .mul(along);
                const angle = tongue
                    .add(own.mul(0.6))
                    .div(FLAME.tongues)
                    .mul(Math.PI * 2)
                    .add(sway);
                const r = float(PAN.radius * 1.03).add(smoothstep(0, 0.5, along).mul(FLAME.reach));
                const flame = centre.add(
                    vec3(cos(angle).mul(r), float(-0.004).add(along.mul(along).mul(FLAME.climb)), sin(angle).mul(r)),
                );
                const thin = float(1).sub(along.mul(0.6));
                const flameColour = mix(vec3(0.3, 0.42, 0.85), vec3(0.95, 0.6, 0.32), smoothstep(0.45, 0.95, along));
                const flameOpacity = smoothstep(1, 0.6, t)
                    .mul(smoothstep(0, 0.15, t))
                    .mul(mix(0.1, 0.18, along));

                // The embers: a dim, slow-breathing ring on the grate round the pan.
                const e = hash(i.mul(1.7)).mul(Math.PI * 2);
                const er = mix(PAN.radius * 1.04, PAN.radius * 1.2, hash(i.mul(3.1)));
                const ember = centre.add(vec3(cos(e).mul(er), -0.007, sin(e).mul(er)));
                const breathe = sin(time.mul(1.3).add(e.mul(3)))
                    .mul(0.3)
                    .add(0.7);

                return GpuSplats.Splat(
                    isEmber.select(ember, flame),
                    isEmber.select(vec3(0.007, 0.0015, 0.007), vec3(0.0022).mul(thin)),
                    vec4(0, 0, 0, 1),
                    isEmber.select(vec3(0.9, 0.25, 0.06), flameColour),
                    isEmber.select(float(0.022).mul(breathe), flameOpacity),
                    uint(index),
                );
            },
        },
    });
}

/* the egg */

function egg(inPan: TslNode, floor: number, cracked: TslNode, seeded: TslNode, shake: Shake): SplatObject {
    // Shaken, the egg slides after the pan on its oil and back, the yolk sloshing after it; ripples run out across
    // the white.
    const [eggDelay, eggRate, eggSettle] = SHAKE.slide;
    const [yolkDelay, yolkRate, yolkSettle] = SHAKE.wobble;
    const slid = inPan.add(swing(shake, eggDelay, eggRate, eggSettle, SHAKE.egg)).toVar();
    const yolkSlosh = swing(shake, yolkDelay, yolkRate, yolkSettle, SHAKE.yolk);
    const settling = exp(shake.since.mul(-2.5)).mul(smoothstep(0, 0.05, shake.since));
    const yolks = EGG.yolkRings * EGG.yolkAround;
    const each = yolks + EGG.rings * EGG.spokes;
    const light = normalize(vec3(...SHINE.light));
    const half = normalize(light.add(normalize(vec3(...SHINE.eye))));
    return SplatCollection.object({
        count: each * 2,
        generator: {
            generateSplat(index: TslNode) {
                // Two eggs, side by side, the second dropping in a moment after the first.
                const second = index.greaterThanEqual(uint(each));
                const k = float(index).sub(second.select(float(each), float(0)));
                const side = second.select(float(1), float(-1));
                const seed = seeded.add(second.select(float(17.3), float(0)));
                const age = cracked.sub(second.select(float(EGG.second), float(0)));
                const centre = slid.add(vec3(side.mul(EGG.apart[0]), 0, side.mul(EGG.apart[1])));
                const present = step(0, age);
                const isYolk = k.lessThan(yolks);
                const fall = smoothstep(0, EGG.drop, age);
                const lift = float(0.25).mul(float(1).sub(fall).pow(2));

                // The yolk: a flattened dome, each splat lying in its surface, wobbling as it sloshes.
                const yolkRing = TSL.floor(k.div(EGG.yolkAround));
                const theta = yolkRing.add(0.5).div(EGG.yolkRings).mul(EGG.yolkCap);
                const phi = k
                    .sub(yolkRing.mul(EGG.yolkAround))
                    .add(0.5)
                    .add(yolkRing.mul(0.5))
                    .div(EGG.yolkAround)
                    .mul(Math.PI * 2);
                const squash = float(1).add(sin(shake.since.mul(22)).mul(settling).mul(0.3));
                const height = squash.mul(EGG.yolkHeight);
                const round = vec3(cos(phi), 0, sin(phi));
                const yolk = centre
                    .add(vec3(0.008, float(floor).add(0.0035).add(lift), -0.005))
                    .add(yolkSlosh.mul(cos(theta).mul(0.7).add(0.4)))
                    .add(round.mul(sin(theta).mul(EGG.yolkRadius)))
                    .add(vec3(0, cos(theta).mul(height).mul(EGG.yolkRadius), 0));
                const yolkNormal = normalize(round.mul(sin(theta).mul(height)).add(vec3(0, cos(theta), 0)));
                const yolkScales = vec3(
                    (EGG.yolkRadius * EGG.yolkCap * 0.85) / EGG.yolkRings,
                    0.0006,
                    max(sin(theta).mul((Math.PI * 2 * EGG.yolkRadius * 0.8) / EGG.yolkAround), 0.0018),
                );

                // The white: rings out from the middle, a thick collar round the yolk thinning to a frilly edge.
                const w = k.sub(yolks);
                const ring = TSL.floor(w.div(EGG.spokes));
                const t = ring.add(0.5).div(EGG.rings);
                const angle = w
                    .sub(ring.mul(EGG.spokes))
                    .add(0.5)
                    .add(hash(ring.add(seed)))
                    .div(EGG.spokes)
                    .mul(Math.PI * 2);
                const spreading = smoothstep(EGG.drop * 0.6, 1.4, age);
                const wobble = float(1)
                    .add(sin(angle.mul(3).add(seed)).mul(0.17))
                    .add(sin(angle.mul(5).add(seed.mul(2))).mul(0.09))
                    .add(
                        sin(angle.mul(13).add(seed.mul(3)))
                            .mul(0.04)
                            .mul(t.pow(3)),
                    );
                const reach = mix(0.016, EGG.spread, spreading).mul(wobble);
                const r = t.mul(reach);
                const out = vec3(cos(angle), 0, sin(angle));
                const piled = mix(2, 1, spreading);
                const profile = (at: TslNode) => mix(EGG.thin, EGG.thick, smoothstep(0.8, 0.3, at)).mul(piled);
                const rise = profile(t);
                const slope = profile(t.add(0.03)).sub(rise).div(reach.mul(0.03));
                const ripple = sin(r.mul(160).sub(shake.since.mul(30)))
                    .mul(settling)
                    .mul(0.0012);
                const white = centre.add(out.mul(r)).add(vec3(0, float(floor).add(rise).add(lift).add(ripple.max(-0.0005)), 0));
                const whiteNormal = normalize(vec3(0, 1, 0).sub(out.mul(slope)));
                const whiteScales = vec3(
                    reach.div(EGG.rings).mul(1.2),
                    0.0007,
                    max(r.mul((Math.PI * 2 * 1.2) / EGG.spokes), 0.0022),
                );

                // Heat's highest in the middle of the pan; the thin edges set first, and the rim crisps to lace.
                const heat = float(1).sub(t.mul(t).mul(0.35));
                const jitter = hash(k.mul(3.71).add(seed));
                const set = smoothstep(
                    0,
                    1,
                    age.mul(EGG.setRate).mul(heat).add(t.mul(0.6)).sub(0.35).add(jitter.sub(0.5).mul(0.15)),
                );
                const brown = smoothstep(EGG.brownFrom[0], EGG.brownFrom[1], age).mul(smoothstep(0.72, 1, t));
                const lace = step(0.6, hash(k.mul(9.7).add(seed)))
                    .mul(brown)
                    .mul(smoothstep(0.85, 1, t));
                const toasted = mix(vec3(0.88, 0.66, 0.36), vec3(0.6, 0.36, 0.16), smoothstep(0.85, 1, t));
                const whiteColour = mix(mix(vec3(0.8, 0.82, 0.78), vec3(0.98, 0.97, 0.94), set), toasted, brown);
                const whiteOpacity = mix(0.3, 0.97, set).mul(float(1).sub(lace.mul(0.9)));
                const yolkSet = smoothstep(6, 20, age);
                const yolkColour = mix(
                    mix(vec3(1, 0.64, 0.1), vec3(0.93, 0.44, 0.04), smoothstep(0.4, 1.2, theta)),
                    vec3(0.98, 0.76, 0.36),
                    yolkSet,
                );

                // Lit: shaded by its surface's turn to the light, and glossy while it's wet.
                const normal = isYolk.select(yolkNormal, whiteNormal);
                const gloss = isYolk.select(mix(0.22, 0.04, yolkSet), mix(0.3, 0.04, set));
                const shade = dot(normal, light).mul(0.3).add(0.75);
                const shine = pow(max(dot(normal, half), 0), 50).mul(gloss);
                const body = isYolk.select(yolkColour, whiteColour);
                const rgb = body.mul(shade).add(shine).min(1);

                const quaternion = GpuSplatMath.quatMul(alignY(normal), yaw(isYolk.select(phi, angle).mul(-0.5)));
                return GpuSplats.Splat(
                    isYolk.select(yolk, white),
                    isYolk.select(yolkScales, whiteScales),
                    quaternion,
                    rgb,
                    isYolk.select(float(1), whiteOpacity).mul(present),
                    uint(index),
                );
            },
        },
    });
}

// A turn that takes y to `dir`, and one about y by twice `half`.
const alignY = (dir: TslNode): TslNode => normalize(vec4(TSL.cross(vec3(0, 1, 0), dir), dir.y.add(1.0001)));
const yaw = (half: TslNode): TslNode => vec4(0, sin(half), 0, cos(half));

/* bacon */

// Each rasher is a strip of splats in rows along it, each splat long and flat, tilted to the strip's ripples so the
// light catches their crests. Streaky: bands of fat running its length, one edge mostly fat, the edges a little
// ragged; browning first at the edges and on the crests.
function bacon(centre: TslNode, floor: number, age: TslNode, seed: TslNode, shake: Shake): SplatObject {
    const perRasher = BACON.along * BACON.across;
    return SplatCollection.object({
        count: BACON.rashers * perRasher,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const present = step(0, age);
                const rasher = TSL.floor(i.div(perRasher));
                const k = i.sub(rasher.mul(perRasher));
                const row = TSL.floor(k.div(BACON.across));
                const own = hash(rasher.mul(7.3).add(seed));
                const u = row.add(0.5).div(BACON.along).sub(0.5);
                const w = k.sub(row.mul(BACON.across)).add(0.5).div(BACON.across).sub(0.5);

                // Laid in a row across the pan, each a little askew; shrinking and rippling as it cooks, ends curling.
                const fall = smoothstep(0, BACON.drop, age);
                const done = smoothstep(BACON.cooked[0], BACON.cooked[1], age);
                const crisp = smoothstep(BACON.crisp[0], BACON.crisp[1], age);
                const length = mix(BACON.length, BACON.length * (1 - BACON.shrink), done);
                const along = u.mul(length);
                const wave = u.mul(38).add(own.mul(20));
                const rippling = mix(0.0015, BACON.ripple, done);
                const ripple = sin(wave).mul(rippling);
                const curl = u.mul(2).pow(4).mul(BACON.curl).mul(done);
                const rise = ripple.max(0).add(curl);
                const slope = ripple
                    .greaterThan(0)
                    .select(cos(wave).mul(rippling).mul(38), float(0))
                    .add(
                        u
                            .mul(2)
                            .pow(3)
                            .mul(BACON.curl * 8)
                            .mul(done),
                    )
                    .div(length);
                const ragged = float(1)
                    .add(sin(u.mul(21).add(own.mul(13))).mul(0.08))
                    .add(sin(u.mul(47).add(own.mul(3))).mul(0.04));
                const width = w.mul(BACON.width).mul(ragged);

                // Turning, on E: each rasher, one after another, peels up, arcs over with its ends hanging, rolls
                // over about its length and drops back with a little bounce. It rolls on from however it lies after the
                // turns before, and its ripples and curl always rise from the pan.
                const since = shake.since.sub(rasher.mul(BACON.stagger));
                const over = smoothstep(0, BACON.turn, since);
                const roll = smoothstep(0.12, 0.88, over);
                const airborne = sin(over.mul(Math.PI));
                const turn = shake.count.sub(1).add(roll).max(0).mul(Math.PI);
                const across = width.mul(cos(turn)).add(rasher.sub((BACON.rashers - 1) / 2).mul(BACON.gap));
                const landed = max(since.sub(BACON.turn), 0);
                const [bounce, bounceRate, bounceSettle] = BACON.bounce;
                const hop = sin(landed.mul(bounceRate))
                    .mul(exp(landed.mul(-bounceSettle)))
                    .mul(bounce)
                    .mul(step(BACON.turn, since))
                    .abs();
                const height = width
                    .mul(sin(turn))
                    .add(rise)
                    .add(airborne.pow(0.7).mul(BACON.toss))
                    .sub(u.mul(2).pow(2).mul(BACON.droop).mul(airborne))
                    .add(hop);

                const skew = own.sub(0.5).mul(0.25);
                const x = along.mul(cos(skew)).sub(across.mul(sin(skew)));
                const z = along.mul(sin(skew)).add(across.mul(cos(skew)));
                const lift = float(0.2).mul(float(1).sub(fall).pow(2));
                const at = centre.add(vec3(x, float(floor).add(0.002).add(height).add(lift), z));
                // Turned to the rasher's skew, tilted to its ripple (and its droop in the air), rolled with it.
                const sag = u.mul(-8).mul(BACON.droop).mul(airborne).div(length);
                const tilt = TSL.atan(slope.add(sag)).mul(0.5);
                const quaternion = GpuSplatMath.quatMul(
                    GpuSplatMath.quatMul(vec4(0, sin(skew.mul(-0.5)), 0, cos(skew.mul(-0.5))), vec4(0, 0, sin(tilt), cos(tilt))),
                    vec4(sin(turn.mul(-0.5)), 0, 0, cos(turn.mul(-0.5))),
                );

                // Bands of fat along it, wandering a little, and one edge mostly fat.
                const band = smoothstep(
                    0.45,
                    0.75,
                    fract(
                        w
                            .mul(1.7)
                            .add(sin(u.mul(8).add(own.mul(6))).mul(0.12))
                            .add(own),
                    ),
                );
                const edge = smoothstep(0.2, 0.45, w.mul(own.greaterThan(0.5).select(float(1), float(-1))));
                const fat = band.max(edge);
                // Browning first at its edges and on the crests.
                const toast = done
                    .mul(
                        smoothstep(0.3, 0.5, w.abs())
                            .mul(0.5)
                            .add(smoothstep(0, rippling, ripple).mul(0.3)),
                    )
                    .add(crisp)
                    .min(1);
                const lean = mix(mix(vec3(0.78, 0.25, 0.27), vec3(0.55, 0.17, 0.08), done), vec3(0.3, 0.09, 0.04), toast);
                const fatColour = mix(mix(vec3(0.96, 0.87, 0.82), vec3(0.95, 0.72, 0.42), done), vec3(0.78, 0.46, 0.19), toast);
                const light = float(1).sub(slope.mul(0.35)).clamp(0.72, 1.25);
                const rgb = mix(lean, fatColour, fat)
                    .mul(light)
                    .mul(hash(i.mul(3.91).add(seed)).mul(0.08).add(0.96));
                const ends = smoothstep(0.5, 0.45, u.abs().add(sin(w.mul(20).add(own.mul(9))).mul(0.015)));
                const opacity = mix(1, 0.85, fat.mul(float(1).sub(done)))
                    .mul(ends)
                    .mul(present);
                const scales = vec3(length.div(BACON.along).mul(0.85), 0.0009, ragged.mul(BACON.width / BACON.across).mul(0.7));
                return GpuSplats.Splat(at, scales, quaternion, rgb, opacity, uint(index));
            },
        },
    });
}

/* coffee */

function coffee(): SplatObject {
    const { radius, height, wall, shell, handle, surface } = COFFEE;
    const base = vec3(...COFFEE.at);
    return SplatCollection.object({
        count: shell + handle + surface,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const a = hash(i.mul(1.31));
                const b = hash(i.mul(2.57));
                const c = hash(i.mul(3.83));
                const angle = a.mul(Math.PI * 2);
                const round = vec3(cos(angle), 0, sin(angle));

                // The shell: outside and inside walls, the base, a rounded rim.
                const inner = step(0.55, c);
                const r = mix(radius, radius - wall, inner);
                const up = b.mul(height);
                const onBase = step(0.9, hash(i.mul(5.1)));
                const wallAt = base.add(round.mul(r)).add(vec3(0, up, 0));
                const baseAt = base.add(round.mul(sqrt(b).mul(radius))).add(vec3(0, 0.002, 0));
                const shellAt = mix(wallAt, baseAt, onBase);
                const band = step(0.55, up.div(height))
                    .mul(step(up.div(height), 0.7))
                    .mul(float(1).sub(inner));
                const ceramic = mix(vec3(0.93, 0.9, 0.84), vec3(0.2, 0.42, 0.45), band).mul(float(1).sub(inner.mul(0.12)));

                // The handle: half a torus out the side.
                const t = a.sub(0.5).mul(Math.PI * 1.05);
                const tube = b.mul(Math.PI * 2);
                const ring = 0.026;
                const handleAt = base
                    .add(vec3(radius + 0.004, height * 0.5, 0))
                    .add(vec3(cos(t).mul(ring), sin(t).mul(ring), 0))
                    .add(vec3(cos(t).mul(cos(tube)), sin(t).mul(cos(tube)), sin(tube)).mul(0.0065));

                // The coffee: dark, a paler crema ring at the edge, a slow swirl through it.
                const across = sqrt(b).mul(radius - wall);
                const swirl = sin(angle.mul(3).add(across.mul(120)).sub(time.mul(0.3)))
                    .mul(0.5)
                    .add(0.5);
                const crema = smoothstep(0.6, 0.95, across.div(radius - wall)).max(swirl.mul(0.25));
                const surfaceAt = base.add(round.mul(across)).add(vec3(0, height - 0.014, 0));
                const coffeeColour = mix(vec3(0.16, 0.08, 0.035), vec3(0.6, 0.4, 0.22), crema);

                const isShell = i.lessThan(shell);
                const isHandle = i.lessThan(shell + handle);
                const at = select3(isShell, shellAt, isHandle, handleAt, surfaceAt);
                const rgb = select3(isShell, ceramic, isHandle, vec3(0.93, 0.9, 0.84), coffeeColour);
                const size = select3(isShell, vec3(0.0032), isHandle, vec3(0.003), vec3(0.003, 0.001, 0.003));
                return GpuSplats.Splat(at, size, vec4(0, 0, 0, 1), rgb, float(0.97), uint(index));
            },
        },
    });
}

// A few thin wisps off the coffee, always: it's freshly made.
function coffeeSteam(): SplatObject {
    const centre = vec3(...COFFEE.at).add(vec3(0, COFFEE.height - 0.01, 0));
    return SplatCollection.object({
        count: COFFEE.wisps * COFFEE.perWisp,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const wisp = TSL.floor(i.div(COFFEE.perWisp));
                const slot = i.sub(wisp.mul(COFFEE.perWisp));
                const life = fract(
                    time
                        .div(2.6)
                        .add(slot.div(COFFEE.perWisp))
                        .add(hash(i.mul(1.9)).mul(0.05)),
                );
                const height = life.mul(0.28);
                const start = hash(wisp.mul(3.7))
                    .mul(Math.PI * 2)
                    .add(time.mul(0.1));
                const sway = height.mul(0.12).add(0.002);
                const at = centre.add(
                    vec3(
                        cos(start)
                            .mul(0.015)
                            .add(sin(height.mul(22).add(time.mul(1.4)).add(wisp.mul(2))).mul(sway)),
                        height,
                        sin(start)
                            .mul(0.015)
                            .add(cos(height.mul(17).add(time.mul(1.2)).add(wisp.mul(3))).mul(sway)),
                    ),
                );
                const opacity = float(0.06)
                    .mul(smoothstep(0, 0.12, life))
                    .mul(float(1).sub(life).pow(1.5));
                return GpuSplats.Splat(
                    at,
                    vec3(mix(0.003, 0.014, life)),
                    vec4(0, 0, 0, 1),
                    vec3(0.95, 0.95, 0.97),
                    opacity,
                    uint(index),
                );
            },
        },
    });
}

/* steam */

// Thin wisps, each rising from its own wandering spot in the pan: swaying and twisting more the higher they get,
// fraying out at the top. Faintly warm just over the pan, grey above.
function steam(centre: TslNode, floor: number, age: TslNode, strength: number): SplatObject {
    return SplatCollection.object({
        count: STEAM.wisps * STEAM.perWisp,
        generator: {
            generateSplat(index: TslNode) {
                const i = float(index);
                const wisp = TSL.floor(i.div(STEAM.perWisp));
                const slot = i.sub(wisp.mul(STEAM.perWisp));
                const life = fract(
                    time
                        .div(STEAM.life)
                        .add(slot.div(STEAM.perWisp))
                        .add(hash(i.mul(1.9)).mul(0.04)),
                );
                const height = life.mul(STEAM.rise);
                const wander = hash(wisp.mul(3.7))
                    .mul(Math.PI * 2)
                    .add(time.mul(0.07));
                const from = sqrt(hash(wisp.mul(5.3))).mul(EGG.spread * 0.8);
                const sway = height.mul(0.08).add(0.004);
                const spread = height.mul(0.05).add(0.002);
                const at = centre.add(
                    vec3(
                        cos(wander)
                            .mul(from)
                            .add(sin(height.mul(14).add(time.mul(1.3)).add(wisp.mul(2))).mul(sway))
                            .add(height.mul(0.05))
                            .add(hash(i.mul(4.1)).sub(0.5).mul(spread)),
                        float(floor).add(0.01).add(height),
                        sin(wander)
                            .mul(from)
                            .add(cos(height.mul(11).add(time.mul(1.1)).add(wisp.mul(3))).mul(sway))
                            .add(hash(i.mul(6.7)).sub(0.5).mul(spread)),
                    ),
                );
                // Strongest while the food's fresh and wet, settling to a thread as it cooks out.
                const amount = smoothstep(0.2, 1, age)
                    .mul(
                        float(1)
                            .sub(smoothstep(6, 16, age))
                            .mul(0.6)
                            .add(0.4),
                    )
                    .mul(step(0, age))
                    .mul(strength);
                const opacity = float(STEAM.opacity)
                    .mul(smoothstep(0, 0.1, life))
                    .mul(float(1).sub(life).pow(1.5))
                    .mul(amount);
                const rgb = mix(vec3(1, 0.86, 0.72), vec3(0.86, 0.87, 0.9), smoothstep(0, 0.3, life));
                return GpuSplats.Splat(at, vec3(mix(0.004, 0.022, life)), vec4(0, 0, 0, 1), rgb, opacity, uint(index));
            },
        },
    });
}

// Three-way pick: a when first, b when second, else c.
function select3(first: TslNode, a: TslNode, second: TslNode, b: TslNode, c: TslNode): TslNode {
    return TSL.select(first, a, TSL.select(second, b, c));
}

/* the sizzle */

type Sizzle = { start(food: Food): void; stir(strength: number): void; update(fry: number, dt: number): void };

const CRACK_URL = Object.values(
    import.meta.glob<string>('../assets/sounds/cooking/crack.ogg', { eager: true, query: '?url', import: 'default' }),
)[0];
// Frying is a fine, thin crackle up high: everything below the highpass is what made it sound like rain. A faint
// sputtering hiss under bursts of tiny clicks, capped so it's never piercing.
const SIZZLE = {
    highpass: 3000,
    cap: 7000,
    hiss: 0.006,
    bursts: 7,
    burst: [4, 20],
    click: 0.06,
    clickLength: [0.0006, 0.0018],
    clickGap: [0.002, 0.02],
    crack: 0.2,
};

function initSizzle(): Sizzle {
    const context = new AudioContext();
    const noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

    const thin = context.createBiquadFilter();
    thin.type = 'highpass';
    thin.frequency.value = SIZZLE.highpass;
    thin.Q.value = 0.7;
    const cap = context.createBiquadFilter();
    cap.type = 'lowpass';
    cap.frequency.value = SIZZLE.cap;
    thin.connect(cap).connect(context.destination);

    const hiss = context.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    const level = context.createGain();
    level.gain.value = 0;
    hiss.connect(level).connect(thin);
    hiss.start();

    const click = (at: number, volume: number) => {
        const source = context.createBufferSource();
        source.buffer = noise;
        const gain = context.createGain();
        const length = SIZZLE.clickLength[0] + Math.random() * (SIZZLE.clickLength[1] - SIZZLE.clickLength[0]);
        gain.gain.setValueAtTime(volume, at);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        source.connect(gain).connect(thin);
        source.start(at, Math.random() * 1.9, length + 0.002);
    };
    const burst = (loud: number, clicks: number) => {
        let at = context.currentTime;
        for (let i = 0; i < clicks; i++) {
            at += SIZZLE.clickGap[0] + Math.random() * (SIZZLE.clickGap[1] - SIZZLE.clickGap[0]);
            click(at, SIZZLE.click * loud * (0.2 + Math.random() ** 2 * 0.8));
        }
    };
    const clicksInBurst = () => SIZZLE.burst[0] + Math.floor(Math.random() * (SIZZLE.burst[1] - SIZZLE.burst[0]));

    let crackClip: AudioBuffer | null = null;
    fetch(CRACK_URL)
        .then((response) => response.arrayBuffer())
        .then((data) => context.decodeAudioData(data))
        .then((loaded) => {
            crackClip = loaded;
        });

    return {
        start(food) {
            if (food === 'bacon') {
                burst(1.4, 60);
                return;
            }
            if (!crackClip) return;
            const source = context.createBufferSource();
            source.buffer = crackClip;
            const gain = context.createGain();
            gain.gain.value = SIZZLE.crack;
            source.connect(gain).connect(context.destination);
            source.start();
        },
        stir(strength) {
            burst(strength, Math.round(30 * strength));
        },
        update(fry, dt) {
            const loud = Math.min(fry, 1.5);
            // A new level every frame, reached in a few hundredths of a second: the hiss sputters rather than holds.
            const sputter = 0.5 + Math.random() ** 2 * 1.1;
            level.gain.setTargetAtTime(loud * SIZZLE.hiss * sputter, context.currentTime, 0.025);
            if (Math.random() < loud * SIZZLE.bursts * dt) burst(loud, clicksInBurst());
        },
    };
}
