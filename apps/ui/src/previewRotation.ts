/** A display-only clock. Never store its offset in capture settings. */
export class PreviewRotationClock {
  private angle = 0;
  private previous: number | null = null;

  step(timestamp: number, active: boolean): number {
    if (!active) {
      this.angle = 0;
      this.previous = null;
      return 0;
    }
    if (this.previous !== null) {
      const elapsed = Math.max(0, Math.min(100, timestamp - this.previous));
      this.angle = (this.angle + (elapsed * Math.PI) / 15000) % (2 * Math.PI);
    }
    this.previous = timestamp;
    return this.angle;
  }
}
