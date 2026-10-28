import type { ProgressStage } from 'spark-radix';

// Share of the bar each stage fills; the rest is the shader compile.
const STAGES: Partial<Record<ProgressStage, [number, number]>> = {
    downloading: [0, 0.75],
    decoding: [0.75, 0.92],
};

export type Loader = {
    element: HTMLElement;
    bar: HTMLElement;
    progress: number;
};

export function initLoader(): Loader {
    const element = document.getElementById('loader') as HTMLElement;
    const bar = element.querySelector('.fill') as HTMLElement;
    return { element, bar, progress: 0 };
}

export function setLoaderStage(loader: Loader, fraction: number, stage: ProgressStage): void {
    const range = STAGES[stage];
    if (range) setLoaderProgress(loader, range[0] + (range[1] - range[0]) * fraction);
}

export function setLoaderProgress(loader: Loader, progress: number): void {
    loader.progress = Math.max(loader.progress, Math.min(progress, 1));
    loader.bar.style.transform = `scaleX(${loader.progress})`;
}

export function finishLoader(loader: Loader): void {
    setLoaderProgress(loader, 1);
    loader.element.classList.add('done');
}
