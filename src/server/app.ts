/**
 * Shared application context: wires the store, config, and notifier together
 * and exposes a single runScan entry point. Used by both the HTTP server and
 * the standalone scan-once script so behavior is identical in both.
 */

import { resolve } from 'node:path';
import type { Store } from '../core/store.js';
import { Store as StoreImpl } from '../core/store.js';
import { loadDefaults, sanitizeConfig } from '../core/config.js';
import { createNotifier, mailerConfigFromEnv, type Notifier } from '../core/notifier.js';
import {
  createWhatsAppNotifier,
  whatsappConfigFromEnv,
  type WhatsAppNotifier,
} from '../core/whatsapp.js';
import { createJevClassifier, jevConfigFromEnv, type JevClassifier } from '../core/jev.js';
import { runScan } from '../core/scanner.js';
import type { ScanResult, TrackerConfig } from '../core/types.js';

export interface AppContext {
  store: Store;
  getConfig(): TrackerConfig;
  setConfig(next: TrackerConfig): void;
  buildNotifier(): Notifier;
  buildWhatsApp(): WhatsAppNotifier;
  buildJev(): JevClassifier;
  scan(): Promise<ScanResult>;
  log(msg: string): void;
}

export function createApp(env: NodeJS.ProcessEnv = process.env): AppContext {
  const dbPath = env.DB_PATH?.trim() || resolve(process.cwd(), 'data/tracker.db');
  const store = new StoreImpl(dbPath);
  const defaults = loadDefaults();

  const log = (msg: string) => {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  };

  // Sanitize on read as well as write: a settings row persisted before
  // multi-recipient support holds notifyTo as a bare string, and every consumer
  // downstream expects the array form.
  const getConfig = (): TrackerConfig => sanitizeConfig({}, store.loadConfig(defaults));
  const setConfig = (next: TrackerConfig): void => store.saveConfig(next);

  const buildNotifier = (): Notifier => {
    const cfg = getConfig();
    return createNotifier(mailerConfigFromEnv(env, cfg.notifyTo));
  };

  const buildWhatsApp = (): WhatsAppNotifier =>
    createWhatsAppNotifier(whatsappConfigFromEnv(env), fetch, log);

  const buildJev = (): JevClassifier => createJevClassifier(jevConfigFromEnv(env));

  const scan = (): Promise<ScanResult> =>
    runScan({
      store,
      notifier: buildNotifier(),
      whatsapp: buildWhatsApp(),
      jev: buildJev(),
      config: getConfig(),
      log,
    });

  return { store, getConfig, setConfig, buildNotifier, buildWhatsApp, buildJev, scan, log };
}
