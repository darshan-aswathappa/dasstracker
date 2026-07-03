/**
 * DassTracker server entry point. Boots Fastify, serves the static UI, wires
 * the API routes, and starts the recurring scan scheduler. Runs an initial scan
 * on startup (which seeds the baseline on first ever run).
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnv } from '../core/env.js';
import { createApp } from './app.js';

// Load .env before anything reads process.env (SMTP credentials, PORT, etc.).
loadEnv();
import { registerRoutes } from './routes.js';
import { createScheduler } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const ctx = createApp();
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, {
    root: resolve(__dirname, '../web'),
    prefix: '/',
  });

  const scheduler = createScheduler(() => ctx.scan());
  registerRoutes(app, ctx, scheduler);

  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '127.0.0.1' });
  ctx.log(`DassTracker UI at http://localhost:${port}`);

  const config = ctx.getConfig();
  scheduler.start(config.intervalMinutes);
  ctx.log(`Scheduler started: scanning every ${config.intervalMinutes} min.`);

  // Kick off an initial scan (seeds baseline on first ever run).
  ctx.scan().catch((err) => ctx.log(`Initial scan failed: ${err}`));

  const shutdown = async () => {
    ctx.log('Shutting down...');
    scheduler.stop();
    await app.close();
    ctx.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
