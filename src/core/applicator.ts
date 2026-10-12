/**
 * Drives the 3DS careers portal (Oracle Taleo) to submit one application.
 *
 * Taleo is a stateful JSF app whose field ids are generated per requisition,
 * so nothing here keys off an id. Every answer is located by the question text
 * the candidate actually reads, which survives a requisition change. Each step
 * is screenshotted, so a failure can be diagnosed from the artifact rather
 * than from a stack trace.
 *
 * The flow is: sign in -> personal information -> diversity -> file
 * attachments -> review -> submit -> Thank You. Nothing is submitted unless
 * the review page is reached intact, and success is only claimed once the
 * Thank You page is confirmed.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ApplicationProfile } from './profile.js';
import type { Job } from './types.js';

const DEFAULT_LOGIN_HOST = 'talentacquisition.3ds.com';
/** Taleo pages post back on every Continue; give each one room to settle. */
const STEP_TIMEOUT_MS = 45_000;

export interface ApplicatorConfig {
  username: string;
  password: string;
  profile: ApplicationProfile;
  /** When true, stop on the review page instead of pressing Submit. */
  dryRun: boolean;
  headless: boolean;
  screenshotDir: string;
  /** Host the apply URL must land on. Overridable only to test the flow. */
  loginHost: string;
}

/**
 * `uncertain` means the Submit click went out but the confirmation never
 * arrived. It is deliberately NOT `failed`: the application may well have
 * landed, so it must never be retried automatically.
 */
export type ApplyOutcome = 'submitted' | 'dry_run' | 'failed' | 'uncertain';

export interface ApplyResult {
  outcome: ApplyOutcome;
  reason: string | null;
  screenshots: string[];
}

/**
 * Whether a URL points at the expected portal, compared on the parsed
 * hostnamerather than by substring.
 *
 * This guards a credential-exfiltration path: `applyUrl` comes from the 3DS
 * search API, which is external data we do not control. A substring check
 * would accept `talentacquisition.3ds.com.evil.test`, and the next thing the
 * flow does is type the real username and password into whatever loaded.
 */
export function isExpectedHost(url: string, expectedHost: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === expectedHost.trim().toLowerCase();
  } catch {
    return false;
  }
}

/** The portal's confirmation page, in the two wordings it uses. */
export function isThankYouPage(text: string): boolean {
  return /thank you/i.test(text) && /process completed|view my submissions/i.test(text);
}

/**
 * Pick the attachment row holding the resume. Matching is exact on the file
 * name: the account carries several near-identical resumes, and a fuzzy match
 * could silently attach the wrong one.
 */
export function findResumeRow(fileNames: string[], wanted: string): number {
  return fileNames.findIndex((name) => name.trim() === wanted.trim());
}

/** Read credentials and switches from the environment. Null when unset. */
export function applicatorConfigFromEnv(
  env: NodeJS.ProcessEnv,
  profile: ApplicationProfile,
): ApplicatorConfig | null {
  const username = env.TALEO_USERNAME?.trim();
  const password = env.TALEO_PASSWORD?.trim();
  if (!username || !password) return null;
  return {
    username,
    password,
    profile,
    dryRun: env.AUTO_APPLY_DRY_RUN === '1' || env.AUTO_APPLY_DRY_RUN === 'true',
    headless: env.AUTO_APPLY_HEADFUL !== '1',
    screenshotDir: env.AUTO_APPLY_SCREENSHOT_DIR?.trim() || resolve(process.cwd(), 'data/apply'),
    loginHost: env.TALEO_LOGIN_HOST?.trim() || DEFAULT_LOGIN_HOST,
  };
}

/** True only when the operator has explicitly armed unattended submission. */
export function autoApplyEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.AUTO_APPLY_ENABLED === '1' || env.AUTO_APPLY_ENABLED === 'true';
}

export function maxApplicationsPerScan(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.AUTO_APPLY_MAX_PER_SCAN);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

// --- In-page helpers -------------------------------------------------------
//
// Locating "the control belonging to this question" is a DOM-walking problem:
// Taleo does not reliably tie a <label> to its input, so we find the question
// text and take the controls that follow it. The walk runs inside the page,
// in one self-contained function, because the browser is where the DOM is.

