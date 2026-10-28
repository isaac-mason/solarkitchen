// Flattens and decimates the scene collider: node scripts/build-collider.ts [in.glb] [out.glb]
// Capture colliders are lumpy, so first snap vertices lying only on near-flat, upward faces onto the
// dominant heights (floor, counter tops), then simplify; the flat areas then collapse to a few triangles.

import { Document, NodeIO } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer';

const INPUT = process.argv[2] ?? 'assets/scene-collider.source.glb';
const OUTPUT = process.argv[3] ?? 'assets/scene-collider.glb';

const FLAT = {
    maxTilt: (12 * Math.PI) / 180,
    maxVertexTilt: (25 * Math.PI) / 180,
    binSize: 0.02,
    minLevelArea: 0.4,
    snapWithin: 0.05,
    minLevelGap: 0.1,
};
const SIMPLIFY = { error: 0.03, keep: 0.05 };

type Mesh = { positions: Float32Array; indices: Uint32Array };

async function main() {
    const mesh = await readMesh(INPUT);
    console.log(`in:  ${mesh.positions.length / 3} verts, ${mesh.indices.length / 3} tris`);

    const levels = flatten(mesh);
    console.log(`flattened onto ${levels.length} levels: ${levels.map((y) => y.toFixed(2)).join(', ')} m`);

    await MeshoptSimplifier.ready;
    const [simplified, error] = MeshoptSimplifier.simplify(
        mesh.indices,
        mesh.positions,
        3,
        Math.floor((mesh.indices.length * SIMPLIFY.keep) / 3) * 3,
        SIMPLIFY.error,
        ['ErrorAbsolute'],
    );
    const out = compact({ positions: mesh.positions, indices: simplified });
    console.log(`out: ${out.positions.length / 3} verts, ${out.indices.length / 3} tris, error ${(error * 100).toFixed(1)} cm`);

    await writeMesh(OUTPUT, out);
}

function flatten({ positions, indices }: Mesh): number[] {
    const vertexCount = positions.length / 3;
    const triangleCount = indices.length / 3;
    const minUp = Math.cos(FLAT.maxTilt);
    const area = new Map<number, number>();
    // Area-weighted sum of each vertex's face normals.
    const vertexNormals = new Float32Array(vertexCount * 3);

    for (let t = 0; t < triangleCount; t++) {
        const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
        const e1 = sub(positions, b, a);
        const e2 = sub(positions, c, a);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        for (const v of [a, b, c]) for (let k = 0; k < 3; k++) vertexNormals[v * 3 + k] += n[k];
        const length = Math.hypot(n[0], n[1], n[2]);
        if (length === 0 || n[1] / length < minUp) continue;
        const y = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
        const bin = Math.round(y / FLAT.binSize);
        area.set(bin, (area.get(bin) ?? 0) + length / 2);
    }

    // A level is a local peak of flat area by height, big enough to be a real surface.
    // Peaks closer than minLevelGap are one lumpy surface: keep the bigger.
    const peaks: [number, number][] = [];
    for (const [bin, a] of area) {
        if (a < FLAT.minLevelArea) continue;
        if ((area.get(bin - 1) ?? 0) > a || (area.get(bin + 1) ?? 0) >= a) continue;
        peaks.push([bin * FLAT.binSize, a]);
    }
    const levels: number[] = [];
    for (const [y, a] of peaks.sort((p, q) => q[1] - p[1])) {
        if (levels.every((level) => Math.abs(level - y) >= FLAT.minLevelGap)) {
            levels.push(y);
            console.log(`level ${y.toFixed(2)} m: ${a.toFixed(1)} m² flat`);
        }
    }

    // Only vertices facing up on the whole: where a floor meets a wall, the average leans and it stays put.
    const minVertexUp = Math.cos(FLAT.maxVertexTilt);
    for (let v = 0; v < vertexCount; v++) {
        const [nx, ny, nz] = [vertexNormals[v * 3], vertexNormals[v * 3 + 1], vertexNormals[v * 3 + 2]];
        const length = Math.hypot(nx, ny, nz);
        if (length === 0 || ny / length < minVertexUp) continue;
        const y = positions[v * 3 + 1];
        let nearest = Number.POSITIVE_INFINITY;
        for (const level of levels) if (Math.abs(level - y) < Math.abs(nearest - y)) nearest = level;
        if (Math.abs(nearest - y) <= FLAT.snapWithin) positions[v * 3 + 1] = nearest;
    }
    return levels.sort((a, b) => a - b);
}

function compact({ positions, indices }: Mesh): Mesh {
    const remap = new Map<number, number>();
    const out: number[] = [];
    const outIndices = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        let next = remap.get(indices[i]);
        if (next === undefined) {
            next = remap.size;
            remap.set(indices[i], next);
            out.push(positions[indices[i] * 3], positions[indices[i] * 3 + 1], positions[indices[i] * 3 + 2]);
        }
        outIndices[i] = next;
    }
    return { positions: new Float32Array(out), indices: outIndices };
}

function sub(positions: Float32Array, a: number, b: number): number[] {
    return [0, 1, 2].map((k) => positions[a * 3 + k] - positions[b * 3 + k]);
}

async function readMesh(path: string): Promise<Mesh> {
    const document = await new NodeIO().read(path);
    const positions: number[] = [];
    const indices: number[] = [];
    for (const node of document.getRoot().listNodes()) {
        const matrix = node.getWorldMatrix();
        for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
            const source = primitive.getAttribute('POSITION')?.getArray();
            if (!source) continue;
            const base = positions.length / 3;
            for (let i = 0; i < source.length; i += 3) {
                const [x, y, z] = [source[i], source[i + 1], source[i + 2]];
                positions.push(
                    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
                    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
                    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
                );
            }
            const index = primitive.getIndices()?.getArray();
            const count = index ? index.length : source.length / 3;
            for (let i = 0; i < count; i++) indices.push(base + (index ? index[i] : i));
        }
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

async function writeMesh(path: string, { positions, indices }: Mesh) {
    const document = new Document();
    const buffer = document.createBuffer();
    const primitive = document
        .createPrimitive()
        .setAttribute('POSITION', document.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer))
        .setIndices(document.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
    const node = document.createNode('collider').setMesh(document.createMesh('collider').addPrimitive(primitive));
    document.createScene().addChild(node);
    await new NodeIO().write(path, document);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
