import { Vector3 } from 'three';

// World-space directions of the two suns drawn on the camera-locked sky dome. The finale aims its
// hyperspace run at the point between them, so the directions live in one place shared by the sky
// and the cutscene.
export const SUN_DIRECTION = new Vector3(-0.42, 0.78, -0.46).normalize();
export const SECOND_SUN_DIRECTION = new Vector3(-0.3, 0.82, -0.48).normalize();

export const SUN_BISECTOR_DIRECTION = new Vector3().addVectors(SUN_DIRECTION, SECOND_SUN_DIRECTION).normalize();
