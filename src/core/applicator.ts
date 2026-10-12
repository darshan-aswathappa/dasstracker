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

import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ApplicationProfile } from './profile.js';
import { deriveApplyUrl } from './fetcher.js';
import { identifyStep, reviewProblems, type FlowStep } from './review.js';
import type { Job } from './types.js';

const DEFAULT_LOGIN_HOST = 'talentacquisition.3ds.com';
/** Taleo pages post back on every Continue; give each one room to settle. */
const STEP_TIMEOUT_MS = 45_000;
/** Hard bound on the flow, so an unexpected loop cannot run forever. */
const MAX_STEPS = 12;
/** How long to wait for a step's post-back to navigate. */
const NAV_TIMEOUT_MS = 20_000;

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

/**
 * A URL safe to log. `https://user:secret@host/x` is a valid URL, and these
 * strings end up in logs, in the applications table, and in alert emails.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return `${parsed.toString()} (credentials removed)`;
    }
    return parsed.toString();
  } catch {
    return '<unparseable url>';
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
    // Already set: do NOT fire a change event. The portal posts back and
    // re-renders the step on change, which throws away anything done since.
    if (select.value === match.value) return true;
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

  // Same reasoning as the select: re-clicking a chosen radio can post back.
  if (req.kind === 'radio') {
    if (hit.checked) return true;
    hit.click();
    return hit.checked;
  }
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
  const norm = function (el) {
    return ((el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();
  };
  const visible = function (el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  };
  const CLICKABLE = 'a,button,input[type=button],input[type=submit],[role=button]';

  // Find the banner itself before clicking anything inside it. Searching the
  // whole page for a "decline"-ish label is how an automation ends up pressing
  // "I DECLINE" on a privacy agreement, which is a different question entirely.
  const containers = Array.prototype.slice
    .call(document.querySelectorAll('div,section,aside,dialog,form'))
    .filter(function (el) {
      if (!visible(el)) return false;
      if (!/\bcookies?\b/i.test(norm(el))) return false;
      return el.querySelectorAll(CLICKABLE).length > 0;
    });
  if (containers.length === 0) return null;

  // The smallest matching container is the banner, not the page wrapping it.
  const banner = containers.reduce(function (a, b) {
    return norm(a).length <= norm(b).length ? a : b;
  });

  // Most private first. These are only ever matched inside the cookie banner.
  const wanted = [
    /continue with only necessary cookies/i,
    /only necessary/i,
    /reject all/i,
    /^\s*decline\b/i,
  ];
  const clickable = Array.prototype.slice.call(banner.querySelectorAll(CLICKABLE));
  for (let i = 0; i < wanted.length; i++) {
    const hit = clickable.find(function (el) {
      return wanted[i].test(norm(el)) && visible(el);
    });
    if (hit) {
      const label = norm(hit);
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
/**
 * True when evaluate failed because the page navigated out from under it,
 * rather than because the script was wrong. Only our own interaction can
 * cause this, so the control did respond.
 */
export function isNavigationTeardown(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /execution context was destroyed|target closed|frame was detached|navigation/i.test(
    message,
  );
}

async function callInPage<T>(
  page: Page,
  fnSource: string,
  arg?: unknown,
  whenNavigated?: T,
): Promise<T> {
  const call = arg === undefined ? `(${fnSource})()` : `(${fnSource})(${JSON.stringify(arg)})`;
  try {
    return (await page.evaluate(call)) as T;
  } catch (err) {
    // A control that posts back can tear the context down mid-call. Where the
    // caller says what that means, report it rather than failing the run.
    if (whenNavigated !== undefined && isNavigationTeardown(err)) return whenNavigated;
    throw err;
  }
}

/**
 * Click a control by its visible label, whatever element it happens to be.
 *
 * The portal styles its primary actions as pills that look identical whether
 * they are <button>, <input> or <a>. getByRole('button') silently misses the
 * anchors — which is how "I ACCEPT" went unfound on a page that plainly shows
 * it. Matching on the label instead covers all of them.
 */
const FN_CLICK_LABEL = String.raw`(req) => {
  const norm = function (el) {
    return ((el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();
  };
  const visible = function (el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  };
  const controls = Array.prototype.slice.call(
    document.querySelectorAll(
      'a,button,input[type=submit],input[type=button],input[type=reset],[role=button]'
    )
  );
  for (let i = 0; i < req.patterns.length; i++) {
    const re = new RegExp(req.patterns[i], 'i');
    const hit = controls.find(function (el) { return re.test(norm(el)) && visible(el); });
    if (hit) {
      const label = norm(hit);
      // Clicking navigates, which destroys this execution context — and with
      // it the pending result. Let evaluate return first, then click.
      setTimeout(function () { hit.click(); }, 0);
      return label;
    }
  }
  return null;
}`;

