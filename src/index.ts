import { createRenderer, GpuArrays, loadSplats, SplatCollection, SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import sceneUrl from '../assets/scene.spz?url';
import colliderUrl from '../assets/scene-collider.glb?url';
import { initCooking, unlockCooking, updateCooking } from './cooking';
import { initDebug, updateDebug } from './debug';
import { initFootsteps, unlockFootsteps, updateFootsteps } from './footsteps';
import { initInput, updateInput } from './input';
import { finishLoader, initLoader, setLoaderProgress, setLoaderStage } from './loader';
import { initMeadow, updateMeadow } from './meadow';
import { initPhysics, loadCollider, updatePhysics } from './physics';
import { applyPlayerCamera, initPlayer, updatePlayer, zoomAmount } from './player';
import { initTitle, renderTitle, updateTitle } from './title';
import { cutWindow, frameSplats, glassSplats } from './window';
import './style.css';

const MAX_DT = 1 / 30;
const MAX_PIXEL_RATIO = 1.5;

async function init() {
    const loader = initLoader();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

    const renderer = await createRenderer({ antialias: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight);
    (document.querySelector<HTMLDivElement>('#app') ?? document.body).appendChild(renderer.domElement);

    const physics = initPhysics();
    const [data] = await Promise.all([
        loadSplats(sceneUrl, { onProgress: (fraction, stage) => setLoaderStage(loader, fraction, stage) }),
        loadCollider(physics, colliderUrl),
    ]);
    const world = cutWindow(GpuArrays.fromData(renderer, data));
    const meadow = initMeadow(scene, renderer);

    const cooking = initCooking();
    const parts = {
        room: world,
        cooking: cooking.objects,
        ground: meadow.parts.ground,
        grass: meadow.parts.grass,
        flowers: meadow.parts.flowers,
        butterflies: meadow.parts.butterflies,

        clouds: meadow.parts.clouds,
        glass: glassSplats(meadow.eye),
        frames: frameSplats(renderer, data),
    };
    const splats = new SplatRenderer({
        renderer,
        collection: new SplatCollection(Object.values(parts).flat()),
    });
    splats.raycast = () => {};
    scene.add(splats);

    const player = initPlayer(physics);
    const footsteps = initFootsteps();
    const debug = initDebug(scene, physics, player, parts);
    const vignette = document.getElementById('vignette') as HTMLDivElement;
    const input = initInput(renderer.domElement, () => {
        unlockFootsteps(footsteps);
        unlockCooking(cooking);
    });
    applyPlayerCamera(player, camera);
    const title = await initTitle(scene, camera, physics);
    setLoaderProgress(loader, 0.95);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        splats,
        cooking,
        meadow,
        physics,
        player,
        footsteps,
        input,
        debug,
        vignette,
        title,
        loader,
    };
}

type State = Awaited<ReturnType<typeof init>>;

function update(state: State, dt: number) {
    updateInput(state.input);
    if (state.title.entered) updatePlayer(state.player, state.physics, state.input, dt);
    updatePhysics(state.physics, dt);
    updateFootsteps(state.footsteps, state.player.stepped, state.player.landed);
    applyPlayerCamera(state.player, state.camera);
    updateTitle(state.title, state.input.active, state.camera, dt);
    updateCooking(state.cooking, state.input.keys, state.camera, dt);
    updateMeadow(state.meadow, state.camera, dt);

    // the WebGL2 backend's CPU sort only runs when asked, and the grass and steam never stop
    if (state.splats.sortMode === 'cpu') state.splats.requestSort();

    document.body.classList.toggle('active', state.input.active);
    state.vignette.style.opacity = zoomAmount(state.player).toFixed(3);
    updateDebug(state.debug, state.player, state.splats, dt);
    renderTitle();
    state.renderer.render(state.scene, state.camera);
}

async function start() {
    const state = await init();
    applyPlayerCamera(state.player, state.camera);
    state.splats.prepare(state.camera);
    renderTitle();
    await state.renderer.compileAsync(state.scene, state.camera);
    finishLoader(state.loader);

    let last = performance.now();
    state.renderer.setAnimationLoop(() => {
        const now = performance.now();
        update(state, Math.min((now - last) / 1000, MAX_DT));
        last = now;
    });
}

start();
