/**
 * Minimal, dependency-free .env loader.
 *
 * Node does not read .env files automatically (outside the `--env-file` CLI
 * flag), so we parse and apply one at startup. Existing process.env values are
 * never overwritten, so real environment variables still take precedence.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Parse .env text into key/value pairs. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    // Strip surrounding matching quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load a .env file (default: ./.env relative to cwd) into process.env without
 * overwriting existing values. Silently does nothing if the file is absent.
 */
export function loadEnv(path = resolve(process.cwd(), '.env')): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