/** Every clickable label on the page, for diagnosing a control we cannot find. */
const FN_LIST_CLICKABLES = String.raw`() => {
  const norm = function (el) {
    return ((el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim();
  };
  const visible = function (el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  };
  const seen = [];
  Array.prototype.slice.call(
    document.querySelectorAll(
      'a,button,input[type=submit],input[type=button],input[type=reset],[role=button]'
    )
  ).forEach(function (el) {
    const label = norm(el);
    if (label && visible(el) && label.length < 60 && seen.indexOf(label) === -1) seen.push(label);
  });
  return seen;
}`;

type AnswerKind = 'radio' | 'checkbox' | 'select';

interface AnswerRequest {
  question: string;
  kind: AnswerKind;
  option: string;
  checked?: boolean;
}

const answerQuestion = (page: Page, request: AnswerRequest): Promise<boolean> =>
  // A select that re-renders the form counts as answered: only our own change
  // event could have triggered it. The review page is checked before submit.
  callInPage<boolean>(page, FN_ANSWER, request, true);

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
  callInPage<string[]>(page, FN_ATTACHMENT_NAMES, undefined, []);

const selectResumeRow = (page: Page, fileName: string): Promise<boolean> =>
  callInPage<boolean>(page, FN_SELECT_RESUME, fileName, true);

/** Returns the label of whatever was clicked, or null if no banner was up. */
const dismissCookieBanner = (page: Page): Promise<string | null> =>
  callInPage<string | null>(page, FN_DISMISS_COOKIES);

/**
 * No navigation tolerance here, deliberately. The click is deferred a tick so
 * our own click cannot tear the context down before evaluate returns — so a
 * teardown means something *else* navigated, and the click was lost. Reporting
 * that as a successful click is what hid a lost I ACCEPT behind a page that
 * had quietly reloaded underneath it.
 */
const clickByLabel = (page: Page, patterns: string[]): Promise<string | null> =>
  callInPage<string | null>(page, FN_CLICK_LABEL, { patterns });

const listClickables = (page: Page): Promise<string[]> =>
  callInPage<string[]>(page, FN_LIST_CLICKABLES, undefined, []);

/**
 * Click a step's forward control and wait for the post-back to land. Returns
 * the label clicked, or null when nothing matched — callers treat null as a
 * hard stop rather than carrying on with a form that never advanced.
 */
