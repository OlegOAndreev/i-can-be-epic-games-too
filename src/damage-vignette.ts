import {
    Mesh,
    OrthographicCamera,
    PlaneGeometry,
    Scene,
    ShaderMaterial,
    Vector2,
    type WebGLRenderer,
} from 'three';

// Red edge tint that mirrors the robot's remaining floor health. Health drives the overlay directly:
// it deepens with every laser hit and drains as the robot repairs itself once a floor is cleared.
export class DamageVignette {
    private readonly renderer: WebGLRenderer;
    private readonly scene = new Scene();
    private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly geometry = new PlaneGeometry(2, 2);
    private readonly size = new Vector2();
    private readonly material: ShaderMaterial;
    private strength = 0;

    constructor(renderer: WebGLRenderer) {
        this.renderer = renderer;
        this.material = new ShaderMaterial({
            uniforms: {
                uLevel: { value: 0 },
                uAspect: { value: 1 },
            },
            vertexShader: /* glsl */ `
                varying vec2 vUv;

                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform float uLevel;
                uniform float uAspect;
                varying vec2 vUv;

                void main() {
                    // Normalise the distance so the fade reaches 1.0 at the farthest corner,
                    // matching the previous CSS circle gradient on any viewport shape.
                    vec2 offset = (vUv - 0.5) * vec2(uAspect, 1.0);
                    float distanceToEdge =
                        length(offset) / (0.5 * sqrt(uAspect * uAspect + 1.0));

                    vec3 inner = vec3(150.0, 0.0, 0.0) / 255.0;
                    vec3 middle = vec3(170.0, 0.0, 0.0) / 255.0;
                    vec3 outer = vec3(200.0, 12.0, 12.0) / 255.0;
                    vec3 edge = vec3(120.0, 0.0, 0.0) / 255.0;

                    vec4 tint;
                    if (distanceToEdge < 0.30) {
                        tint = mix(
                            vec4(inner, 0.08),
                            vec4(middle, 0.24),
                            distanceToEdge / 0.30
                        );
                    } else if (distanceToEdge < 0.62) {
                        tint = mix(
                            vec4(middle, 0.24),
                            vec4(outer, 0.72),
                            (distanceToEdge - 0.30) / 0.32
                        );
                    } else {
                        tint = mix(
                            vec4(outer, 0.72),
                            vec4(edge, 0.98),
                            min(1.0, (distanceToEdge - 0.62) / 0.38)
                        );
                    }

                    gl_FragColor = vec4(tint.rgb, tint.a * uLevel);
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

    get level(): number {
        return this.strength;
    }

    setLevel(level: number): void {
        this.strength = Math.min(1, Math.max(0, level));
        this.material.uniforms.uLevel.value = this.strength;
    }

    reset(): void {
        this.setLevel(0);
    }

    // Draws over the already-composited frame, so the overlay must not clear the canvas.
    render(): void {
        if (this.strength < 0.001) {
            return;
        }
        this.renderer.getDrawingBufferSize(this.size);
        this.material.uniforms.uAspect.value = this.size.x / Math.max(1, this.size.y);
        const autoClear = this.renderer.autoClear;
        this.renderer.autoClear = false;
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClear = autoClear;
    }
}
