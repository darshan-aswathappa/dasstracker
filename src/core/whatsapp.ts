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

/** One CallMeBot registration: a key is bound to the number it was issued for. */
export interface WhatsAppRecipient {
  /** Full international number, digits only or with a leading '+'. */
  phone: string;
  apikey: string;
}

export interface WhatsAppConfig {
  /** Every registration to fan the digest out to; guaranteed non-empty. */
  recipients: WhatsAppRecipient[];
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

/**
 * Read WhatsApp config from environment, returning null if incomplete.
 *
 * Multiple recipients come from CALLMEBOT_RECIPIENTS as `phone:apikey` pairs:
 *
 *   CALLMEBOT_RECIPIENTS=15551234567:1111111,15559876543:2222222
 *
 * Each pair is self-contained deliberately. Two parallel comma lists
 * (CALLMEBOT_PHONE / CALLMEBOT_APIKEY) would silently mis-pair a number with
 * someone else's key the moment the two lists drift out of step. The legacy
 * single-pair vars are still honored when CALLMEBOT_RECIPIENTS is absent.
 */
export function whatsappConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppConfig | null {
  const recipients = parseRecipients(env.CALLMEBOT_RECIPIENTS);
  if (recipients.length > 0) return { recipients };

  // Strip spaces so '+34 123 456' pasted from a phone still works.
  const phone = env.CALLMEBOT_PHONE?.replace(/\s+/g, '');
  const apikey = env.CALLMEBOT_APIKEY?.trim();
  if (!phone || !apikey) return null;
  return { recipients: [{ phone, apikey }] };
}

/** Parse a `phone:apikey,phone:apikey` list, skipping malformed entries. */
export function parseRecipients(
  input: string | null | undefined,
): WhatsAppRecipient[] {
  if (!input) return [];
  const out: WhatsAppRecipient[] = [];
  const seen = new Set<string>();
  for (const entry of input.split(',')) {
    const [rawPhone, rawKey] = entry.split(':');
    const phone = rawPhone?.replace(/\s+/g, '') ?? '';
    const apikey = rawKey?.trim() ?? '';
    // Both halves are required; a bare number with no key cannot be delivered.
    if (!phone || !apikey || seen.has(phone)) continue;
    seen.add(phone);
    out.push({ phone, apikey });
  }
  return out;
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
  log: (msg: string) => void = () => {},
): WhatsAppNotifier {
  if (!config || config.recipients.length === 0) {
    const notConfigured = async (): Promise<never> => {
      throw new Error(
        'WhatsApp not configured (set CALLMEBOT_RECIPIENTS as phone:apikey pairs).',
      );
    };
    return { configured: false, send: notConfigured, sendText: notConfigured };
  }

  const sendToOne = async (
    recipient: WhatsAppRecipient,
    text: string,
  ): Promise<void> => {
    const url =
      `${CALLMEBOT_URL}?phone=${encodeURIComponent(recipient.phone)}` +
      `&text=${encodeURIComponent(text)}` +
      `&apikey=${encodeURIComponent(recipient.apikey)}`;

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
    // CallMeBot answers 2xx with an HTML page for failures too — a paused
    // account returns HTTP 208 "Your Account is Paused". So require an explicit
    // queued confirmation rather than blacklisting known failure phrases, which
    // can only ever catch the wordings someone thought of in advance.
    if (!/queued|will receive/i.test(body)) {
      throw new Error(
        `CallMeBot did not confirm delivery (HTTP ${res.status}): ${
          stripHtml(body).slice(0, 200) || 'no response body'
        }`,
      );
    }
  };

  /** Mask all but the last 4 digits so logs never carry a full number. */
  const maskPhone = (phone: string): string =>
    phone.length > 4 ? `…${phone.slice(-4)}` : phone;

  const sendText = async (text: string): Promise<void> => {
    // Fan out to every registration independently: one paused or revoked key
    // must not stop the other numbers from receiving the digest. Only an
    // all-recipients failure throws, so the scanner still marks jobs notified
    // when at least one number got the message.
    const failures: string[] = [];
    for (const recipient of config.recipients) {
      try {
        await sendToOne(recipient, text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${maskPhone(recipient.phone)}: ${msg}`);
      }
    }

    if (failures.length === config.recipients.length) {
      throw new Error(failures.join(' | '));
    }
    for (const failure of failures) {
      // Partial failure: surface it, since the caller sees overall success.
      log(`WhatsApp delivery failed for ${failure}`);
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
