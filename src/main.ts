import GUI from 'lil-gui';
import { Color, PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import Stats from 'three/addons/libs/stats.module.js';
import { TrackballControls } from 'three/examples/jsm/Addons.js';

import { IdleManager } from './idle-manager';

const FOV = 80;
const NEAR_Z = 0.1;
const FAR_Z = 10000.0;
const BG_COLOR = 0x111111;

class View {
    renderer: WebGLRenderer;
    scene: Scene;
    viewSize = {
        width: 0,
        height: 0,
        aspect: 0,
    };

    camera = new PerspectiveCamera(FOV, 1.0, NEAR_Z, FAR_Z);
    controls: TrackballControls;

    constructor(canvas: HTMLCanvasElement) {
        this.renderer = new WebGLRenderer({ canvas });
        this.scene = new Scene();
        this.controls = new TrackballControls(this.camera, canvas);
        // Default rotation speed is painfully slow.
        this.controls.rotateSpeed = 2.0;
    }

    updateCanvasSize(canvas: HTMLCanvasElement) {
        if (this.viewSize.width === canvas.clientWidth && this.viewSize.height === canvas.clientHeight) {
            return;
        }
        this.viewSize.width = canvas.clientWidth;
        this.viewSize.height = canvas.clientHeight;
        this.viewSize.aspect = this.viewSize.width / this.viewSize.height;

        this.camera.aspect = this.viewSize.aspect;
        this.camera.updateProjectionMatrix();
        this.controls.handleResize();

        this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    }
}

let canvas: HTMLCanvasElement;
let view: View;
let idleManager: IdleManager;
let statsPanel: Stats;

async function init() {
    canvas = document.getElementById('threejs') as HTMLCanvasElement;
    if (!canvas) {
        throw new Error('Canvas element with id "threejs" not found');
    }

    view = new View(canvas);

    view.renderer.setPixelRatio(window.devicePixelRatio);
    view.renderer.setClearColor(new Color(BG_COLOR), 1.0);

    createStatsPanel();
    createGui();

    idleManager = new IdleManager(
        document,
        () => view.renderer.setAnimationLoop(animate),
        () => view.renderer.setAnimationLoop(null),
    );
    idleManager.enableDebugIndicator(true);
}

init();

function createStatsPanel() {
    statsPanel = new Stats();
    // We override the style via css file
    statsPanel.dom.id = 'stats-panel';
    statsPanel.dom.style.cssText = '';
    document.body.appendChild(statsPanel.dom);
    statsPanel.dom.style.display = 'block';
}

function createGui() {
    const gui = new GUI({ title: 'threejs template' });
    gui.open();
}

function animate(_timestamp: DOMHighResTimeStamp, _frame: XRFrame) {
    view.updateCanvasSize(canvas);
    view.controls.update();
    view.renderer.render(view.scene, view.camera);

    statsPanel.update();
}
