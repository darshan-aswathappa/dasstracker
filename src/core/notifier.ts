/**
 * Sends digest notification emails via Gmail SMTP (Nodemailer).
 *
 * One email per scan cycle summarizing all newly matched jobs — never one email
 * per job. Credentials come from the environment; the transport is created
 * lazily so the rest of the app runs even when email is not configured.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { StoredJob } from './types.js';

export interface MailerConfig {
  user: string;
  appPassword: string;
  /** One or more recipients; guaranteed non-empty. */
  to: string[];
}

export interface Notifier {
  send(jobs: StoredJob[]): Promise<void>;
  /** Confirm an auto-submitted application to the apply-notification list. */
  sendApplied(job: StoredJob, to: string[]): Promise<void>;
  verify(): Promise<void>;
  readonly configured: boolean;
}

/** Who gets told when an application is submitted. */
export function applyNotifyList(env: NodeJS.ProcessEnv): string[] {
  const configured = parseEmailList(env.APPLY_NOTIFY_TO);
  return configured.length > 0 ? configured : DEFAULT_APPLY_NOTIFY;
}

const DEFAULT_APPLY_NOTIFY = ['darshanaswath@gmail.com', 'huns.n@northeastern.edu'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True if the string looks like a deliverable address. */
export function isValidEmail(address: string): boolean {
  return EMAIL_RE.test(address);
}

/**
 * Normalize an address list into trimmed, de-duplicated entries.
 *
 * Accepts an array or a separated string so that a hand-edited NOTIFY_TO, a
 * pasted "a@x.com, b@y.com", and a config written before multi-recipient
 * support (a bare string) all parse identically. Never throws — callers that
 * need rejection validate with isValidEmail.
 */
export function parseEmailList(input: string | string[] | null | undefined): string[] {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : String(input).split(/[,;\n]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const address = String(part).trim();
    // De-dupe case-insensitively, but keep the casing the user typed.
    if (!address || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    out.push(address);
  }
  return out;
}

/** Read mailer config from environment, returning null if incomplete. */
export function mailerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  notifyToOverride?: string | string[] | null,
): MailerConfig | null {
  const user = env.GMAIL_USER?.trim();
  // Gmail shows App Passwords as 4 space-separated groups, but auth needs the
  // raw 16 chars — strip all whitespace so it works pasted either way.
  const appPassword = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !appPassword) return null;
  const override = parseEmailList(notifyToOverride);
  const fromEnv = parseEmailList(env.NOTIFY_TO);
  const to = override.length ? override : fromEnv.length ? fromEnv : [user];
  return { user, appPassword, to };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPosted(iso: string): string {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

/** Build the plain-text and HTML bodies for a digest of matched jobs. */
export function buildDigest(jobs: StoredJob[]): {
  subject: string;
  text: string;
  html: string;
} {
  const count = jobs.length;
  const subject =
    count === 1
      ? `New 3DS tech job: ${jobs[0].title}`
      : `${count} new 3DS tech jobs`;

  const textLines = jobs.map((j, i) => {
    return [
      `${i + 1}. ${j.title}`,
      `   Location: ${j.location || 'n/a'}`,
      `   Category: ${j.category || 'n/a'}${j.products ? ` | Product: ${j.products}` : ''}`,
      `   Posted:   ${formatPosted(j.postedAt)}`,
      `   View:     ${j.url}`,
      `   Apply:    ${j.applyUrl}`,
    ].join('\n');
  });
  const text = `${count} new matching job${count === 1 ? '' : 's'} on the 3DS careers site:\n\n${textLines.join('\n\n')}\n`;

  const rows = jobs
    .map((j) => {
      return `
        <div style="border-left:3px solid #ff8c00;padding:8px 14px;margin:0 0 14px;">
          <div style="font-size:15px;font-weight:600;color:#111;">
            <a href="${escapeHtml(j.url)}" style="color:#0870d3;text-decoration:none;">${escapeHtml(j.title)}</a>
          </div>
          <div style="font-size:13px;color:#444;margin-top:4px;">
            ${escapeHtml(j.location || 'n/a')} &nbsp;·&nbsp; ${escapeHtml(j.category || 'n/a')}${
              j.products ? ` &nbsp;·&nbsp; ${escapeHtml(j.products)}` : ''
            }
          </div>
          <div style="font-size:12px;color:#888;margin-top:2px;">Posted ${escapeHtml(
            formatPosted(j.postedAt),
          )}</div>
          <div style="font-size:13px;margin-top:6px;">
            <a href="${escapeHtml(j.applyUrl)}" style="color:#ff8c00;font-weight:600;text-decoration:none;">Apply →</a>
          </div>
        </div>`;
    })
    .join('');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;">
      <h2 style="font-size:17px;color:#111;">${count} new matching job${count === 1 ? '' : 's'} on the 3DS careers site</h2>
      ${rows}
      <p style="font-size:11px;color:#aaa;margin-top:20px;">Sent by DassTracker.</p>
    </div>`;

  return { subject, text, html };
}

/** Subject and body for a submitted-application confirmation. */
export function buildAppliedEmail(job: StoredJob): {
  subject: string;
  text: string;
  html: string;
} {
  const title = job.title.trim();
  const subject = `Applied: ${title}`;
  const where = job.location || 'n/a';
  const text = [
    `Applied to the job successfully.`,
    ``,
    `Title:      ${title}`,
    `Location:   ${where}`,
    `Category:   ${job.category || 'n/a'}`,
    `Experience: ${job.experience || 'n/a'}`,
    `Posting:    ${job.url}`,
    ``,
    `Submitted by DassTracker auto-apply.`,
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;">
      <h2 style="font-size:17px;color:#111;">Applied to the job successfully</h2>
      <div style="border-left:3px solid #3a5f4a;padding:8px 14px;margin:0 0 14px;">
        <div style="font-size:15px;font-weight:600;color:#111;">
          <a href="${escapeHtml(job.url)}" style="color:#0870d3;text-decoration:none;">${escapeHtml(title)}</a>
        </div>
        <div style="font-size:13px;color:#444;margin-top:4px;">
          ${escapeHtml(where)} &nbsp;·&nbsp; ${escapeHtml(job.category || 'n/a')}
        </div>
        <div style="font-size:12px;color:#888;margin-top:2px;">
          Experience level: ${escapeHtml(job.experience || 'n/a')}
        </div>
      </div>
      <p style="font-size:11px;color:#aaa;margin-top:20px;">
        Submitted by DassTracker auto-apply.
      </p>
    </div>`;

  return { subject, text, html };
}

/** Create a Gmail-backed notifier. */
export function createNotifier(config: MailerConfig | null): Notifier {
  if (!config) {
    return {
      configured: false,
      async send() {
        throw new Error('Email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD).');
      },
      async sendApplied() {
        throw new Error('Email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD).');
      },
      async verify() {
        throw new Error('Email not configured (set GMAIL_USER and GMAIL_APP_PASSWORD).');
      },
    };
  }

  let transporter: Transporter | null = null;
  const getTransport = (): Transporter => {
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        // Port 587 (STARTTLS) rather than 465 (implicit SSL): some hosts
        // (e.g. Hetzner) block outbound 465 but leave 587 open.
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: config.user, pass: config.appPassword },
        // Fail fast instead of hanging the request if outbound SMTP is blocked.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    }
    return transporter;
  };

  return {
    configured: true,
    async verify() {
      await getTransport().verify();
    },
    async send(jobs: StoredJob[]) {
      if (jobs.length === 0) return;
      const { subject, text, html } = buildDigest(jobs);
      // With several recipients, address the mail to the sending account and
      // BCC the list so no recipient sees the others' addresses. A single
      // recipient goes in To: directly — a lone BCC with the sender in To:
      // reads like it was misdelivered.
      const recipients =
        config.to.length > 1
          ? { to: config.user, bcc: config.to }
          : { to: config.to[0] ?? config.user };
      await getTransport().sendMail({
        from: `DassTracker <${config.user}>`,
        ...recipients,
        subject,
        text,
        html,
      });
    },
    async sendApplied(job: StoredJob, to: string[]) {
      const recipients = parseEmailList(to);
      if (recipients.length === 0) return;
      const { subject, text, html } = buildAppliedEmail(job);
      // Both named recipients should see each other here: this is a two-person
      // confirmation, not a bulk digest, so To: rather than BCC.
      await getTransport().sendMail({
        from: `DassTracker <${config.user}>`,
        to: recipients,
        subject,
        text,
        html,
      });
    },
  };
}