async function clickAndSettle(page: Page, patterns: string[]): Promise<string | null> {
  // Clicking happens in-page, which — unlike Playwright's own click — does not
  // wait for the navigation it triggers. The wait has to be armed BEFORE the
  // click, or the next step reads the page we just left.
  const navigated = page
    .waitForNavigation({ timeout: NAV_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  const clicked = await clickByLabel(page, patterns);
  if (!clicked) {
    await navigated; // let the armed wait settle rather than leak
    return null;
  }
  await navigated;
  await page.waitForLoadState('networkidle', { timeout: STEP_TIMEOUT_MS }).catch(() => {});
  return clicked;
}

/** Label patterns for the controls the flow drives. Anchored, so that SUBMIT
 *  can never match SAVE AS DRAFT and I ACCEPT can never match I DECLINE. */
const CONTINUE = ['^continue$'];
const SUBMIT = ['^submit$'];
const SIGN_IN = ['^log ?in$', '^sign ?in$'];
const I_ACCEPT = ['^i\\s*accept$'];

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
    // These capture the whole application — name, phone, email, answers — and
    // this box is shared, so keep them readable only by the owning account.
    mkdirSync(config!.screenshotDir, { recursive: true, mode: 0o700 });
    chmodSync(config!.screenshotDir, 0o700);
    const shots: string[] = [];
    const browser = await open();
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);

    const shoot = async (label: string): Promise<void> => {
      const path = resolve(config!.screenshotDir, `${job.cardId}-${label}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      try {
        chmodSync(path, 0o600);
      } catch {
        // The screenshot is a diagnostic; losing it must not fail an application.
      }
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
      // About one posting in twenty arrives with no Apply CTA; the link is
      // derivable from the requisition id, so a missing one is not a dead end.
      const applyUrl = job.applyUrl || deriveApplyUrl(job.cardId);
      if (!job.applyUrl) {
        log(`[apply ${job.cardId}] no apply URL stored; using ${redactUrl(applyUrl)}`);
      }

      // Vet the URL before the browser ever opens it: the credentials are
      // typed into whatever this loads, so an unexpected host is a hard stop.
      if (!isExpectedHost(applyUrl, config!.loginHost)) {
        return await fail(
          `apply URL host is not ${config!.loginHost}, refusing to sign in: ` +
            redactUrl(applyUrl),
        );
      }
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded' });
      if (!isExpectedHost(page.url(), config!.loginHost)) {
        return await fail(
          `apply URL redirected off ${config!.loginHost}, refusing to sign in: ` +
            redactUrl(page.url()),
        );
      }

      const p = config!.profile;
      let signedIn = false;
      const visited: FlowStep[] = [];

      // The portal carries a candidate's previous answers forward and lands on
      // whichever step still needs input, so the sequence is not fixed. Work
      // out where we are each time round rather than assuming an order.
      for (let hop = 0; hop < MAX_STEPS; hop++) {
        // Re-check on every hop, not just before the first navigation. The
        // flow posts back repeatedly, and a redirect onto another host that
        // happens to look like a sign-in page would otherwise be handed the
        // real credentials by the `login` case below.
        if (!isExpectedHost(page.url(), config!.loginHost)) {
          return await fail(
            `flow left ${config!.loginHost} mid-application, stopping: ` + redactUrl(page.url()),
          );
        }

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

        /** Advance the step, failing with what the page does offer. */
        const advance = async (patterns: string[], what: string): Promise<ApplyResult | null> => {
          const clicked = await clickAndSettle(page, patterns);
          if (clicked) return null;
          const offered = await listClickables(page).catch(() => []);
          return await fail(
            `could not find the ${what} control; the page offers: ${
              offered.join(' | ') || '(nothing clickable)'
            }`,
          );
        };

        switch (step) {
          case 'login': {
            if (signedIn) {
              return await fail('returned to the sign-in page — the credentials were rejected');
            }
            // Last line of defence before the secret is typed: whatever the
            // step detection concluded, only the real portal gets it.
            if (!isExpectedHost(page.url(), config!.loginHost)) {
              return await fail(
                `refusing to enter credentials on ${redactUrl(page.url())}`,
              );
            }
            const passwordField = page.locator('input[type=password]').first();
            if ((await passwordField.count()) === 0) {
              // Never type a password into a field the browser will render in
              // clear text — and the screenshots below would capture it.
              return await fail('sign-in page has no password field; not entering credentials');
            }
            await page.getByPlaceholder(/user name/i).first().fill(config!.username);
            await passwordField.fill(config!.password);
            const stopped = await advance(SIGN_IN, 'sign-in');
            if (stopped) return stopped;
            signedIn = true;
            break;
          }

          case 'privacy': {
            // This consent gates the entire application, so it is read from
            // the profile rather than assumed, and a false value stops here
            // instead of clicking Decline on the candidate's behalf.
            if (!p.acceptPrivacyAgreement) {
              return await fail(
                'the portal requires accepting its Privacy Agreement and the profile ' +
                  'does not accept it; finish this one by hand',
              );
            }
            await chooseSelect(page, 'Select your preferred language', p.privacyLanguage);
            log(`[apply ${job.cardId}] accepting the privacy agreement`);
            const stopped = await advance(I_ACCEPT, 'I ACCEPT');
            if (stopped) return stopped;
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
            const stopped = await advance(CONTINUE, 'Continue');
            if (stopped) return stopped;
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
            const stopped = await advance(CONTINUE, 'Continue');
            if (stopped) return stopped;
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
            const stopped = await advance(CONTINUE, 'Continue');
            if (stopped) return stopped;
            break;
          }

          case 'review': {
            // Whoever filled this in — us this run, or the portal from a past
            // application — this page is what gets submitted, so check it.
            const problems = reviewProblems(body, p);
            if (problems.length > 0) {
              return await fail(`review does not match the profile: ${problems.join('; ')}`);
            }
            const offered = await listClickables(page).catch(() => []);
            if (!offered.some((label) => /^submit$/i.test(label))) {
              return await fail(
                `on the review page but no Submit control is present; offers: ${
                  offered.join(' | ') || '(nothing clickable)'
                }`,
              );
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
              const pressed = await clickAndSettle(page, SUBMIT);
              if (!pressed) {
                // Nothing was clicked, so nothing was submitted: safe to retry.
                return await fail('the Submit control vanished before it could be pressed');
              }
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
