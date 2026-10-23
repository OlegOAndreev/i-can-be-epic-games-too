import { Color } from 'three';

import { clamp } from './math-utils';
import type { SpaceshipPartSite, SpaceshipParts } from './spaceship-parts';
import { WATER_LEVEL, WORLD_HALF_SIZE } from './terrain';
import type { Terrain } from './terrain';

const MAP_RESOLUTION = 192;
const CANVAS_SIZE = 512;
// The outer edge of the world is a snow-capped mountain rim. It hides the edge of the 3D world but
// only reads as padding on the map, so the map samples a tighter square and lets the island fill
// the frame.
export const WRECK_MAP_HALF_SIZE = WORLD_HALF_SIZE * 0.9;
const MAP_VIEW_SIZE = WRECK_MAP_HALF_SIZE * 2;
// Drawn at 1.5x the mapped search radius, then widened another 30% for legibility on the map.
const SEARCH_MARK_RING_SCALE = 1.5 * 1.3;

// The map is painted from the same seed as the world. The terrain is sampled at a coarse
// resolution for the biome colours, then the megastructures, search marks, and player arrow are
// drawn on top at full canvas resolution.
export class WreckMap {
    private readonly panel: HTMLElement;
    private readonly canvas: HTMLCanvasElement;
    private readonly context: CanvasRenderingContext2D;
    private readonly base: HTMLCanvasElement;
    private readonly baseContext: CanvasRenderingContext2D;
    private readonly staticLayer: HTMLCanvasElement;
    private readonly staticContext: CanvasRenderingContext2D;

    private terrain: Terrain;
    private parts: SpaceshipParts;
    private baseDirty = true;
    private shown = false;
    private structureState = Number.NaN;

    constructor(panel: HTMLElement, canvas: HTMLCanvasElement, terrain: Terrain, parts: SpaceshipParts) {
        this.panel = panel;
        this.canvas = canvas;
        this.terrain = terrain;
        this.parts = parts;

        this.canvas.width = CANVAS_SIZE;
        this.canvas.height = CANVAS_SIZE;
        const context = this.canvas.getContext('2d');
        if (!context) {
            throw new Error('The wreck map needs a 2D canvas context.');
        }
        this.context = context;

        this.base = document.createElement('canvas');
        this.base.width = MAP_RESOLUTION;
        this.base.height = MAP_RESOLUTION;
        const baseContext = this.base.getContext('2d');
        if (!baseContext) {
            throw new Error('The wreck map needs a 2D canvas context.');
        }
        this.baseContext = baseContext;

        this.staticLayer = document.createElement('canvas');
        this.staticLayer.width = CANVAS_SIZE;
        this.staticLayer.height = CANVAS_SIZE;
        const staticContext = this.staticLayer.getContext('2d');
        if (!staticContext) {
            throw new Error('The wreck map needs a 2D canvas context.');
        }
        this.staticContext = staticContext;
    }

    get visible(): boolean {
        return this.shown;
    }

    toggle(): void {
        this.setVisible(!this.shown);
    }

    setVisible(visible: boolean): void {
        this.shown = visible;
        this.panel.classList.toggle('is-hidden', !visible);
    }

    setWorld(terrain: Terrain, parts: SpaceshipParts): void {
        this.terrain = terrain;
        this.parts = parts;
        this.baseDirty = true;
    }

    update(playerX: number, playerZ: number, heading: number): void {
        if (!this.shown) {
            return;
        }

        if (this.baseDirty) {
            this.renderBase();
            this.baseDirty = false;
            this.structureState = Number.NaN;
        }

        // The terrain, structures, and search marks only change when a tower powers up or a part
        // is collected, so they live on an offscreen layer and the open map redraws just the arrow.
        const structureState = this.getStructureState();
        if (structureState !== this.structureState) {
            this.renderStaticLayer(structureState);
        }

        this.context.drawImage(this.staticLayer, 0, 0);
        this.drawPlayer(playerX, playerZ, heading);
    }

