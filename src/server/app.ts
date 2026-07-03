/**
 * Shared application context: wires the store, config, and notifier together
 * and exposes a single runScan entry point. Used by both the HTTP server and
 * the standalone scan-once script so behavior is identical in both.
 */

import { resolve } from 'node:path';
import type { Store } from '../core/store.js';
import { Store as StoreImpl } from '../core/store.js';
import { loadDefaults } from '../core/config.js';
import { createNotifier, mailerConfigFromEnv, type Notifier } from '../core/notifier.js';
import { runScan } from '../core/scanner.js';
import type { ScanResult, TrackerConfig } from '../core/types.js';

export interface AppContext {
  store: Store;
  getConfig(): TrackerConfig;
  setConfig(next: TrackerConfig): void;
  buildNotifier(): Notifier;
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

  const getConfig = (): TrackerConfig => store.loadConfig(defaults);
  const setConfig = (next: TrackerConfig): void => store.saveConfig(next);

  const buildNotifier = (): Notifier => {
    const cfg = getConfig();
    return createNotifier(mailerConfigFromEnv(env, cfg.notifyTo));
  };

  const scan = (): Promise<ScanResult> =>
    runScan({
      store,
      notifier: buildNotifier(),
      config: getConfig(),
      log,
    });

  return { store, getConfig, setConfig, buildNotifier, scan, log };
}
