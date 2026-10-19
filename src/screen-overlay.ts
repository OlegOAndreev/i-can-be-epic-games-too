import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, type WebGLRenderer } from 'three';

import { clamp, lerp } from './math-utils';

export type ScreenFadeEasing = 'linear' | 'in' | 'out';

// A flat colour drawn over the finished frame. The game uses a black overlay for the death
// respawn and white overlays for the finale cut and the lightning strike. Fades are advanced from
// the render loop instead of CSS so they pause with the game, survive slow frames, and appear in
// screenshots.
export class ScreenOverlay {
    private readonly renderer: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly geometry = new PlaneGeometry(2, 2);
    private readonly material: ShaderMaterial;
    private current = 0;
    private start = 0;
    private target = 0;
    private duration = 0;
    private remaining = 0;
    private easing: ScreenFadeEasing = 'linear';

    constructor(renderer: WebGLRenderer, color: number) {
        this.renderer = renderer;
        this.material = new ShaderMaterial({
            uniforms: {
                uColor: { value: new Color(color) },
                uOpacity: { value: 0 },
            },
            vertexShader: /* glsl */ `
                void main() {
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform vec3 uColor;
                uniform float uOpacity;

                void main() {
                    gl_FragColor = vec4(uColor, uOpacity);
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });

        const quad = new Mesh(this.geometry, this.material);
        quad.frustumCulled = false;
        this.scene.add(quad);
    }

    get opacity(): number {
        return this.current;
    }

    setOpacity(opacity: number): void {
        this.current = clamp(opacity, 0, 1);
        this.start = this.current;
        this.target = this.current;
        this.remaining = 0;
        this.material.uniforms.uOpacity.value = this.current;
    }

    fadeTo(opacity: number, seconds: number, easing: ScreenFadeEasing = 'linear'): void {
        this.start = this.current;
        this.target = clamp(opacity, 0, 1);
        this.duration = Math.max(0, seconds);
        this.remaining = this.duration;
        this.easing = easing;
        if (this.duration === 0) {
            this.setOpacity(this.target);
        }
    }

    update(dt: number): void {
        if (this.remaining <= 0) {
            return;
        }

        this.remaining = Math.max(0, this.remaining - dt);
        const progress = this.duration === 0 ? 1 : 1 - this.remaining / this.duration;
        const eased =
            this.easing === 'in'
                ? progress * progress
                : this.easing === 'out'
                  ? 1 - (1 - progress) * (1 - progress)
                  : progress;
        this.current = lerp(this.start, this.target, eased);
        this.material.uniforms.uOpacity.value = this.current;
    }

    // Draws over the already-composited frame, so the overlay must not clear the canvas.
    render(): void {
        if (this.current < 0.001) {
            return;
        }
        const autoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClear = autoClear;
    }

    dispose(): void {
        this.geometry.dispose();
        this.material.dispose();
    }
}
