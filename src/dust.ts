import { GpuSplats, SplatCollection, type SplatObject, TSL, type TslNode } from 'spark-radix';
import * as THREE from 'three';

const { cos, distance, float, fract, hash, mix, pow, sin, smoothstep, uint, uniform, vec3, vec4 } = TSL;

// Motes are recomputed from their index and the time every frame: nothing stored, nothing respawned.
// The field wraps through itself as it drifts, so a mote leaving the top comes back at the bottom.

const BOX = new THREE.Box3(new THREE.Vector3(-12.5, 0, -12.7), new THREE.Vector3(-5.5, 3.2, -7.5));

const DUST = {
    perCubicMetre: 7,
    scale: [0.002, 0.008],
    swirl: { distance: 0.25, speed: 0.09 },
    bob: { distance: 0.18, speed: 0.16 },
    // Dust hangs more than it falls.
    drift: [0.012, -0.006, 0.004],
    opacity: 0.55,
    // A slow glint as a mote tumbles through the light, not a blink.
    twinkle: { depth: 0.65, sharpness: 2, speed: 0.07 },
    // Up close a mote would be a thumbprint on the lens.
    nearFade: 0.7,
    colours: [new THREE.Vector3(1.0, 0.96, 0.86), new THREE.Vector3(0.78, 0.82, 0.92)],
};

type Uniform<T> = TslNode & { value: T };

export type Dust = {
    object: SplatObject;
    count: number;
    time: Uniform<number>;
    camera: Uniform<THREE.Vector3>;
    drift: Uniform<THREE.Vector3>;
    elapsed: number;
};

export function initDust(): Dust {
    const size = BOX.getSize(new THREE.Vector3());
    const count = Math.round(size.x * size.y * size.z * DUST.perCubicMetre);
    const time = uniform(0);
    const camera = uniform(new THREE.Vector3());
    const drift = uniform(new THREE.Vector3());
    const min = vec3(BOX.min.x, BOX.min.y, BOX.min.z);
    const extent = vec3(size.x, size.y, size.z);

    const generateSplat = (index: TslNode) => {
        const base4 = uint(index).mul(uint(4));
        const random = vec4(hash(base4), hash(base4.add(uint(1))), hash(base4.add(uint(2))), hash(base4.add(uint(3)))).toVar();
        const seed = random.w;
        const phase = seed.mul(Math.PI * 2).toVar();
        const home = min.add(fract(random.xyz.add(drift)).mul(extent)).toVar();

        const swirlTime = time.mul(DUST.swirl.speed).toVar();
        const swirl = vec3(
            sin(swirlTime.add(home.z.mul(0.9)).add(phase)),
            sin(swirlTime.mul(0.7).add(home.x.mul(1.1)).add(phase.mul(1.3))),
            cos(swirlTime.mul(0.85).add(home.y).add(phase.mul(0.7))),
        ).mul(DUST.swirl.distance);
        const bob = sin(time.mul(DUST.bob.speed).add(phase)).mul(DUST.bob.distance);
        const center = home
            .add(swirl)
            .add(vec3(0, bob, 0))
            .toVar();

        // Most motes small, a few large.
        const size = fract(seed.mul(97));
        const radius = mix(DUST.scale[0], DUST.scale[1], size.mul(size).mul(size));

        const wave = sin(time.mul(DUST.twinkle.speed * Math.PI * 2).add(phase.mul(3.1)))
            .mul(0.5)
            .add(0.5);
        const brightness = mix(float(1 - DUST.twinkle.depth), float(1), pow(wave, DUST.twinkle.sharpness)).toVar();
        const near = smoothstep(DUST.nearFade * 0.2, DUST.nearFade, distance(center, camera));
        const rgb = mix(vec3(...DUST.colours[0].toArray()), vec3(...DUST.colours[1].toArray()), fract(seed.mul(13)));

        return GpuSplats.Splat(
            center,
            vec3(radius),
            vec4(0, 0, 0, 1),
            rgb.mul(brightness),
            brightness.mul(DUST.opacity).mul(near),
            uint(index),
        );
    };

    return {
        object: SplatCollection.object({ count, generator: { generateSplat } }),
        count,
        time,
        camera,
        drift,
        elapsed: 0,
    };
}

export function updateDust(dust: Dust, camera: THREE.Camera, dt: number): void {
    dust.elapsed += dt;
    dust.time.value = dust.elapsed;
    camera.getWorldPosition(dust.camera.value);
    const size = BOX.getSize(new THREE.Vector3());
    dust.drift.value.x += (DUST.drift[0] / size.x) * dt;
    dust.drift.value.y += (DUST.drift[1] / size.y) * dt;
    dust.drift.value.z += (DUST.drift[2] / size.z) * dt;
}
