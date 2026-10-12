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
import { identifyStep, reviewProblems, type FlowStep } from './review.js';
import type { Job } from './types.js';

const DEFAULT_LOGIN_HOST = 'talentacquisition.3ds.com';
/** Taleo pages post back on every Continue; give each one room to settle. */
const STEP_TIMEOUT_MS = 45_000;
/** Hard bound on the flow, so an unexpected loop cannot run forever. */
const MAX_STEPS = 12;

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
  /** The review page's text, captured on a dry run so it can be inspected. */
  reviewText?: string;
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
// Each of these is a STRING, not a function. tsx/esbuild rewrites named arrow
// functions to reference a `__name` helper that does not exist in the browser,
// so a transpiled callback passed to page.evaluate dies with
// "ReferenceError: __name is not defined". Keeping the source as a string
// means nothing transpiles it, and the same code runs under tsx and tsc.
//
// They use String.raw because a plain template literal eats backslashes: `\s+`
// would reach the browser as `s+`, quietly turning every whitespace regex into
// one that matches the letter s. String.raw keeps the source verbatim.

/** Set one answer, located by the question text the candidate reads. */
const FN_ANSWER = String.raw`(req) => {
  const norm = function (s) { return (s || '').replace(/\s+/g, ' ').trim(); };

  const questionNode = function (pattern) {
    const re = new RegExp(pattern, 'i');
    const hits = Array.prototype.slice
      .call(document.querySelectorAll('label,legend,td,th,div,span,p,h1,h2,h3'))
      .filter(function (el) { return re.test(norm(el.textContent)); });
    if (hits.length === 0) return null;
    return hits.reduce(function (a, b) {
      return norm(a.textContent).length <= norm(b.textContent).length ? a : b;
    });
  };

  const controlsAfter = function (node, selector) {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let seen = false;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el === node) { seen = true; continue; }
      if (!seen) continue;
      if (el.matches(selector)) out.push(el);
      if (out.length > 0 && el.matches('input[type=submit],button')) break;
    }
    return out;
  };

  const labelFor = function (input) {
    if (input.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
      if (lab) return norm(lab.textContent);
    }
    const wrapping = input.closest('label');
    if (wrapping) return norm(wrapping.textContent);
    if (input.nextElementSibling) return norm(input.nextElementSibling.textContent);
    return norm(input.parentElement ? input.parentElement.textContent : '');
  };

  const node = questionNode(req.question);
  if (!node) return false;

  if (req.kind === 'select') {
    const select = controlsAfter(node, 'select')[0];
    if (!select) return false;
    const want = req.option.toLowerCase();
    const match = Array.prototype.slice.call(select.options).find(function (o) {
      return norm(o.textContent).toLowerCase() === want;
    });
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  const inputs = controlsAfter(node, 'input[type=' + req.kind + ']');
  const want = req.option.toLowerCase();
  const exact = inputs.find(function (i) { return labelFor(i).toLowerCase() === want; });
  const loose = inputs.find(function (i) { return labelFor(i).toLowerCase().indexOf(want) !== -1; });
  const hit = exact || loose;
  if (!hit) return false;

  if (req.kind === 'radio') { hit.click(); return hit.checked; }
  const target = req.checked !== false;
  if (hit.checked !== target) hit.click();
  return hit.checked === target;
}`;

/** File names listed on the File Attachments step, in row order. */
const FN_ATTACHMENT_NAMES = String.raw`() => {
  return Array.prototype.slice.call(document.querySelectorAll('table tr'))
    .map(function (tr) {
      const link = tr.querySelector('a');
      return link ? (link.textContent || '').trim() : '';
    })
    .filter(function (name) { return /\.(pdf|docx?|txt|rtf)$/i.test(name); });
}`;

/** Tick Relevant+Resume on the wanted row, clearing every other row. */
const FN_SELECT_RESUME = String.raw`(wanted) => {
  const rows = Array.prototype.slice.call(document.querySelectorAll('table tr'));
  const row = rows.find(function (tr) {
    const link = tr.querySelector('a');
    return link && (link.textContent || '').trim() === wanted;
  });
  if (!row) return false;
  const boxes = Array.prototype.slice.call(row.querySelectorAll('input[type=checkbox]'));
  if (boxes.length === 0) return false;
  boxes.forEach(function (b) { if (!b.checked) b.click(); });
  rows.forEach(function (other) {
    if (other === row || !other.querySelector('a')) return;
    Array.prototype.slice.call(other.querySelectorAll('input[type=checkbox]'))
      .forEach(function (b) { if (b.checked) b.click(); });
  });
  return boxes.every(function (b) { return b.checked; });
}`;

