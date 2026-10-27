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
  /** Which cookie choice the automation clicked, if any. */
  cookieChoice?: string;
  /** When set, login lands straight on Review, as the real portal does for a
   *  candidate whose answers it already holds. */
  jumpToReview?: boolean;
  /** When set, step 1 bounces the flow to another host showing a sign-in. */
  detourHost?: string;
  /** Credentials posted to the detour host, if the guard ever failed. */
  leaked?: Record<string, string>;
  /** When set, a Privacy Agreement gate stands before Personal Information. */
  privacyGate?: boolean;
  /** Which privacy button was pressed, and the language chosen with it. */
  consent?: string;
  consentLanguage?: string;
  /** '1' when the language select fired a change event. */
  langChanged?: string;
  /** Serve the variant whose language is already the wanted one. */
  privacyAlreadyEnglish?: boolean;
  /** Server-side attachment state; one toggle per request, like the portal. */
  attachRows?: AttachRow[];
  /** How many checkbox post-backs the flow caused. */
  toggles?: number;
  /** Job number the banner claims, when it should differ from the real one. */
  bannerJob?: string;
}

interface AttachRow {
  file: string;
  relevant: boolean;
  resume: boolean;
}

/** The state the real portal was observed in: Resume ticked, Relevant not. */
function initialAttachments(): AttachRow[] {
  return [
    { file: 'Nireeksha_Huns_Resume_Dassault.pdf', relevant: false, resume: false },
    { file: 'Nireeksha_AI_Engineer.pdf', relevant: false, resume: true },
    { file: 'Nireeksha_Huns_Resume.pdf', relevant: false, resume: false },
  ];
}

/**
 * Render the attachments step from server state.
 *
 * Each checkbox posts back and the page is re-rendered, so a second click made
 * in the same pass is thrown away — which is exactly how the real portal
 * behaves, and what a batched implementation gets wrong.
 */
