import { Color } from 'three';

// Dusk palette for the camera-locked sky dome. The horizon burns orange, the light climbs through
// a violet band, and the zenith settles into a navy dark enough to keep the stars readable.
export const SKY_HORIZON_COLOR = new Color(0xff8a3d);
export const SKY_PURPLE_COLOR = new Color(0x7a3f8f);
export const SKY_ZENITH_COLOR = new Color(0x0a1838);

// Fog and fading effects settle into the haze where the horizon glow meets the violet band, so
// distant terrain dissolves into the sky instead of ending in a hard silhouette.
export const SKY_COLOR = new Color(0x8a4a6b);
