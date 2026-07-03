/**
 * HTTP API routes for the local web UI.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.js';
import { sanitizeConfig } from '../core/config.js';
import type { Scheduler } from './scheduler.js';
import type { TrackerConfig } from '../core/types.js';

export function registerRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  scheduler: Scheduler,
): void {
  // Recent jobs. ?matched=1 restricts to matched (technical) roles.
  app.get('/api/jobs', async (req) => {
    const q = req.query as { matched?: string; limit?: string };
    const onlyMatched = q.matched === '1' || q.matched === 'true';
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return { jobs: ctx.store.recentJobs(limit, onlyMatched) };
  });

  // Current config (no secrets).
  app.get('/api/config', async () => ({ config: ctx.getConfig() }));

  // Update config; reschedules the cron if the interval changed.
  app.put('/api/config', async (req, reply) => {
    const patch = (req.body ?? {}) as Partial<TrackerConfig>;
    const current = ctx.getConfig();
    const next = sanitizeConfig(patch, current);
    ctx.setConfig(next);
    if (next.intervalMinutes !== current.intervalMinutes) {
      scheduler.reschedule(next.intervalMinutes);
    }
    reply.send({ config: next, rescheduled: next.intervalMinutes !== current.intervalMinutes });
  });

  // Trigger a scan immediately.
  app.post('/api/scan', async () => {
    const result = await ctx.scan();
    return { result };
  });

  // Status: last scan, next scan time, totals, email config state, recent scans.
  app.get('/api/status', async () => {
    const notifier = ctx.buildNotifier();
    return {
      lastScan: ctx.store.lastScan(),
      recentScans: ctx.store.recentScans(10),
      totalJobs: ctx.store.countJobs(),
      nextScanAt: scheduler.nextRunAt(),
      intervalMinutes: ctx.getConfig().intervalMinutes,
      emailConfigured: notifier.configured,
    };
  });

  // Send a test email to verify SMTP credentials.
  app.post('/api/test-email', async (_req, reply) => {
    const notifier = ctx.buildNotifier();
    if (!notifier.configured) {
      reply.code(400).send({
        ok: false,
        error: 'Email not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in .env.',
      });
      return;
    }
    try {
      await notifier.verify();
      await notifier.send([
        {
          cardId: 'test',
          title: 'DassTracker test email',
          url: 'https://www.3ds.com/careers/jobs',
          applyUrl: 'https://www.3ds.com/careers/jobs',
          location: 'Test',
          category: 'Information Technology',
          products: '',
          postedAt: new Date().toISOString(),
          firstSeenAt: new Date().toISOString(),
          matched: true,
          notifiedAt: null,
        },
      ]);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
