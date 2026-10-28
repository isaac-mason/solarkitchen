const STICK_RADIUS = 48;
const TOUCH_LOOK_SCALE = 1.6;

export type Input = {
    /** x strafe right, y forward; length up to 1. */
    move: [number, number];
    /** Look movement in mouse pixels since last consumed. */
    look: [number, number];
    run: boolean;
    jump: boolean;
    crouch: boolean;
    zoom: boolean;
    /** Pointer-locked, or on a touch screen: walking rather than clicking in. */
    active: boolean;
    touch: boolean;
    keys: Set<string>;
    locked: boolean;
    stick: { pointer: number; origin: [number, number]; offset: [number, number] } | null;
    lookPointer: { pointer: number; last: [number, number] } | null;
    mouseZoom: boolean;
};

export function initInput(canvas: HTMLCanvasElement, onFirstGesture: () => void): Input {
    const input: Input = {
        move: [0, 0],
        look: [0, 0],
        run: false,
        jump: false,
        crouch: false,
        zoom: false,
        active: false,
        touch: false,
        keys: new Set(),
        locked: false,
        stick: null,
        lookPointer: null,
        mouseZoom: false,
    };

    canvas.addEventListener('click', () => {
        onFirstGesture();
        if (!input.touch) canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
        input.locked = document.pointerLockElement === canvas;
    });
    document.addEventListener('mousemove', (event) => {
        if (!input.locked) return;
        input.look[0] += event.movementX;
        input.look[1] += event.movementY;
    });
    document.addEventListener('mousedown', (event) => {
        if (input.locked && event.button === 0) input.mouseZoom = true;
    });
    document.addEventListener('mouseup', (event) => {
        if (event.button === 0) input.mouseZoom = false;
    });
    window.addEventListener('keydown', (event) => input.keys.add(event.code));
    window.addEventListener('keyup', (event) => input.keys.delete(event.code));
    window.addEventListener('blur', () => input.keys.clear());

    bindTouch(input, canvas, onFirstGesture);
    return input;
}

export function updateInput(input: Input): void {
    const held = (...codes: string[]) => codes.some((code) => input.keys.has(code));
    let x = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);
    if (input.stick) {
        x += input.stick.offset[0] / STICK_RADIUS;
        y -= input.stick.offset[1] / STICK_RADIUS;
    }
    const length = Math.hypot(x, y);
    input.move = length > 1 ? [x / length, y / length] : [x, y];
    input.run = held('ShiftLeft', 'ShiftRight');
    input.jump = held('Space');
    input.crouch = held('ControlLeft', 'ControlRight', 'KeyC');
    input.zoom = input.mouseZoom && input.locked;
    input.active = input.locked || input.touch;
}

export function consumeLook(input: Input): [number, number] {
    const look: [number, number] = [input.look[0], input.look[1]];
    input.look[0] = 0;
    input.look[1] = 0;
    return look;
}

function bindTouch(input: Input, canvas: HTMLCanvasElement, onFirstGesture: () => void) {
    const stick = document.getElementById('stick') as HTMLDivElement;
    const knob = document.getElementById('knob') as HTMLDivElement;

    const startTouch = () => {
        if (input.touch) return;
        input.touch = true;
        document.body.classList.add('touch');
        onFirstGesture();
    };

    canvas.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return;
        startTouch();
        const at: [number, number] = [event.clientX, event.clientY];
        if (event.clientX < window.innerWidth / 2 && !input.stick) {
            input.stick = { pointer: event.pointerId, origin: at, offset: [0, 0] };
            stick.style.transform = `translate(${at[0]}px, ${at[1]}px)`;
            knob.style.transform = '';
            stick.classList.add('held', 'used');
        } else if (!input.lookPointer) {
            input.lookPointer = { pointer: event.pointerId, last: at };
        }
    });
    canvas.addEventListener('pointermove', (event) => {
        if (input.stick?.pointer === event.pointerId) {
            let dx = event.clientX - input.stick.origin[0];
            let dy = event.clientY - input.stick.origin[1];
            const length = Math.hypot(dx, dy);
            if (length > STICK_RADIUS) {
                dx *= STICK_RADIUS / length;
                dy *= STICK_RADIUS / length;
            }
            input.stick.offset = [dx, dy];
            knob.style.transform = `translate(${dx}px, ${dy}px)`;
        } else if (input.lookPointer?.pointer === event.pointerId) {
            input.look[0] += (event.clientX - input.lookPointer.last[0]) * TOUCH_LOOK_SCALE;
            input.look[1] += (event.clientY - input.lookPointer.last[1]) * TOUCH_LOOK_SCALE;
            input.lookPointer.last = [event.clientX, event.clientY];
        }
    });
    const release = (event: PointerEvent) => {
        if (input.stick?.pointer === event.pointerId) {
            input.stick = null;
            stick.classList.remove('held');
        }
        if (input.lookPointer?.pointer === event.pointerId) input.lookPointer = null;
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
}
