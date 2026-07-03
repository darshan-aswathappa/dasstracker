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

/** Build a cron expression that fires every N minutes (N clamped to 1..59). */
function everyNMinutes(n: number): string {
  const step = Math.min(Math.max(Math.floor(n), 1), 59);
  return `*/${step} * * * *`;
}

export function createScheduler(runScan: () => Promise<unknown>): Scheduler {
  let task: ScheduledTask | null = null;
  let intervalMs = 0;
  let lastStart = 0;
  let running = false;

  const tick = async () => {
    if (running) return; // avoid overlapping scans
    running = true;
    lastStart = Date.now();
    try {
      await runScan();
    } finally {
      running = false;
    }
  };

  const schedule = (intervalMinutes: number) => {
    if (task) task.stop();
    intervalMs = Math.min(Math.max(Math.floor(intervalMinutes), 1), 59) * 60_000;
    task = cron.schedule(everyNMinutes(intervalMinutes), tick);
    lastStart = Date.now();
  };

  return {
    start(intervalMinutes: number) {
      schedule(intervalMinutes);
    },
    reschedule(intervalMinutes: number) {
      schedule(intervalMinutes);
    },
    nextRunAt() {
      if (!task || intervalMs === 0) return null;
      return new Date(lastStart + intervalMs).toISOString();
    },
    stop() {
      if (task) task.stop();
      task = null;
    },
  };
}
