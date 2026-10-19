import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { ShipExplosion } from './ship-explosion';

describe('ship explosion', () => {
    it('appears where the ship crashed and clears itself after the blast', () => {
        const explosion = new ShipExplosion();
        const position = new Vector3(12, 40, -8);

        expect(explosion.group.visible).toBe(false);
        explosion.trigger(position, 0);
        expect(explosion.group.visible).toBe(true);
        expect(explosion.group.position.toArray()).toEqual([12, 40, -8]);

        explosion.update(1);
        expect(explosion.group.visible).toBe(true);
        explosion.update(2);
        expect(explosion.group.visible).toBe(false);
    });

    it('can be fired again on a later attempt', () => {
        const explosion = new ShipExplosion();
        explosion.trigger(new Vector3(), 0);
        explosion.update(3);
        expect(explosion.group.visible).toBe(false);

        explosion.trigger(new Vector3(1, 2, 3), 0);
        expect(explosion.group.visible).toBe(true);
        expect(explosion.group.position.toArray()).toEqual([1, 2, 3]);
    });
});
