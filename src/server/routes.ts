/**
 * HTTP API routes for the local web UI.
 */

import type { FastifyInstance } from 'fastify';
import type { AppContext } from './app.js';
import { sanitizeConfig } from '../core/config.js';
import { isValidEmail, parseEmailList } from '../core/notifier.js';
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
    const jobs = ctx.store.recentJobs(limit, onlyMatched);
    const applied = new Set(
      ctx.store
        .recentApplications(500)
        .filter((a) => a.status === 'submitted')
        .map((a) => a.cardId),
    );
    return { jobs: jobs.map((j) => ({ ...j, applied: applied.has(j.cardId) })) };
  });

  // Current config (no secrets).
  app.get('/api/config', async () => ({ config: ctx.getConfig() }));

  // Update config; reschedules the cron if the interval changed.
  app.put('/api/config', async (req, reply) => {
    const patch = (req.body ?? {}) as Partial<TrackerConfig>;
    const current = ctx.getConfig();

    // Reject bad recipients rather than silently dropping them — a typo'd
    // address would otherwise look saved while never receiving a digest.
    if (patch.notifyTo !== undefined) {
      const invalid = parseEmailList(patch.notifyTo).filter((a) => !isValidEmail(a));
      if (invalid.length > 0) {
        reply.code(400).send({
          error: `Invalid email address${invalid.length > 1 ? 'es' : ''}: ${invalid.join(', ')}`,
        });
        return;
      }
    }

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

  // Status: last scan, next scan time, totals, notifier config state, recent scans.
  app.get('/api/status', async () => {
    const notifier = ctx.buildNotifier();
    return {
      lastScan: ctx.store.lastScan(),
      recentScans: ctx.store.recentScans(10),
      totalJobs: ctx.store.countJobs(),
      nextScanAt: scheduler.nextRunAt(),
      intervalMinutes: ctx.getConfig().intervalMinutes,
      emailConfigured: notifier.configured,
      whatsappConfigured: ctx.buildWhatsApp().configured,
      jevConfigured: ctx.buildJev().configured,
      classification: ctx.store.classificationCounts(),
      autoApply: {
        armed: ctx.autoApplyArmed(),
        credentialed: ctx.buildApplicator().configured,
        submitted: ctx.store.countApplications('submitted'),
        failed: ctx.store.countApplications('failed'),
      },
    };
  });

  // Recent auto-apply attempts, newest first.
  app.get('/api/applications', async () => ({
    applications: ctx.store.recentApplications(50),
  }));

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
          experience: '0 to 3 years',
          postedAt: new Date().toISOString(),
          firstSeenAt: new Date().toISOString(),
          matched: true,
          notifiedAt: null,
          entryLevel: true,
          classifiedAt: new Date().toISOString(),
        },
      ]);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Send a test WhatsApp message via CallMeBot to verify the phone + API key.
  app.post('/api/test-whatsapp', async (_req, reply) => {
    const wa = ctx.buildWhatsApp();
    if (!wa.configured) {
      reply.code(400).send({
        ok: false,
        error: 'WhatsApp not configured. Set CALLMEBOT_PHONE and CALLMEBOT_APIKEY in .env.',
      });
      return;
    }
    try {
      await wa.sendText('✅ DassTracker test message — WhatsApp notifications are working.');
      reply.send({ ok: true });
    } catch (err) {
      reply.code(500).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
