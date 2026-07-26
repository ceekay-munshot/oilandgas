/**
 * Load a gitignored .env for local runs.
 *
 * Zero dependency - Node 20.6+ ships process.loadEnvFile(). In CI there is no
 * .env and the secrets already sit in process.env, so this is a silent no-op.
 *
 * Real values already in the environment always win: a shell that exported a
 * key should not be overridden by a stale file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function loadEnv({ path = resolve(ROOT, '.env'), env = process.env } = {}) {
  if (!existsSync(path)) return { loaded: false, keys: [] };

  const before = new Set(Object.keys(env).filter((k) => env[k]));

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path);
  } else {
    // Node < 20.6: parse the simple KEY=value form ourselves.
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!env[key]) env[key] = val;
    }
  }

  const keys = Object.keys(env).filter((k) => env[k] && !before.has(k));
  return { loaded: true, path, keys };
}

/** Which credentials are present, by name only - never the values. */
export function credentialReport(env = process.env) {
  const names = [
    'FIRECRAWL_API_KEY', 'SCRAPEDO_API_KEY',
    'SCREENER_EMAIL', 'SCREENER_PASSWORD',
    'OPENAI_API_KEY', 'MISTRAL_API_KEY'
  ];
  return names.map((n) => ({ name: n, present: Boolean(env[n]) }));
}
