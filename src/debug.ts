import type { SplatRenderer } from 'spark-radix';
import * as THREE from 'three';
import type { Focus } from './focus';
import type { Physics } from './physics';
import type { Player } from './player';

export type Debug = {
    panel: HTMLDivElement;
    rows: Map<string, { value: HTMLSpanElement; copy: string }>;
    collider: THREE.Mesh | null;
    frameMs: number;
    sinceRefresh: number;
};

export function initDebug(scene: THREE.Scene, physics: Physics, player: Player): Debug {
    const panel = document.createElement('div');
    panel.id = 'debug';
    panel.hidden = true;
    document.body.append(panel);

    const debug: Debug = { panel, rows: new Map(), collider: null, frameMs: 16, sinceRefresh: 0 };
    const readout = document.createElement('div');
    readout.className = 'readout';
    for (const name of ['fps', 'feet', 'eye', 'look', 'ground', 'focus', 'fov', 'splats', 'collider']) {
        const row = document.createElement('button');
        row.type = 'button';
        row.title = 'click to copy';
        const key = document.createElement('span');
        key.textContent = name;
        const value = document.createElement('span');
        row.append(key, value);
        readout.append(row);
        const entry = { value, copy: '' };
        debug.rows.set(name, entry);
        row.addEventListener('click', () => {
            // Else a later space to jump would press it again.
            row.blur();
            copy(row, entry.copy || value.textContent || '');
        });
    }
    panel.append(readout);
    window.addEventListener('keydown', (event) => {
        if (event.code === 'Backquote') panel.hidden = !panel.hidden;
    });
    if (physics.collider) addColliderToggle(debug, scene, physics.collider);
    player.smoothLook = remembered('smoothLook');
    addToggle(debug, 'smooth look', player.smoothLook, (on) => {
        player.smoothLook = on;
        remember('smoothLook', on);
    });
    return debug;
}

async function copy(row: HTMLElement, text: string) {
    try {
        await navigator.clipboard.writeText(text);
        row.classList.add('copied');
        setTimeout(() => row.classList.remove('copied'), 700);
    } catch {}
}

function addToggle(debug: Debug, name: string, checked: boolean, onChange: (checked: boolean) => void) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.addEventListener('change', () => onChange(checkbox.checked));
    label.append(checkbox, name);
    debug.panel.append(label);
}

function remembered(key: string): boolean {
    try {
        return localStorage.getItem(`homestead:${key}`) === '1';
    } catch {
        return false;
    }
}

function remember(key: string, on: boolean) {
    try {
        localStorage.setItem(`homestead:${key}`, on ? '1' : '0');
    } catch {}
}

function addColliderToggle(debug: Debug, scene: THREE.Scene, collider: NonNullable<Physics['collider']>): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(collider.positions, 3));
    geometry.setIndex(collider.indices);
    const wireframe = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({ color: 0x7fe0ff, wireframe: true, transparent: true, opacity: 0.35 }),
    );
    wireframe.visible = false;
    scene.add(wireframe);
    debug.collider = wireframe;

    addToggle(debug, 'collider', false, (on) => {
        wireframe.visible = on;
    });
}

export function updateDebug(debug: Debug, player: Player, focus: Focus, splats: SplatRenderer, dt: number): void {
    debug.frameMs += (dt * 1000 - debug.frameMs) * 0.05;
    debug.sinceRefresh += dt;
    if (debug.panel.hidden || debug.sinceRefresh < 0.2) return;
    debug.sinceRefresh = 0;

    const [x, y, z] = player.controller.position;
    const eyeY = y + player.eye;
    const triangles = debug.collider ? (debug.collider.geometry.index?.count ?? 0) / 3 : 0;
    const vector = (...values: number[]) => values.map((v) => v.toFixed(2)).join(', ');
    show(debug, 'fps', (1000 / debug.frameMs).toFixed(0));
    show(debug, 'feet', vector(x, y, z), `[${vector(x, y, z)}]`);
    show(debug, 'eye', vector(x, eyeY, z), `[${vector(x, eyeY, z)}]`);
    show(
        debug,
        'look',
        `${THREE.MathUtils.radToDeg(player.yaw).toFixed(0)}°, ${THREE.MathUtils.radToDeg(player.pitch).toFixed(0)}°`,
        `{ yaw: ${player.yaw.toFixed(3)}, pitch: ${player.pitch.toFixed(3)} }`,
    );
    show(debug, 'ground', `${player.grounded ? 'yes' : 'no'}${player.crouched ? ', crouched' : ''}`);
    show(debug, 'focus', `${focus.distance.toFixed(2)} m`);
    show(debug, 'fov', `${player.fov.toFixed(0)}°`);
    show(debug, 'splats', splats.collection.count.toLocaleString());
    show(debug, 'collider', `${triangles.toLocaleString()} tris`);
}

function show(debug: Debug, name: string, value: string, copy = value) {
    const row = debug.rows.get(name);
    if (!row) return;
    row.value.textContent = value;
    row.copy = copy;
}
