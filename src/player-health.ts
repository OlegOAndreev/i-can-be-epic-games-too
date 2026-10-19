import { DIFFICULTY_SETTINGS } from './enemies';
import type { Difficulty } from './enemies';

// Once the floor is safe the robot repairs itself in about a second, so the red edge drains fast
// enough to reward clearing the last hostile before walking away.
const RECOVERY_HITS_PER_SECOND = 6;

// The hits the robot can absorb from tower lasers before its chassis is destroyed. Damage is whole
// hits rather than a smooth bar, matching the discrete volleys the floor robots fire.
export class PlayerHealth {
    private maximum: number;
    private health: number;

    constructor(difficulty: Difficulty) {
        this.maximum = DIFFICULTY_SETTINGS[difficulty].playerHitsToDestroy;
        this.health = this.maximum;
    }

    get maximumHits(): number {
        return this.maximum;
    }

    get hitsRemaining(): number {
        return this.health;
    }

    get destroyed(): boolean {
        return this.health <= 0;
    }

    // Share of the robot's health that is missing, used to drive the damage vignette.
    get damageFraction(): number {
        return 1 - this.health / this.maximum;
    }

    // Keeps the damage already taken when the difficulty changes. Switching to a harder setting can
    // leave the robot at one hit, but never destroys it without an actual laser strike.
    setDifficulty(difficulty: Difficulty): void {
        const wasDestroyed = this.destroyed;
        const damageTaken = this.maximum - this.health;
        this.maximum = DIFFICULTY_SETTINGS[difficulty].playerHitsToDestroy;
        this.health = wasDestroyed
            ? this.maximum
            : Math.max(1, Math.min(this.maximum, this.maximum - damageTaken));
    }

    // Returns true when this strike destroyed the robot.
    hit(count = 1): boolean {
        if (this.destroyed) {
            return false;
        }
        this.health = Math.max(0, this.health - Math.max(0, count));
        return this.destroyed;
    }

    recover(dt: number): void {
        if (this.destroyed) {
            return;
        }
        this.health = Math.min(this.maximum, this.health + RECOVERY_HITS_PER_SECOND * dt);
    }

    reset(): void {
        this.health = this.maximum;
    }
}
