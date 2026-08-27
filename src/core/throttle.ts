export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function gaussian(mean: number, sigma: number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sigma * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export interface ThrottleOptions {
  min?: number;
  max?: number;
  gaussian?: boolean;
  mean?: number;
  sigma?: number;
}

export interface Throttle {
  wait(): Promise<void>;
  readonly hits: number;
}

export function createThrottle(opts: ThrottleOptions = {}): Throttle {
  const min = opts.min ?? 800;
  const max = opts.max ?? 2500;
  let hits = 0;
  return {
    async wait() {
      hits += 1;
      const ms = opts.gaussian
        ? Math.max(200, Math.round(gaussian(opts.mean ?? 1500, opts.sigma ?? 450)))
        : Math.round(rand(min, max));
      await delay(ms);
    },
    get hits() {
      return hits;
    },
  };
}

export function parseThrottleEnv(): { min: number; max: number } {
  const raw = process.env['51JOB_DELAY'];
  if (!raw) return { min: 800, max: 2500 };
  const parts = raw.split(',').map((s) => parseInt(s.trim(), 10));
  if (parts.length === 1 && !Number.isNaN(parts[0])) return { min: parts[0], max: parts[0] };
  if (parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
    return { min: parts[0], max: Math.max(parts[0], parts[1]) };
  }
  return { min: 800, max: 2500 };
}
