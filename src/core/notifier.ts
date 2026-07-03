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
  to: string;
}

export interface Notifier {
  send(jobs: StoredJob[]): Promise<void>;
  verify(): Promise<void>;
  readonly configured: boolean;
}

/** Read mailer config from environment, returning null if incomplete. */
export function mailerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  notifyToOverride?: string | null,
): MailerConfig | null {
  const user = env.GMAIL_USER?.trim();
  // Gmail shows App Passwords as 4 space-separated groups, but auth needs the
  // raw 16 chars — strip all whitespace so it works pasted either way.
  const appPassword = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  if (!user || !appPassword) return null;
  const to = (notifyToOverride?.trim() || env.NOTIFY_TO?.trim() || user);
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

/** Create a Gmail-backed notifier. */
export function createNotifier(config: MailerConfig | null): Notifier {
  if (!config) {
    return {
      configured: false,
      async send() {
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
      await getTransport().sendMail({
        from: `DassTracker <${config.user}>`,
        to: config.to,
        subject,
        text,
        html,
      });
    },
  };
}