function attachmentsPage(job: string): string {
  const rows = (captured.attachRows ?? []).map(
    (r, i) => `<tr>
      <td><input type="checkbox" ${r.relevant ? 'checked' : ''}
            onclick="toggle(${i},'relevant')"></td>
      <td><input type="checkbox" ${r.resume ? 'checked' : ''}
            onclick="toggle(${i},'resume')"></td>
      <td><a href="#">${r.file}</a></td><td>10/12/26</td>
    </tr>`,
  );
  return `<!doctype html><html><head><title>File Attachments</title></head><body>
    <p>Applying for: Staff Cloud Platform Engineer (Job Number: ${job})</p>
    <p>*Please attach your resume to your application</p>
    <table>
      <tr><th>Relevant Files</th><th>Resume</th><th>File Name</th><th>Date</th></tr>
      ${rows.join('')}
    </table>
    <form id="tf" method="POST"
          action="/careersection/careersection/candidateacquisition/flow.jsf?step=toggle">
      <input type="hidden" name="row" id="trow"><input type="hidden" name="col" id="tcol">
    </form>
    <form id="cf" method="POST"
          action="/careersection/careersection/candidateacquisition/flow.jsf?step=review"></form>
    <a href="#" onclick="document.getElementById('cf').submit();return false;">CONTINUE</a>
    <a href="#" onclick="return false;">SAVE AS DRAFT</a>
    <script>
      function toggle(row, col) {
        document.getElementById('trow').value = row;
        document.getElementById('tcol').value = col;
        document.getElementById('tf').submit();
      }
    </script></body></html>`;
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

/**
 * The review page. When the flow filled the steps we render what it posted;
 * when the portal "remembered" the candidate we render the stored answers.
 * Either way it lists every answer as text, like the real page.
 */
function reviewPage(overrides: Record<string, string> = {}): string {
  const flagged = (captured.attachRows ?? []).filter((r) => r.relevant && r.resume);
  const resumes = flagged.length
    ? flagged.map((r) => r.file)
    : (captured.attachments?.res ?? ['Nireeksha_AI_Engineer.pdf']);
  const answers = {
    sponsorship: 'Yes',
    authorized: 'Yes',
    gender: 'Female',
    veteran: 'Not a Protected Veteran',
    race: 'Asian',
    ...overrides,
  };
  const rows = resumes.map((r) => `<tr><td>Yes</td><td>Yes</td><td>${r}</td></tr>`).join('');
  return `<!doctype html><html><head><title>Review and Submit</title></head><body>
    <p>The following information will be submitted after you click the Submit button.</p>
    <h2>Personal Information</h2>
    <p>Full Name Nireeksha Huns</p>
    <p>Will you now or in the future require sponsorship for employment visa status? ${answers.sponsorship}</p>
    <p>Are you legally authorized to work in the country for which you are applying? ${answers.authorized}</p>
    <h2>Diversity - Part 1</h2>
    <p>Gender ${answers.gender}</p>
    <p>Veterans Invitation to Self Identify ${answers.veteran}</p>
    <p>Race (Please select the ethnic group(s) that apply to you) ${answers.race}</p>
    <h2>File Attachments</h2><table>${rows}</table>
    <form method="POST" action="/careersection/careersection/candidateacquisition/flow.jsf?step=done">
      <!-- Anchors, as the real portal renders them. SAVE AS DRAFT sits right
           next to SUBMIT, so the label match has to be exact. -->
      <a href="#" onclick="document.forms[0].submit();return false;">SUBMIT</a>
      <a href="#" onclick="return false;">SAVE AS DRAFT</a>
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

      if (url.pathname === '/cookie') {
        captured.cookieChoice = url.searchParams.get('c') ?? '';
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname.includes('jobapply.ftl')) return send(page('login.html'));
      if (url.pathname.includes('application.jss')) {
        const f = parseBody(body);
        if (f.consent) {
          captured.consent = f.consent[0];
          captured.consentLanguage = f.lang?.[0] ?? '';
          captured.langChanged = f.langChanged?.[0] ?? '0';
          return send(page('step1.html'));
        }
        captured.login = { user: f.user?.[0] ?? '', pass: f.pass?.[0] ?? '' };
        // The portal gates the application behind a privacy agreement.
        if (captured.privacyAlreadyEnglish) return send(page('privacy-en.html'));
        if (captured.privacyGate) return send(page('privacy.html'));
        // A mid-application hop onto another host, showing a sign-in page.
        if (captured.detourHost) {
          res.writeHead(302, { Location: `${captured.detourHost}/elsewhere/login` });
          return res.end();
        }
        // The real portal skips straight to Review when it already holds the
        // candidate's answers from a previous application.
        return send(captured.jumpToReview ? reviewPage() : page('step1.html'));
      }
      if (url.pathname === '/elsewhere/login') {
        return send(page('login.html').replace('<title>Login', '<title>Login'));
      }
      if (url.pathname === '/elsewhere/application.jss') {
        const f = parseBody(body);
        captured.leaked = { user: f.user?.[0] ?? '', pass: f.pass?.[0] ?? '' };
        return send('<!doctype html><html><head><title>Thank You</title></head>' +
          '<body><p>Process completed</p></body></html>');
      }
      const step = url.searchParams.get('step');
      if (step === 'diversity') {
        captured.step1 = parseBody(body);
        return send(page('diversity.html'));
      }
      if (step === 'attachments') {
        captured.diversity = parseBody(body);
        captured.attachRows ??= initialAttachments();
        return send(attachmentsPage(captured.bannerJob ?? '550021'));
      }
      if (step === 'toggle') {
        const f = parseBody(body);
        const row = Number(f.row?.[0] ?? -1);
        const col = (f.col?.[0] ?? '') as 'relevant' | 'resume';
        const rows = captured.attachRows ?? initialAttachments();
        if (rows[row] && (col === 'relevant' || col === 'resume')) {
          rows[row] = { ...rows[row], [col]: !rows[row][col] };
        }
        captured.attachRows = rows;
        captured.toggles = (captured.toggles ?? 0) + 1;
        return send(attachmentsPage(captured.bannerJob ?? '550021'));
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
    description: 'Build and ship machine learning models for the 3DEXPERIENCE platform.',
    postedAt: '2026-10-11T00:00:00.000Z',
  };
}

/** The resume an AI-classified job would carry. */
const RESUME = loadApplicationProfile().resumes.ai;

describe('applicator against a Taleo replica', () => {
  it('fills every step and reaches the Thank You page', async () => {
    captured = { submitted: false, hits: [] };
    const result = await createApplicator(config()).apply(job(), RESUME);

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

  it('leaves exactly one document flagged, and it is the wanted one', () => {
    // The table starts with Resume already ticked on the wanted row and
    // Relevant not — the state the live portal was actually observed in.
    const rows = captured.attachRows ?? [];
    expect(rows.find((r) => r.file === 'Nireeksha_AI_Engineer.pdf')).toEqual({
      file: 'Nireeksha_AI_Engineer.pdf',
      relevant: true,
      resume: true,
    });
    expect(rows.filter((r) => r.relevant || r.resume)).toHaveLength(1);
  });

  it('stops on the review page in dry-run mode without submitting', async () => {
    captured = { submitted: false, hits: [] };
    const result = await createApplicator(config({ dryRun: true })).apply(job(), RESUME);

    expect(result.outcome).toBe('dry_run');
    expect(captured.submitted).toBe(false);
    expect(result.screenshots.length).toBeGreaterThan(0);
  }, 90_000);

  it('refuses to submit when the wanted resume is not on the account', async () => {
    captured = { submitted: false, hits: [] };
    const result = await createApplicator(config()).apply(job(), 'Does_Not_Exist.pdf');

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/not on the account/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);

  it('reports uncertainty, not failure, when Submit lands but the confirmation does not', async () => {
    captured = { submitted: false, hits: [], swallowConfirmation: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

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
    const result = await createApplicator(config({ loginHost: '127.0.0.1' })).apply(evil, RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/host is not/i);
    // Nothing was even requested — the URL is vetted before the browser opens it.
    expect(captured.hits).toEqual([]);
    expect(captured.login).toBeUndefined();
  }, 90_000);

  it('refuses to submit when an answer cannot be set', async () => {
    captured = { submitted: false, hits: [] };
    const profile = { ...loadApplicationProfile(), gender: 'Unlisted Option' };
    const result = await createApplicator(config({ profile })).apply(job(), RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/gender/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);
});

describe('the portal remembering a candidate', () => {
  it('submits from a pre-filled Review page reached straight after login', async () => {
    captured = { submitted: false, hits: [], jumpToReview: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

    // No Continue was ever pressed: login landed on Review already filled in.
    expect(result.outcome).toBe('submitted');
    expect(captured.submitted).toBe(true);
    expect(captured.step1).toBeUndefined();
    expect(captured.diversity).toBeUndefined();
  }, 90_000);

  it('refuses a pre-filled Review that disagrees with the profile', async () => {
    captured = { submitted: false, hits: [], jumpToReview: true };
    // The remembered answers are not ours: the page says Female, we say Male.
    const result = await createApplicator(
      config({ profile: { ...loadApplicationProfile(), gender: 'Male' } }),
    ).apply(job(), RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/review does not match the profile/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);

  it('refuses a pre-filled Review carrying the wrong resume', async () => {
    captured = { submitted: false, hits: [], jumpToReview: true };
    const result = await createApplicator(config()).apply(job(), 'Nireeksha_Huns_Resume.pdf');

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/does not list the resume/i);
    expect(captured.submitted).toBe(false);
  }, 90_000);
});

describe('the cookie dialog', () => {
  it('is dismissed with the private option, never Accept All', async () => {
    captured = { submitted: false, hits: [] };
    await createApplicator(config()).apply(job(), RESUME);

    expect(captured.cookieChoice).toBe('necessary');
    expect(captured.cookieChoice).not.toBe('all');
  }, 90_000);
});

describe('a flow that wanders off the portal', () => {
  it('stops rather than entering credentials on another host', async () => {
    // Same server, reached by a different hostname: everything else about the
    // page is a convincing sign-in form.
    const port = new URL(base).port;
    captured = { submitted: false, hits: [], detourHost: `http://localhost:${port}` };

    const result = await createApplicator(config({ loginHost: '127.0.0.1' })).apply(job(), RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/left 127\.0\.0\.1 mid-application|refusing to enter/i);
    // The decisive assertion: the real password was never posted off-host.
    expect(captured.leaked).toBeUndefined();
    expect(captured.submitted).toBe(false);
  }, 90_000);
});