type AnswerKind = 'radio' | 'checkbox' | 'select';

interface AnswerRequest {
  question: string;
  kind: AnswerKind;
  /** Visible label of the option to pick. */
  option: string;
  /** For checkboxes: the state to leave it in. Ignored otherwise. */
  checked?: boolean;
}

/**
 * Set one answer on the current step. Returns false when the question or the
 * option is not on the page, which every caller treats as a hard stop rather
 * than submitting a half-filled form.
 */
async function answerQuestion(page: Page, request: AnswerRequest): Promise<boolean> {
  return page.evaluate((req: AnswerRequest) => {
    const norm = (s: string | null): string => (s || '').replace(/\s+/g, ' ').trim();

    /** The smallest element whose text contains the question. */
    const questionNode = (pattern: string): Element | null => {
      const re = new RegExp(pattern, 'i');
      const hits = Array.from(
        document.querySelectorAll('label,legend,td,th,div,span,p,h1,h2,h3'),
      ).filter((el) => re.test(norm(el.textContent)));
      if (hits.length === 0) return null;
      return hits.reduce((a, b) =>
        norm(a.textContent).length <= norm(b.textContent).length ? a : b,
      );
    };

    /** Controls appearing after the question, up to the next form button. */
    const controlsAfter = (node: Element, selector: string): HTMLElement[] => {
      const out: HTMLElement[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let seen = false;
      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        if (el === node) {
          seen = true;
          continue;
        }
        if (!seen) continue;
        if (el.matches(selector)) out.push(el);
        if (out.length > 0 && el.matches('input[type=submit],button')) break;
      }
      return out;
    };

    /** The visible text labelling one input. */
    const labelFor = (input: HTMLElement): string => {
      if (input.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (lab) return norm(lab.textContent);
      }
      const wrapping = input.closest('label');
      if (wrapping) return norm(wrapping.textContent);
      const next = input.nextElementSibling;
      if (next) return norm(next.textContent);
      return norm(input.parentElement ? input.parentElement.textContent : '');
    };

    const node = questionNode(req.question);
    if (!node) return false;

    if (req.kind === 'select') {
      const select = controlsAfter(node, 'select')[0] as HTMLSelectElement | undefined;
      if (!select) return false;
      const want = req.option.toLowerCase();
      const match = Array.from(select.options).find(
        (o) => norm(o.textContent).toLowerCase() === want,
      );
      if (!match) return false;
      select.value = match.value;
      // Taleo re-renders dependent fields on change, so the event matters.
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const inputs = controlsAfter(node, `input[type=${req.kind}]`) as HTMLInputElement[];
    const want = req.option.toLowerCase();
    const exact = inputs.find((i) => labelFor(i).toLowerCase() === want);
    const loose = inputs.find((i) => labelFor(i).toLowerCase().includes(want));
    const hit = exact ?? loose;
    if (!hit) return false;

    if (req.kind === 'radio') {
      hit.click();
      return hit.checked;
    }
    const target = req.checked !== false;
    if (hit.checked !== target) hit.click();
    return hit.checked === target;
  }, request);
}

const chooseRadio = (page: Page, question: string, option: string): Promise<boolean> =>
  answerQuestion(page, { question, kind: 'radio', option });

const chooseSelect = (page: Page, question: string, option: string): Promise<boolean> =>
  answerQuestion(page, { question, kind: 'select', option });

const setCheckbox = (
  page: Page,
  question: string,
  option: string,
  checked: boolean,
): Promise<boolean> => answerQuestion(page, { question, kind: 'checkbox', option, checked });

/** Read the file names listed on the File Attachments step, in row order. */
async function attachmentNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('table tr'))
      .map((tr) => {
        const link = tr.querySelector('a');
        return link ? (link.textContent || '').trim() : '';
      })
      .filter((name) => /\.(pdf|docx?|txt|rtf)$/i.test(name)),
  );
}

