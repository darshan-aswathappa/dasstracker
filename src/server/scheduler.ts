/**
 * Wraps node-cron to run a scan on a fixed minute interval, with the ability to
 * reschedule live when the user changes the interval in the UI. Tracks the next
 * expected run time for display in the status endpoint.
 */

import cron, { type ScheduledTask } from 'node-cron';

export interface Scheduler {
  start(intervalMinutes: number): void;
  reschedule(intervalMinutes: number): void;
  nextRunAt(): string | null;
  stop(): void;
}

/** Clamp an interval to the range a minute-field cron can express (1..59). */
function clampStep(n: number): number {
  return Math.min(Math.max(Math.floor(n), 1), 59);
}

/** Build a cron expression that fires every N minutes (N clamped to 1..59). */
function everyNMinutes(n: number): string {
  return `*/${clampStep(n)} * * * *`;
}

/**
 * The next wall-clock time an every-N-minutes cron will actually fire, relative
 * to `from`. Cron fires on minutes divisible by `step` within each hour (and
 * rolls over at the top of the hour), so this mirrors that instead of naively
 * adding the interval — which would be wrong at startup and whenever the step
 * does not divide 60 evenly.
 */
function nextRunFrom(from: Date, step: number): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  do {
    d.setMinutes(d.getMinutes() + 1);
  } while (d.getMinutes() % step !== 0);
  return d;
}

export function createScheduler(runScan: () => Promise<unknown>): Scheduler {
  let task: ScheduledTask | null = null;
  let step = 0;
  let running = false;

  const tick = async () => {
    if (running) return; // avoid overlapping scans
    running = true;
    try {
      await runScan();
    } finally {
      running = false;
    }
  };

  const schedule = (intervalMinutes: number) => {
    if (task) task.stop();
    step = clampStep(intervalMinutes);
    task = cron.schedule(everyNMinutes(intervalMinutes), tick);
  };

  return {
    start(intervalMinutes: number) {
      schedule(intervalMinutes);
    },
    reschedule(intervalMinutes: number) {
      schedule(intervalMinutes);
    },
    nextRunAt() {
      if (!task || step === 0) return null;
      return nextRunFrom(new Date(), step).toISOString();
    },
    stop() {
      if (task) task.stop();
      task = null;
    },
  };
}
