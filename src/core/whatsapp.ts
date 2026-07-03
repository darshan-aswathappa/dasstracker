/**
 * Sends WhatsApp notifications via the free CallMeBot relay.
 *
 * CallMeBot is a "send to your own number" HTTP relay: you authorize it once
 * from your phone and it hands you an API key. Sending is a single HTTPS GET to
 * https://api.callmebot.com/whatsapp.php?phone=<phone>&text=<...>&apikey=<key>
 * — which works on hosts that block outbound SMTP (e.g. Hetzner), since it only
 * uses port 443. Mirrors the shape of the email Notifier so the scanner can
 * fan out to both channels.
 */

import type { StoredJob } from './types.js';

export interface WhatsAppConfig {
  /** Full international number, digits only or with a leading '+'. */
  phone: string;
  apikey: string;
}

export interface WhatsAppNotifier {
  readonly configured: boolean;
  send(jobs: StoredJob[]): Promise<void>;
  sendText(text: string): Promise<void>;
}

const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';
const REQUEST_TIMEOUT_MS = 12_000;
// Keep the message (a single GET request) well under URL-length limits.
const MAX_JOBS_IN_MESSAGE = 10;

/** Read WhatsApp config from environment, returning null if incomplete. */
export function whatsappConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppConfig | null {
  // Strip spaces so '+34 123 456' pasted from a phone still works.
  const phone = env.CALLMEBOT_PHONE?.replace(/\s+/g, '');
  const apikey = env.CALLMEBOT_APIKEY?.trim();
  if (!phone || !apikey) return null;
  return { phone, apikey };
}

/** Build a compact plain-text WhatsApp digest for a batch of matched jobs. */
export function buildWhatsAppDigest(jobs: StoredJob[]): string {
  const count = jobs.length;
  const header = `🔔 ${count} new 3DS tech job${count === 1 ? '' : 's'}:`;
  const shown = jobs.slice(0, MAX_JOBS_IN_MESSAGE);
  const lines = shown.map((j, i) => {
    const loc = j.location || 'n/a';
    const cat = j.category || 'n/a';
    return `${i + 1}. ${j.title}\n   ${loc} · ${cat}\n   ${j.applyUrl || j.url}`;
  });
  const more = count > shown.length ? `\n\n…and ${count - shown.length} more` : '';
  return `${header}\n\n${lines.join('\n\n')}${more}`;
}

/** Remove HTML tags from a CallMeBot error page for a readable message. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Create a CallMeBot-backed WhatsApp notifier. */
export function createWhatsAppNotifier(
  config: WhatsAppConfig | null,
  fetchImpl: typeof fetch = fetch,
): WhatsAppNotifier {
  if (!config) {
    const notConfigured = async (): Promise<never> => {
      throw new Error(
        'WhatsApp not configured (set CALLMEBOT_PHONE and CALLMEBOT_APIKEY).',
      );
    };
    return { configured: false, send: notConfigured, sendText: notConfigured };
  }

  const sendText = async (text: string): Promise<void> => {
    const url =
      `${CALLMEBOT_URL}?phone=${encodeURIComponent(config.phone)}` +
      `&text=${encodeURIComponent(text)}` +
      `&apikey=${encodeURIComponent(config.apikey)}`;

    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CallMeBot request failed: ${msg}`);
    }

    const body = (await res.text().catch(() => '')).trim();
    if (!res.ok) {
      throw new Error(
        `CallMeBot HTTP ${res.status}: ${stripHtml(body).slice(0, 200) || 'no response body'}`,
      );
    }
    // CallMeBot returns HTTP 200 with an HTML message even for some failures
    // (bad API key, number not authorized), so inspect the body too.
    const queued = /queued|will receive/i.test(body);
    if (!queued && /not\s*valid|invalid|error|api\s*key|not\s*authorized/i.test(body)) {
      throw new Error(`CallMeBot rejected the message: ${stripHtml(body).slice(0, 200)}`);
    }
  };

  return {
    configured: true,
    sendText,
    async send(jobs: StoredJob[]) {
      if (jobs.length === 0) return;
      await sendText(buildWhatsAppDigest(jobs));
    },
  };
}