    private getStructureState(): number {
        let state = 0;
        for (const structureSwitch of this.terrain.megastructures.switches) {
            state = state * 2 + (this.terrain.megastructures.isTowerPowered(structureSwitch.towerIndex) ? 1 : 0);
        }
        for (const site of this.parts.getSites()) {
            state = state * 2 + (site.collected ? 1 : 0);
        }
        return state;
    }

    private renderStaticLayer(structureState: number): void {
        const context = this.staticContext;
        context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        context.drawImage(this.base, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        this.drawStructures(context);
        this.drawSearchMarks(context);
        this.structureState = structureState;
    }

    private renderBase(): void {
        const resolution = MAP_RESOLUTION;
        const step = MAP_VIEW_SIZE / resolution;
        const heights = new Float32Array(resolution * resolution);

        for (let pixelZ = 0; pixelZ < resolution; pixelZ++) {
            const worldZ = -WRECK_MAP_HALF_SIZE + (pixelZ + 0.5) * step;
            for (let pixelX = 0; pixelX < resolution; pixelX++) {
                const worldX = -WRECK_MAP_HALF_SIZE + (pixelX + 0.5) * step;
                heights[pixelZ * resolution + pixelX] = this.terrain.heightAt(worldX, worldZ);
            }
        }

        const image = this.baseContext.createImageData(resolution, resolution);
        const data = image.data;
        const color = new Color();

        for (let pixelZ = 0; pixelZ < resolution; pixelZ++) {
            const worldZ = -WRECK_MAP_HALF_SIZE + (pixelZ + 0.5) * step;
            for (let pixelX = 0; pixelX < resolution; pixelX++) {
                const index = pixelZ * resolution + pixelX;
                const worldX = -WRECK_MAP_HALF_SIZE + (pixelX + 0.5) * step;
                const height = heights[index];
                const offset = index * 4;

                if (height < WATER_LEVEL) {
                    const depth = clamp((WATER_LEVEL - height) / 55, 0, 1);
                    data[offset] = 42 - depth * 18;
                    data[offset + 1] = 92 - depth * 38;
                    data[offset + 2] = 118 - depth * 48;
                    data[offset + 3] = 255;
                    continue;
                }

                const left = heights[pixelX > 0 ? index - 1 : index];
                const right = heights[pixelX < resolution - 1 ? index + 1 : index];
                const up = heights[pixelZ > 0 ? index - resolution : index];
                const down = heights[pixelZ < resolution - 1 ? index + resolution : index];
                const gradientX = (right - left) / (2 * step);
                const gradientZ = (down - up) / (2 * step);
                const normalY = 1 / Math.sqrt(1 + gradientX * gradientX + gradientZ * gradientZ);

                this.terrain.biomeColorAt(worldX, worldZ, height, normalY, color);
                color.convertLinearToSRGB();

                // Light from the upper left keeps the relief readable without hiding the biomes.
                const shade = clamp(0.78 + normalY * 0.2 + (gradientX + gradientZ) * 0.35, 0.6, 1.2);
                data[offset] = clamp(color.r * 255 * shade, 0, 255);
                data[offset + 1] = clamp(color.g * 255 * shade, 0, 255);
                data[offset + 2] = clamp(color.b * 255 * shade, 0, 255);
                data[offset + 3] = 255;
            }
        }

        this.baseContext.putImageData(image, 0, 0);
    }

    private drawStructures(context: CanvasRenderingContext2D): void {
        context.save();
        context.lineJoin = 'round';

        for (const [towerIndex, tower] of this.terrain.megastructures.towers.entries()) {
            const towerMinX = tower.worldMinX ?? tower.minX;
            const towerMaxX = tower.worldMaxX ?? tower.maxX;
            const towerMinZ = tower.worldMinZ ?? tower.minZ;
            const towerMaxZ = tower.worldMaxZ ?? tower.maxZ;
            const minX = this.toCanvasX(towerMinX);
            const maxX = this.toCanvasX(towerMaxX);
            const minZ = this.toCanvasZ(towerMinZ);
            const maxZ = this.toCanvasZ(towerMaxZ);
            // An unpowered tower reads as the standard orange; once its switch has charged it
            // turns cyan like the live energy running through the structure.
            const powered = this.terrain.megastructures.isTowerPowered(towerIndex);

            context.fillStyle = powered ? 'rgba(56, 201, 226, 0.12)' : 'rgba(226, 118, 47, 0.16)';
            context.fillRect(minX, minZ, maxX - minX, maxZ - minZ);

            for (let index = 0; index < tower.storeys.length; index++) {
                const storey = tower.storeys[index];
                const topStorey = index === tower.storeys.length - 1;
                context.strokeStyle = powered
                    ? topStorey
                        ? 'rgba(132, 244, 255, 0.95)'
                        : 'rgba(86, 217, 240, 0.48)'
                    : topStorey
                      ? 'rgba(255, 178, 102, 0.95)'
                      : 'rgba(226, 138, 71, 0.48)';
                context.lineWidth = topStorey ? 2 : 1;
                const storeyMinX = storey.worldMinX ?? storey.minX;
                const storeyMaxX = storey.worldMaxX ?? storey.maxX;
                const storeyMinZ = storey.worldMinZ ?? storey.minZ;
                const storeyMaxZ = storey.worldMaxZ ?? storey.maxZ;
                context.strokeRect(
                    this.toCanvasX(storeyMinX),
                    this.toCanvasZ(storeyMinZ),
                    this.toCanvasX(storeyMaxX) - this.toCanvasX(storeyMinX),
                    this.toCanvasZ(storeyMaxZ) - this.toCanvasZ(storeyMinZ),
                );
            }

            const centreX = this.toCanvasX((towerMinX + towerMaxX) / 2);
            const centreZ = this.toCanvasZ((towerMinZ + towerMaxZ) / 2);
            context.fillStyle = powered ? 'rgba(160, 250, 255, 0.95)' : 'rgba(255, 196, 128, 0.95)';
            context.beginPath();
            context.arc(centreX, centreZ, 2.6, 0, Math.PI * 2);
            context.fill();
        }

        context.restore();
    }

    private drawSearchMarks(context: CanvasRenderingContext2D): void {
        for (const site of this.parts.getSites()) {
            if (site.collected) {
                continue;
            }
            const markRadius = Math.max(14, (site.searchRadius / MAP_VIEW_SIZE) * CANVAS_SIZE);
            this.drawSearchMark(context, site, markRadius);
        }
    }

    private drawSearchMark(context: CanvasRenderingContext2D, site: SpaceshipPartSite, markRadius: number): void {
        const x = this.toCanvasX(site.searchX);
        const y = this.toCanvasZ(site.searchZ);

        context.save();
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.strokeStyle = 'rgba(255, 214, 128, 0.78)';
        context.lineWidth = 2;
        context.setLineDash([5, 6]);
        context.beginPath();
        context.arc(x, y, markRadius * SEARCH_MARK_RING_SCALE, 0, Math.PI * 2);
        context.stroke();
        context.restore();
    }

    private drawPlayer(playerX: number, playerZ: number, heading: number): void {
        const context = this.context;
        const x = clamp(this.toCanvasX(playerX), 8, CANVAS_SIZE - 8);
        const y = clamp(this.toCanvasZ(playerZ), 8, CANVAS_SIZE - 8);

        context.save();
        context.translate(x, y);
        // The world's +Z points down the map. Rotating by π - heading maps the arrow's local up
        // vector onto the world forward vector (sin(heading), cos(heading)).
        context.rotate(Math.PI - heading);
        context.beginPath();
        context.moveTo(0, -11);
        context.lineTo(7.5, 8);
        context.lineTo(0, 4.5);
        context.lineTo(-7.5, 8);
        context.closePath();
        context.fillStyle = '#f5fbff';
        context.strokeStyle = '#12303a';
        context.lineWidth = 2;
        context.fill();
        context.stroke();
        context.restore();
    }

    private toCanvasX(worldX: number): number {
        return ((worldX + WRECK_MAP_HALF_SIZE) / MAP_VIEW_SIZE) * CANVAS_SIZE;
    }

    private toCanvasZ(worldZ: number): number {
        return ((worldZ + WRECK_MAP_HALF_SIZE) / MAP_VIEW_SIZE) * CANVAS_SIZE;
    }
}
