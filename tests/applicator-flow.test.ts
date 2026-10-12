/**
 * Drives the real applicator against a local replica of the Taleo markup.
 *
 * The replica reproduces what makes the live portal awkward: labels tied to
 * inputs only by `for`, questions that are plain text rather than <label>, a
 * dependent Source select, and an attachments table that starts with the WRONG
 * resume ticked. If the DOM walking is wrong, these tests fail.
 *
 * Nothing here touches 3ds.com; the server is local and the credentials are
 * fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApplicator, type ApplicatorConfig } from '../src/core/applicator.js';
import { loadApplicationProfile } from '../src/core/profile.js';
import type { Job } from '../src/core/types.js';

const FIXTURES = resolve(__dirname, 'fixtures/taleo');
const page = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/** What the replica recorded from each posted step. */
interface Captured {
  login?: Record<string, string>;
  step1?: Record<string, string[]>;
  diversity?: Record<string, string[]>;
  attachments?: Record<string, string[]>;
  submitted: boolean;
  /** When set, the page after Submit is not the confirmation. */
  swallowConfirmation?: boolean;
  /** Every path the replica was asked for. */
  hits: string[];
}

let server: Server;
let base: string;
let captured: Captured;
let shotDir: string;

function parseBody(body: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of new URLSearchParams(body)) (out[k] ??= []).push(v);
  return out;
}

/** The review page, rendered from what the flow actually submitted. */
function reviewPage(): string {
  const resumes = captured.attachments?.res ?? [];
  const rows = resumes.map((r) => `<tr><td>Yes</td><td>Yes</td><td>${r}</td></tr>`).join('');
  return `<!doctype html><html><head><title>Review and Submit</title></head><body>
    <h2>Review and Submit</h2>
    <p>How did you hear about us? ${captured.step1?.hear ?? ''}</p>
    <p>Source ${captured.step1?.source ?? ''}</p>
    <h3>File Attachments</h3><table>${rows}</table>
    <form method="POST" action="/careersection/careersection/candidateacquisition/flow.jsf?step=done">
      <button type="submit">SUBMIT</button>
      <button type="button">SAVE AS DRAFT</button>
    </form></body></html>`;
}

const THANK_YOU = `<!doctype html><html><head><title>Thank You</title></head><body>
  <p>Process completed</p><h2>Thank You</h2>
  <p>Thank you for your interest in joining Dassault Syst&egrave;mes!</p>
  <a href="#">View My Submissions</a></body></html>`;

beforeAll(async () => {
  shotDir = mkdtempSync(join(tmpdir(), 'dasstracker-shots-'));
  captured = { submitted: false, hits: [] };

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base);
      captured.hits.push(url.pathname);
      const send = (html: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      };

      if (url.pathname.includes('jobapply.ftl')) return send(page('login.html'));
      if (url.pathname.includes('application.jss')) {
        const f = parseBody(body);
        captured.login = { user: f.user?.[0] ?? '', pass: f.pass?.[0] ?? '' };
        return send(page('step1.html'));
      }
      const step = url.searchParams.get('step');
      if (step === 'diversity') {
        captured.step1 = parseBody(body);
        return send(page('diversity.html'));
      }
      if (step === 'attachments') {
        captured.diversity = parseBody(body);
        return send(page('attachments.html'));
      }
      if (step === 'review') {
        captured.attachments = parseBody(body);
        return send(reviewPage());
      }
      if (step === 'done') {
        captured.submitted = true;
        // Reproduce the portal accepting a submission but not showing the
        // confirmation — a timeout, a redirect loop, an interstitial.
        return send(
          captured.swallowConfirmation
            ? '<!doctype html><html><head><title>...</title></head><body><p>Please wait</p></body></html>'
            : THANK_YOU,
        );
      }
      res.writeHead(404);
      res.end('nope');
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(shotDir, { recursive: true, force: true });
});

function config(over: Partial<ApplicatorConfig> = {}): ApplicatorConfig {
  return {
    username: 'test-user',
    password: 'test-password',
    profile: loadApplicationProfile(),
    dryRun: false,
    headless: true,
    screenshotDir: shotDir,
    loginHost: '127.0.0.1',
    ...over,
  };
}

