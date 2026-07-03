/**
 * Standalone single-scan entry point. Runs exactly one scan cycle and exits.
 * Used for manual runs and, in Phase 2, as the command a GitHub Actions cron
 * (schedule: every 10 min) invokes for 24/7 coverage while the Mac is asleep.
 */

import { loadEnv } from '../src/core/env.js';
import { createApp } from '../src/server/app.js';

// Load .env so SMTP credentials are available for notifications.
loadEnv();

async function main() {
  const ctx = createApp();
  const result = await ctx.scan();
  ctx.log(`scan-once result: ${JSON.stringify(result)}`);
  ctx.store.close();
  process.exit(result.error ? 1 : 0);
}

main().catch((err) => {
  console.error('scan-once failed:', err);
  process.exit(1);
});