/**
 * Dismiss the cookie dialog, declining anything non-essential.
 *
 * The banner overlays the form and swallows clicks, so it has to go before any
 * step can be filled. Of the choices offered we take the most private one and
 * never "Accept All".
 */
const FN_DISMISS_COOKIES = String.raw`() => {
  const wanted = [
    /continue with only necessary cookies/i,
    /only necessary/i,
    /reject all/i,
    /decline/i,
  ];
  // A consent banner is usually position:fixed, and a fixed element's
  // offsetParent is null — so visibility must be judged by its box, not by
  // offsetParent, or the one element we are looking for is filtered out.
  const visible = function (el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  };
  const clickable = Array.prototype.slice.call(
    document.querySelectorAll('a,button,input[type=button],input[type=submit],[role=button]')
  );
  for (let i = 0; i < wanted.length; i++) {
    const hit = clickable.find(function (el) {
      const label = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
      return wanted[i].test(label) && visible(el);
    });
    if (hit) {
      const label = (hit.textContent || hit.value || '').replace(/\s+/g, ' ').trim();
      hit.click();
      return label;
    }
  }
  return null;
}`;

/**
 * Run one of the page functions above, with its argument.
 *
 * page.evaluate() given a string evaluates it as an expression and silently
 * drops any argument — it does not call the function for you — so the call is
 * built into the expression itself.
 */
function callInPage<T>(page: Page, fnSource: string, arg?: unknown): Promise<T> {
  const call = arg === undefined ? `(${fnSource})()` : `(${fnSource})(${JSON.stringify(arg)})`;
  return page.evaluate(call) as Promise<T>;
}

type AnswerKind = 'radio' | 'checkbox' | 'select';

interface AnswerRequest {
  question: string;
  kind: AnswerKind;
  option: string;
  checked?: boolean;
}

const answerQuestion = (page: Page, request: AnswerRequest): Promise<boolean> =>
  callInPage<boolean>(page, FN_ANSWER, request);

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

const attachmentNames = (page: Page): Promise<string[]> =>
  callInPage<string[]>(page, FN_ATTACHMENT_NAMES);

const selectResumeRow = (page: Page, fileName: string): Promise<boolean> =>
  callInPage<boolean>(page, FN_SELECT_RESUME, fileName);

