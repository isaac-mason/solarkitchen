import { defineConfig } from 'vite';

export default defineConfig({
    base: process.env.BASE_PATH ?? '/',
    // spark-radix brings its own three: keep everything on one copy.
    resolve: { dedupe: ['three'] },
    // WebGPURenderer picks its backend with top-level await.
    build: { target: 'es2022' },
});