/** Tick the Relevant and Resume boxes on the row holding the given file. */
async function selectResumeRow(page: Page, fileName: string): Promise<boolean> {
  return page.evaluate((wanted) => {
    const rows = Array.from(document.querySelectorAll('table tr'));
    const row = rows.find((tr) => {
      const link = tr.querySelector('a');
      return link && (link.textContent || '').trim() === wanted;
    });
    if (!row) return false;
    const boxes = Array.from(row.querySelectorAll('input[type=checkbox]'));
    if (boxes.length === 0) return false;
    for (const box of boxes as HTMLInputElement[]) {
      if (!box.checked) box.click();
    }
    // Clear the same two columns on every other row, so only this file is
    // flagged as the resume even if a previous session left one ticked.
    for (const other of rows) {
      if (other === row) continue;
      const link = other.querySelector('a');
      if (!link) continue;
      for (const box of Array.from(
        other.querySelectorAll('input[type=checkbox]'),
      ) as HTMLInputElement[]) {
        if (box.checked) box.click();
      }
    }
    return (boxes as HTMLInputElement[]).every((b) => b.checked);
  }, fileName);
}

/** Click the step's forward button and wait for the post-back to land. */
async function clickAndSettle(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name }).first().click({ timeout: STEP_TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
}

export interface Applicator {
  configured: boolean;
  apply(job: Job): Promise<ApplyResult>;
}

/** Build an applicator. A null config yields a disabled, no-op applicator. */
export function createApplicator(
  config: ApplicatorConfig | null,
  log: (msg: string) => void = () => {},
  launch?: () => Promise<Browser>,
): Applicator {
  if (!config) {
    return {
      configured: false,
      async apply() {
        return {
          outcome: 'failed',
          reason: 'auto-apply is not configured (set TALEO_USERNAME / TALEO_PASSWORD)',
          screenshots: [],
        };
      },
    };
  }

  const open = launch ?? (async () => (await import('playwright')).chromium.launch({ headless: config.headless }));

  async function apply(job: Job): Promise<ApplyResult> {
    mkdirSync(config!.screenshotDir, { recursive: true });
    const shots: string[] = [];
    const browser = await open();
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    const shoot = async (label: string): Promise<void> => {
      const path = resolve(config!.screenshotDir, `${job.cardId}-${label}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      shots.push(path);
    };

    /** A failure before anything was submitted; safe to retry later. */
    const fail = async (reason: string): Promise<ApplyResult> => {
      await shoot('failure');
      log(`[apply ${job.cardId}] ${reason}`);
      return { outcome: 'failed', reason, screenshots: shots };
    };

    /** A failure after Submit was clicked; must never be retried. */
    const uncertain = async (reason: string): Promise<ApplyResult> => {
      await shoot('uncertain');
      log(`[apply ${job.cardId}] NEEDS A HUMAN: ${reason}`);
      return { outcome: 'uncertain', reason, screenshots: shots };
    };

    try {
      if (!job.applyUrl) return await fail('job has no apply URL');

      // --- Sign in ---
      // Vet the URL before the browser ever opens it: the credentials are
      // typed into whatever this loads, so an unexpected host is a hard stop,
      // not something to notice afterwards.
      if (!isExpectedHost(job.applyUrl, config!.loginHost)) {
        return await fail(
          `apply URL host is not ${config!.loginHost}, refusing to sign in: ${job.applyUrl}`,
        );
      }
      await page.goto(job.applyUrl, { waitUntil: 'domcontentloaded' });
      if (!isExpectedHost(page.url(), config!.loginHost)) {
        return await fail(
          `apply URL redirected off ${config!.loginHost}, refusing to sign in: ${page.url()}`,
        );
      }
      const user = page.getByPlaceholder(/user name/i).first();
      if (await user.count()) {
        await user.fill(config!.username);
        await page.getByPlaceholder(/password/i).first().fill(config!.password);
        await clickAndSettle(page, /log ?in|sign ?in/i);
      }
      await shoot('01-after-login');

      const body = (await page.textContent('body')) ?? '';
      if (/captcha|are you a robot|unusual activity/i.test(body)) {
        // Working around a bot check is not something this tool does.
        return await fail('the portal presented a CAPTCHA or bot check; finish this one by hand');
      }
      if (/invalid|incorrect.*(password|user)/i.test(body) && /sign in/i.test(body)) {
        return await fail('sign-in was rejected — check TALEO_USERNAME / TALEO_PASSWORD');
      }

      // --- Personal information ---
      const p = config!.profile;
      if (!(await chooseSelect(page, 'How did you hear about us', p.hearAboutUs))) {
        return await fail(`could not set "How did you hear about us" to ${p.hearAboutUs}`);
      }
      await page.waitForTimeout(1_000); // the Source select is rendered by the first choice
      await chooseSelect(page, 'Source', p.source);

      if (!(await chooseRadio(page, 'require sponsorship for employment visa', p.requiresSponsorship))) {
        return await fail('could not answer the visa sponsorship question');
      }
      if (!(await chooseRadio(page, 'legally authorized to work', p.legallyAuthorized))) {
        return await fail('could not answer the work authorization question');
      }
      await setCheckbox(page, 'Job Posting Notification', 'notification', p.jobPostingNotification);
      await shoot('02-personal-information');
      await clickAndSettle(page, /continue/i);

      // --- Diversity ---
      if (!(await chooseRadio(page, 'Gender', p.gender))) {
        return await fail(`could not set Gender to ${p.gender}`);
      }
      if (!(await chooseRadio(page, 'Veterans Invitation to Self Identify', p.veteranStatus))) {
        return await fail(`could not set veteran status to ${p.veteranStatus}`);
      }
      for (const race of p.race) {
        if (!(await setCheckbox(page, 'Race', race, true))) {
          return await fail(`could not tick race "${race}"`);
        }
      }
      await shoot('03-diversity');
      await clickAndSettle(page, /continue/i);

      // --- File attachments ---
      const names = await attachmentNames(page);
      if (findResumeRow(names, p.resumeFileName) === -1) {
        return await fail(
          `resume "${p.resumeFileName}" is not on the account; found: ${names.join(', ') || 'none'}`,
        );
      }
      if (!(await selectResumeRow(page, p.resumeFileName))) {
        return await fail(`could not tick the Relevant/Resume boxes for ${p.resumeFileName}`);
      }
      await shoot('04-attachments');
      await clickAndSettle(page, /continue/i);

      // --- Review ---
      await shoot('05-review');
      const review = (await page.textContent('body')) ?? '';
      const submit = page.getByRole('button', { name: /^submit$/i }).first();
      if (!(await submit.count())) {
        return await fail('reached the end of the flow without a Submit button');
      }
      // Guard against submitting a review page that lost the resume selection.
      if (!review.includes(p.resumeFileName)) {
        return await fail('the review page does not list the chosen resume; not submitting');
      }

      if (config!.dryRun) {
        log(`[apply ${job.cardId}] dry run: stopped on the review page without submitting.`);
        return {
          outcome: 'dry_run',
          reason: 'stopped on the review page (AUTO_APPLY_DRY_RUN)',
          screenshots: shots,
        };
      }

      // Past this line the application may already exist on the portal, so no
      // error below may report `failed` — that status is what makes a job
      // eligible to be applied to again.
      let submittedAt: number;
      try {
        submittedAt = Date.now();
        await clickAndSettle(page, /^submit$/i);
      } catch (err) {
        return await uncertain(
          `Submit was clicked but the page never settled (${
            err instanceof Error ? err.message : String(err)
          }) — check the portal before applying again`,
        );
      }
      await shoot('06-result');
      const done = (await page.textContent('body').catch(() => '')) ?? '';
      if (!isThankYouPage(done)) {
        return await uncertain(
          `Submit was clicked ${Date.now() - submittedAt}ms ago but no Thank You page ` +
            'appeared — check the portal before applying again',
        );
      }

      log(`[apply ${job.cardId}] submitted: ${job.title.trim()}`);
      return { outcome: 'submitted', reason: null, screenshots: shots };
    } catch (err) {
      return await fail(err instanceof Error ? err.message : String(err));
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  return { configured: true, apply };
}