/** Returns the label of whatever was clicked, or null if no banner was up. */
const dismissCookieBanner = (page: Page): Promise<string | null> =>
  callInPage<string | null>(page, FN_DISMISS_COOKIES);

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

      // Vet the URL before the browser ever opens it: the credentials are
      // typed into whatever this loads, so an unexpected host is a hard stop.
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

      const p = config!.profile;
      let signedIn = false;
      const visited: FlowStep[] = [];

      // The portal carries a candidate's previous answers forward and lands on
      // whichever step still needs input, so the sequence is not fixed. Work
      // out where we are each time round rather than assuming an order.
      for (let hop = 0; hop < MAX_STEPS; hop++) {
        const banner = await dismissCookieBanner(page).catch(() => null);
        if (banner) {
          log(`[apply ${job.cardId}] dismissed the cookie banner via "${banner}"`);
          await page.waitForTimeout(500);
        }

        const title = await page.title().catch(() => '');
        const body = (await page.textContent('body').catch(() => '')) ?? '';

        if (/captcha|are you a robot|unusual activity/i.test(body)) {
          // Working around a bot check is not something this tool does.
          return await fail('the portal presented a CAPTCHA or bot check; finish this one by hand');
        }

        const step = identifyStep(title, body);
        visited.push(step);
        await shoot(`${String(hop).padStart(2, '0')}-${step}`);

        // Same step twice running means the post-back did not take us forward.
        if (visited.length >= 2 && visited.at(-1) === visited.at(-2) && step !== 'unknown') {
          return await fail(`stuck on the ${step} step; it did not advance`);
        }

        switch (step) {
          case 'login': {
            if (signedIn) {
              return await fail('returned to the sign-in page — the credentials were rejected');
            }
            await page.getByPlaceholder(/user name/i).first().fill(config!.username);
            await page.getByPlaceholder(/password/i).first().fill(config!.password);
            await clickAndSettle(page, /log ?in|sign ?in/i);
            signedIn = true;
            break;
          }

          case 'personal': {
            if (!(await chooseSelect(page, 'How did you hear about us', p.hearAboutUs))) {
              return await fail(`could not set "How did you hear about us" to ${p.hearAboutUs}`);
            }
            await page.waitForTimeout(1_000); // the Source select is drawn by that choice
            await chooseSelect(page, 'Source', p.source);
            if (
              !(await chooseRadio(
                page,
                'require sponsorship for employment visa',
                p.requiresSponsorship,
              ))
            ) {
              return await fail('could not answer the visa sponsorship question');
            }
            if (!(await chooseRadio(page, 'legally authorized to work', p.legallyAuthorized))) {
              return await fail('could not answer the work authorization question');
            }
            await setCheckbox(
              page,
              'Job Posting Notification',
              'notification',
              p.jobPostingNotification,
            );
            await clickAndSettle(page, /continue/i);
            break;
          }

          case 'diversity': {
            if (!(await chooseRadio(page, 'Gender', p.gender))) {
              return await fail(`could not set Gender to ${p.gender}`);
            }
            if (
              !(await chooseRadio(page, 'Veterans Invitation to Self Identify', p.veteranStatus))
            ) {
              return await fail(`could not set veteran status to ${p.veteranStatus}`);
            }
            for (const race of p.race) {
              if (!(await setCheckbox(page, 'Race', race, true))) {
                return await fail(`could not tick race "${race}"`);
              }
            }
            await clickAndSettle(page, /continue/i);
            break;
          }

          case 'attachments': {
            const names = await attachmentNames(page);
            if (findResumeRow(names, p.resumeFileName) === -1) {
              return await fail(
                `resume "${p.resumeFileName}" is not on the account; found: ${
                  names.join(', ') || 'none'
                }`,
              );
            }
            if (!(await selectResumeRow(page, p.resumeFileName))) {
              return await fail(`could not tick Relevant/Resume for ${p.resumeFileName}`);
            }
            await clickAndSettle(page, /continue/i);
            break;
          }

          case 'review': {
            // Whoever filled this in — us this run, or the portal from a past
            // application — this page is what gets submitted, so check it.
            const problems = reviewProblems(body, p);
            if (problems.length > 0) {
              return await fail(`review does not match the profile: ${problems.join('; ')}`);
            }
            const submit = page.getByRole('button', { name: /^submit$/i }).first();
            if ((await submit.count()) === 0) {
              return await fail('on the review page but no Submit button is present');
            }
            if (config!.dryRun) {
              log(`[apply ${job.cardId}] dry run: review checked out, nothing submitted.`);
              return {
                outcome: 'dry_run',
                reason: 'stopped on the review page (AUTO_APPLY_DRY_RUN)',
                screenshots: shots,
                reviewText: body,
              };
            }

            // Past this line the application may exist on the portal, so
            // nothing below may report `failed` — that status allows a retry.
            let clickedAt: number;
            try {
              clickedAt = Date.now();
              await clickAndSettle(page, /^submit$/i);
            } catch (err) {
              return await uncertain(
                `Submit was clicked but the page never settled (${
                  err instanceof Error ? err.message : String(err)
                }) — check the portal before applying again`,
              );
            }
            await shoot('99-after-submit');
            const done = (await page.textContent('body').catch(() => '')) ?? '';
            if (!isThankYouPage(done)) {
              return await uncertain(
                `Submit was clicked ${Date.now() - clickedAt}ms ago but no Thank You page ` +
                  'appeared — check the portal before applying again',
              );
            }
            log(`[apply ${job.cardId}] submitted: ${job.title.trim()}`);
            return { outcome: 'submitted', reason: null, screenshots: shots };
          }

          case 'thankyou': {
            // Reaching this without submitting means it was already applied to.
            if (!signedIn || visited.includes('review')) {
              log(`[apply ${job.cardId}] submitted: ${job.title.trim()}`);
              return { outcome: 'submitted', reason: null, screenshots: shots };
            }
            return await fail('landed on a Thank You page without submitting anything');
          }

          default:
            return await fail(
              `unrecognised page "${title}" — the portal flow has changed; see the screenshot`,
            );
        }
      }

      return await fail(`gave up after ${MAX_STEPS} steps without reaching a conclusion`);
    } catch (err) {
      return await fail(err instanceof Error ? err.message : String(err));
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  return { configured: true, apply };
}
