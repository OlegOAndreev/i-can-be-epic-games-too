import type { MeshStandardMaterial } from 'three';

// The opening orbit holds a fixed camera height, so trees close to the lens fade out instead of
// pushing the camera upward. Distances are horizontal; the camera's height never changes.
export const TREE_CAMERA_FADE_START = 9;
export const TREE_CAMERA_FADE_END = 3.5;

// Fades a tree material by horizontal distance from the camera. Every tree and leaf mesh is an
// InstancedMesh, so the instance origin gives the trunk position without touching the instance
// buffers. A uniform of 0 keeps the fade a no-op during normal play.
export function applyTreeCameraFade(material: MeshStandardMaterial, fade: { value: number }): void {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uTreeCameraFade = fade;
        shader.vertexShader = shader.vertexShader
            .replace('void main() {', 'varying float vTreeCameraFade;\nuniform float uTreeCameraFade;\nvoid main() {')
            .replace(
                '#include <project_vertex>',
                `#include <project_vertex>
vec3 treeCameraOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
float treeCameraDistance = distance(treeCameraOrigin.xz, cameraPosition.xz);
vTreeCameraFade = mix(
    1.0,
    smoothstep(${TREE_CAMERA_FADE_END.toFixed(1)}, ${TREE_CAMERA_FADE_START.toFixed(1)}, treeCameraDistance),
    uTreeCameraFade
);`,
            );
        shader.fragmentShader = shader.fragmentShader
            .replace('void main() {', 'varying float vTreeCameraFade;\nvoid main() {')
            .replace(
                '#include <color_fragment>',
                `#include <color_fragment>
if (vTreeCameraFade < 0.01) discard;
diffuseColor.a *= vTreeCameraFade;`,
            );
    };
    material.customProgramCacheKey = () => 'tree-camera-fade';
}
