import {
    Color,
    HalfFloatType,
    LinearFilter,
    Mesh,
    OrthographicCamera,
    PlaneGeometry,
    Scene,
    ShaderMaterial,
    Vector2,
    WebGLRenderTarget,
    type Camera,
    type Fog,
    type WebGLRenderer,
} from 'three';

import { clamp, lerp } from './math-utils';

// The tint snaps on when the camera crosses the surface and fades out over a second after surfacing.
const MIN_STRENGTH = 0.55;
const FULL_DEPTH = 9;
const FADE_OUT_SECONDS = 1;
// The warp and tint hide the difference, so the offscreen pass runs slightly below the drawing
// buffer resolution. This cuts its fill cost by roughly 28% without changing the look.
const RENDER_SCALE = 0.85;
const UNDERWATER_FOG_NEAR = 1.5;
const UNDERWATER_FOG_FAR = 55;
const UNDERWATER_FOG_COLOR = new Color(0x2c7a8c);
const TINT_COLOR = new Color(0x2d7a8c);
const SHIMMER_COLOR = new Color(0xa8edf2);

// Underwater treatment: the scene is drawn into a render target and reseampled with a slow
// Quake-style wave, then tinted and given a drifting shimmer. It switches on immediately when the
// camera goes under and fades out over one second after it surfaces. The scene fog is tightened at
// the same time so distance fades into the water color.
export class UnderwaterEffect {
    private readonly renderer: WebGLRenderer;
    private readonly passScene = new Scene();
    private readonly passCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    private readonly material: ShaderMaterial;
    private readonly quadGeometry = new PlaneGeometry(2, 2);
    private readonly size = new Vector2();
    private readonly fog: Fog;
    private readonly baseFogColor = new Color();
    private readonly baseFogNear: number;
    private readonly baseFogFar: number;
    private target: WebGLRenderTarget | null = null;
    private strength = 0;
    private fadeOutStrength = 0;
    private fadeOutRemaining = 0;
    private time = 0;

    constructor(renderer: WebGLRenderer, fog: Fog) {
        this.renderer = renderer;
        this.fog = fog;
        this.baseFogColor.copy(fog.color);
        this.baseFogNear = fog.near;
        this.baseFogFar = fog.far;

        this.material = new ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                uTime: { value: 0 },
                uStrength: { value: 0 },
                uTint: { value: TINT_COLOR },
                uShimmer: { value: SHIMMER_COLOR },
            },
            vertexShader: /* glsl */ `
                varying vec2 vUv;

                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: /* glsl */ `
                uniform sampler2D tDiffuse;
                uniform float uTime;
                uniform float uStrength;
                uniform vec3 uTint;
                uniform vec3 uShimmer;
                varying vec2 vUv;

                float hash(vec2 point) {
                    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453);
                }

                float valueNoise(vec2 point) {
                    vec2 cell = floor(point);
                    vec2 local = fract(point);
                    vec2 weight = local * local * (3.0 - 2.0 * local);
                    return mix(
                        mix(hash(cell), hash(cell + vec2(1.0, 0.0)), weight.x),
                        mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), weight.x),
                        weight.y
                    );
                }

                void main() {
                    // Quake-style warp: broad horizontal scanline sway, with a little vertical drift.
                    vec2 uv = vUv;
                    float sway =
                        sin(vUv.y * 24.0 + uTime * 2.0) * 0.7 +
                        sin(vUv.y * 53.0 - uTime * 1.3) * 0.3;
                    uv.x += sway * 0.006 * uStrength;
                    uv.y += cos(vUv.x * 18.0 + uTime * 1.7) * 0.0025 * uStrength;

                    vec3 color = texture2D(tDiffuse, uv).rgb;
                    color = mix(color, uTint, uStrength * 0.45);

                    float shimmer = valueNoise(vUv * vec2(8.0, 6.0) + vec2(uTime * 0.16, -uTime * 0.11));
                    shimmer *= valueNoise(vUv * vec2(13.0, 9.0) - vec2(uTime * 0.1, uTime * 0.14));
                    float glint = smoothstep(0.3, 0.6, shimmer);
                    color += uShimmer * glint * 0.12 * uStrength;

                    gl_FragColor = vec4(color, 1.0);

                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }
            `,
            depthTest: false,
            depthWrite: false,
        });

        const quad = new Mesh(this.quadGeometry, this.material);
        quad.frustumCulled = false;
        this.passScene.add(quad);
    }

    update(dt: number, cameraY: number, waterLevel: number): void {
        this.time += dt;

        const depth = waterLevel - cameraY;
        if (depth > 0) {
            // Snap on entry, then keep following the depth.
            this.strength = MIN_STRENGTH + (1 - MIN_STRENGTH) * clamp(depth / FULL_DEPTH, 0, 1);
            this.fadeOutStrength = this.strength;
            this.fadeOutRemaining = FADE_OUT_SECONDS;
        } else if (this.fadeOutRemaining > 0) {
            this.fadeOutRemaining = Math.max(0, this.fadeOutRemaining - dt);
            this.strength = this.fadeOutStrength * (this.fadeOutRemaining / FADE_OUT_SECONDS);
        } else {
            this.strength = 0;
        }

        // The full-screen half-float target is expensive, so release it as soon as the fade reaches
        // zero. render() recreates it on the next dive.
        if (this.strength === 0) {
            this.releaseTarget();
        }

        this.material.uniforms.uTime.value = this.time;
        this.material.uniforms.uStrength.value = this.strength;

        this.fog.color.copy(this.baseFogColor).lerp(UNDERWATER_FOG_COLOR, this.strength);
        this.fog.near = lerp(this.baseFogNear, UNDERWATER_FOG_NEAR, this.strength);
        this.fog.far = lerp(this.baseFogFar, UNDERWATER_FOG_FAR, this.strength);
    }

    render(scene: Scene, camera: Camera): void {
        const renderer = this.renderer;

        if (this.strength === 0) {
            renderer.setRenderTarget(null);
            renderer.render(scene, camera);
            return;
        }

        renderer.getDrawingBufferSize(this.size);
        const width = Math.max(1, Math.floor(this.size.x * RENDER_SCALE));
        const height = Math.max(1, Math.floor(this.size.y * RENDER_SCALE));
        if (!this.target || this.target.width !== width || this.target.height !== height) {
            this.target?.dispose();
            this.target = new WebGLRenderTarget(width, height, {
                type: HalfFloatType,
                minFilter: LinearFilter,
                magFilter: LinearFilter,
                depthBuffer: true,
                stencilBuffer: false,
            });
            this.material.uniforms.tDiffuse.value = this.target.texture;
        }

        renderer.setRenderTarget(this.target);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(this.passScene, this.passCamera);
    }

    dispose(): void {
        this.releaseTarget();
        this.material.dispose();
        this.quadGeometry.dispose();
    }

    private releaseTarget(): void {
        if (!this.target) {
            return;
        }
        this.target.dispose();
        this.target = null;
        this.material.uniforms.tDiffuse.value = null;
    }
}
