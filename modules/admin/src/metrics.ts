/** Machine metrics (W19): one sample = CPU %, memory %, disk % (of the disk holding $PASABOT_HOME), 1-min load. */
import { statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { z } from 'zod';

export interface Sample {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  load: number | null;
}
export type Sampler = () => Sample | Promise<Sample>;
export const METRICS = ['cpu', 'mem', 'disk', 'load'] as const;
export type Metric = (typeof METRICS)[number];

const round = (n: number) => Math.round(n * 10) / 10;

/** The real sampler. CPU % is the busy share across all cores since the previous call. */
export function hostSampler(home: string): Sampler {
  const times = () =>
    cpus().reduce(
      (a, c) => {
        const t = c.times;
        a.idle += t.idle;
        a.total += t.user + t.nice + t.sys + t.idle + t.irq;
        return a;
      },
      { idle: 0, total: 0 },
    );
  let prev = times();
  return () => {
    const now = times();
    const dt = now.total - prev.total;
    const cpu = dt > 0 ? round(100 * (1 - (now.idle - prev.idle) / dt)) : null;
    prev = now;
    let disk: number | null = null;
    try {
      const s = statfsSync(home);
      disk = s.blocks > 0 ? round(100 * (1 - s.bavail / s.blocks)) : null;
    } catch {
      disk = null;
    }
    const tm = totalmem();
    return {
      cpu,
      mem: tm > 0 ? round(100 * (1 - freemem() / tm)) : null,
      disk,
      load: round(loadavg()[0] ?? 0),
    };
  };
}

export const alertRuleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  metric: z.enum(METRICS),
  /** fires when the metric is above this value */
  above: z.number().min(0).max(100_000),
  /** how many samples in a row must be above it (1 = the latest one) */
  forSamples: z.number().int().min(1).max(60).default(1),
  /** quiet time after a fire */
  cooldownMin: z.number().int().min(0).max(10_080).default(30),
  level: z.enum(['warn', 'error']).default('warn'),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;