function job(): Job {
  return {
    cardId: '550021',
    title: 'AI Engineer',
    url: `${base}/careers/jobs/ai-engineer-550021`,
    applyUrl: `${base}/careersection/qa/jobapply.ftl?job=550021&lang=en`,
    location: 'US, MA, Waltham',
    category: 'Research & Development',
    products: '',
    experience: '0 to 3 years',
    postedAt: '2026-10-11T00:00:00.000Z',
  };
}

describe('applicator against a Taleo replica', () => {
  it('fills every step and reaches the Thank You page', async () => {
    captured = { submitted: false, hits: [] };
    const result = await createApplicator(config()).apply(job());

    expect(result.reason).toBeNull();
    expect(result.outcome).toBe('submitted');
    expect(captured.submitted).toBe(true);
  }, 90_000);

  it('signs in with the configured credentials', () => {
    expect(captured.login).toEqual({ user: 'test-user', pass: 'test-password' });
  });

  it('answers the personal information step as the profile specifies', () => {
    expect(captured.step1?.hear).toEqual(['cw']); // Corporate Websites
    expect(captured.step1?.source).toEqual(['dscs']); // Dassault Systemes Corporate Site
    expect(captured.step1?.spon).toEqual(['y']); // sponsorship: Yes
    expect(captured.step1?.auth).toEqual(['y']); // authorized: Yes
    // The fixture ships this box checked; the profile says leave it off.
    expect(captured.step1?.notify).toBeUndefined();
  });

  it('answers diversity as the profile specifies', () => {
    expect(captured.diversity?.g).toEqual(['on']); // Female is the first radio
    expect(captured.diversity?.v).toEqual(['on']); // Not a Protected Veteran
    expect(captured.diversity?.r).toEqual(['on']); // Asian, and only Asian
  });

  it('ticks only the wanted resume, clearing the one left checked', () => {
    // The fixture starts with Nireeksha_Huns_Resume.pdf ticked in both columns.
    expect(captured.attachments?.rel).toEqual(['Nireeksha_AI_Engineer.pdf']);
    expect(captured.attachments?.res).toEqual(['Nireeksha_AI_Engineer.pdf']);
  });

  it('stops on the review page in dry-run mode without submitting', async () => {
    captured = { submitted: false, hits: [] };
    const result = await createApplicator(config({ dryRun: true })).apply(job());

    expect(result.outcome).toBe('dry_run');
    expect(captured.submitted).toBe(false);
    expect(result.screenshots.length).toBeGreaterThan(0);
  }, 90_000);

  it('refuses to submit when the wanted resume is not on the account', async () => {
    captured = { submitted: false, hits: [] };
    const profile = { ...loadApplicationProfile(), resumeFileName: 'Does_Not_Exist.pdf' };
    const result = await createApplicator(config({ profile })).apply(job());

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/not on the account/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);

  it('reports uncertainty, not failure, when Submit lands but the confirmation does not', async () => {
    captured = { submitted: false, hits: [], swallowConfirmation: true };
    const result = await createApplicator(config()).apply(job());

    // The portal did receive the submission, so this must never be reported as
    // a plain failure: that is the status that makes a job eligible to retry.
    expect(captured.submitted).toBe(true);
    expect(result.outcome).toBe('uncertain');
    expect(result.reason).toMatch(/no Thank You page|never settled/i);
  }, 90_000);

  it('refuses to sign in when the apply URL points somewhere unexpected', async () => {
    captured = { submitted: false, hits: [] };
    const evil = {
      ...job(),
      applyUrl: `http://localhost:${new URL(base).port}/careersection/qa/jobapply.ftl?job=1`,
    };
    // Same server, different hostname: the credentials must not be typed.
    const result = await createApplicator(config({ loginHost: '127.0.0.1' })).apply(evil);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/host is not/i);
    // Nothing was even requested — the URL is vetted before the browser opens it.
    expect(captured.hits).toEqual([]);
    expect(captured.login).toBeUndefined();
  }, 90_000);

  it('refuses to submit when an answer cannot be set', async () => {
    captured = { submitted: false, hits: [] };
    const profile = { ...loadApplicationProfile(), gender: 'Unlisted Option' };
    const result = await createApplicator(config({ profile })).apply(job());

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/gender/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);
});
