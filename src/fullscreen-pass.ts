import {
    Mesh,
    OrthographicCamera,
    PlaneGeometry,
    Scene,
    ShaderMaterial,
    type IUniform,
    type WebGLRenderer,
} from 'three';

// A single quad stretched across the viewport. Overlays reuse it to tint or fade the finished
// frame without clearing the canvas or writing depth.
const VERTEX_SHADER = /* glsl */ `
    varying vec2 vUv;

    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

export class FullscreenPass {
    readonly material: ShaderMaterial;
    private readonly renderer: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly geometry = new PlaneGeometry(2, 2);

    constructor(renderer: WebGLRenderer, fragmentShader: string, uniforms: Record<string, IUniform>) {
        this.renderer = renderer;
        this.material = new ShaderMaterial({
            uniforms,
            vertexShader: VERTEX_SHADER,
            fragmentShader,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });

        const quad = new Mesh(this.geometry, this.material);
        quad.frustumCulled = false;
        this.scene.add(quad);
    }

    // Draws over the already-composited frame, so the pass must not clear the canvas.
    render(): void {
        const autoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        try {
            this.renderer.render(this.scene, this.camera);
        } finally {
            this.renderer.autoClear = autoClear;
        }
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }
}