describe('the privacy agreement gate', () => {
  it('accepts it and carries on into the application', async () => {
    captured = { submitted: false, hits: [], privacyGate: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(captured.consent).toBe('accept');
    expect(captured.consentLanguage).toBe('en'); // "English"
    expect(result.outcome).toBe('submitted');
    expect(captured.submitted).toBe(true);
  }, 90_000);

  it('stops without clicking anything when the profile does not accept it', async () => {
    captured = { submitted: false, hits: [], privacyGate: true };
    const profile = { ...loadApplicationProfile(), acceptPrivacyAgreement: false };
    const result = await createApplicator(config({ profile })).apply(job(), RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/privacy agreement/i);
    // Neither accepted nor declined on the candidate's behalf.
    expect(captured.consent).toBeUndefined();
    expect(captured.submitted).toBe(false);
  }, 90_000);
});

describe('controls rendered as links rather than buttons', () => {
  it('finds and clicks them, and never the one sitting next to it', async () => {
    // The privacy page's I ACCEPT / I DECLINE and the review page's
    // SUBMIT / SAVE AS DRAFT are all anchors in this replica, as on the
    // real portal. getByRole('button') matches none of them.
    captured = { submitted: false, hits: [], privacyGate: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(captured.consent).toBe('accept');
    expect(result.outcome).toBe('submitted');
    expect(captured.submitted).toBe(true);
  }, 90_000);

  it('reports what the page does offer when a control is missing', async () => {
    captured = { submitted: false, hits: [], privacyGate: true };
    const profile = { ...loadApplicationProfile(), privacyLanguage: 'Klingon' };
    // The language is not fatal; the run should still get through.
    const result = await createApplicator(config({ profile })).apply(job(), RESUME);
    expect(result.outcome).toBe('submitted');
  }, 90_000);
});

describe('a step whose answer is already correct', () => {
  it('leaves the language select alone rather than firing a post-back', async () => {
    // On the real portal the privacy page already shows English, and changing
    // it makes Taleo re-render the step — discarding the I ACCEPT click.
    captured = { submitted: false, hits: [], privacyAlreadyEnglish: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(captured.langChanged).toBe('0');
    expect(captured.consent).toBe('accept');
    expect(result.outcome).toBe('submitted');
  }, 90_000);

  it('still changes it when it is on the wrong language', async () => {
    captured = { submitted: false, hits: [], privacyGate: true };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(captured.consentLanguage).toBe('en');
    expect(result.outcome).toBe('submitted');
  }, 90_000);
});

describe('the attachments table posting back on every click', () => {
  it('reaches the wanted end state one toggle at a time', async () => {
    captured = { submitted: false, hits: [], attachRows: initialAttachments() };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(result.outcome).toBe('submitted');
    // Resume was already ticked on the wanted row, so only Relevant needed a
    // click. A batched implementation would have lost it to the re-render.
    const rows = captured.attachRows ?? [];
    const chosen = rows.find((r) => r.file === 'Nireeksha_AI_Engineer.pdf');
    expect(chosen).toEqual({
      file: 'Nireeksha_AI_Engineer.pdf',
      relevant: true,
      resume: true,
    });
    expect(rows.filter((r) => r.relevant || r.resume)).toHaveLength(1);
    expect(captured.toggles).toBe(1);
  }, 120_000);

  it('clears a different document that was left flagged', async () => {
    captured = {
      submitted: false,
      hits: [],
      attachRows: [
        { file: 'Nireeksha_Huns_Resume_Dassault.pdf', relevant: true, resume: true },
        { file: 'Nireeksha_AI_Engineer.pdf', relevant: false, resume: false },
        { file: 'Nireeksha_Huns_Resume.pdf', relevant: false, resume: false },
      ],
    };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(result.outcome).toBe('submitted');
    const rows = captured.attachRows ?? [];
    expect(rows.find((r) => r.file === 'Nireeksha_AI_Engineer.pdf')).toEqual({
      file: 'Nireeksha_AI_Engineer.pdf',
      relevant: true,
      resume: true,
    });
    expect(rows.filter((r) => r.relevant || r.resume)).toHaveLength(1);
    expect(captured.toggles).toBe(4); // two to clear, two to set
  }, 120_000);
});

describe('the requisition guard', () => {
  it('stops when the portal says the application is for another job', async () => {
    // The portal resumes saved drafts, so the banner is the only confirmation
    // that this application belongs to the job we picked.
    captured = {
      submitted: false,
      hits: [],
      attachRows: initialAttachments(),
      bannerJob: '999999',
    };
    const result = await createApplicator(config()).apply(job(), RESUME);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/for job 999999, not 550021/);
    expect(captured.submitted).toBe(false);
  }, 120_000);
});
