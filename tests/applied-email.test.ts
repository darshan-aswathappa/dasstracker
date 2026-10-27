import { describe, it, expect } from 'vitest';
import {
  buildAppliedEmail,
  buildApplyByHandEmail,
  applyNotifyList,
} from '../src/core/notifier.js';
import type { StoredJob } from '../src/core/types.js';

const job: StoredJob = {
  cardId: '550383',
  title: '  AI Scientific Software Engineer - Marie  ',
  url: 'https://www.3ds.com/careers/jobs/ai-scientific-software-engineer-550383',
  applyUrl: 'https://talentacquisition.3ds.com/careersection/qa/jobapply.ftl?job=550383',
  location: 'United States, CA, San Diego',
  category: 'Research & Development',
  products: 'BIOVIA',
  experience: '0 to 3 years',
  postedAt: '2026-10-11T09:10:57.000Z',
  firstSeenAt: '2026-10-12T15:00:00.000Z',
  matched: true,
  notifiedAt: null,
  description: 'Build models for BIOVIA.',
  entryLevel: true,
  classifiedAt: '2026-10-12T15:15:03.596Z',
  roleKind: 'ai',
  roleClassifiedAt: '2026-10-12T15:15:04.000Z',
  roleAttempts: 1,
  roleAlertedAt: null,
};

describe('buildAppliedEmail', () => {
  it('states the outcome and the job it applies to', () => {
    const mail = buildAppliedEmail(job);
    expect(mail.subject).toBe('Applied: AI Scientific Software Engineer - Marie');
    expect(mail.text).toContain('Applied to the job successfully');
    expect(mail.text).toContain('0 to 3 years');
    expect(mail.text).toContain(job.url);
    expect(mail.html).toContain('United States, CA, San Diego');
  });

  it('carries no test marking on a real confirmation', () => {
    const mail = buildAppliedEmail(job);
    expect(mail.subject).not.toContain('[test]');
    expect(mail.text).not.toMatch(/this is a test/i);
    expect(mail.html).not.toMatch(/this is a test/i);
  });

  it('marks a preview unmistakably, in the subject and the body', () => {
    // Someone else reads this mailbox, so a test must never look like a real
    // application having been submitted.
    const mail = buildAppliedEmail(job, true);
    expect(mail.subject).toBe('[test] Applied: AI Scientific Software Engineer - Marie');
    expect(mail.text).toMatch(/THIS IS A TEST/);
    expect(mail.text).toMatch(/No application was submitted/i);
    expect(mail.html).toMatch(/THIS IS A TEST/);
  });

  it('keeps the preview layout identical to the real thing', () => {
    const real = buildAppliedEmail(job);
    const preview = buildAppliedEmail(job, true);
    // Same content, so the preview is worth judging the real mail by.
    for (const fragment of ['Applied to the job successfully', '0 to 3 years', job.url]) {
      expect(real.text).toContain(fragment);
      expect(preview.text).toContain(fragment);
    }
  });

  it('escapes the job title rather than injecting it into the HTML', () => {
    const nasty = { ...job, title: 'Engineer <script>alert(1)</script>' };
    expect(buildAppliedEmail(nasty).html).not.toContain('<script>');
  });
});

describe('applyNotifyList', () => {
  it('defaults to both named recipients', () => {
    expect(applyNotifyList({})).toEqual([
      'darshanaswath@gmail.com',
      'huns.n@northeastern.edu',
    ]);
  });

  it('is overridable from the environment', () => {
    expect(applyNotifyList({ APPLY_NOTIFY_TO: 'a@x.com, b@y.com' })).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });

  it('falls back to the defaults when the override is blank', () => {
    expect(applyNotifyList({ APPLY_NOTIFY_TO: '   ' })).toHaveLength(2);
  });
});

describe('buildApplyByHandEmail', () => {
  const reason = 'This is neither an AI nor a software engineering role.';

  it('names the job and gives the link to finish it', () => {
    const mail = buildApplyByHandEmail(job, reason);
    expect(mail.subject).toBe('Apply by hand: AI Scientific Software Engineer - Marie');
    expect(mail.text).toContain(reason);
    expect(mail.text).toContain(job.applyUrl);
    expect(mail.html).toContain(job.applyUrl);
  });

  it('is unmistakable that nothing was submitted or left half-done', () => {
    const mail = buildApplyByHandEmail(job, reason);
    expect(mail.text).toMatch(/Nothing was submitted/i);
    expect(mail.text).not.toMatch(/applied to the job successfully/i);
  });

  it('says it will not repeat itself', () => {
    expect(buildApplyByHandEmail(job, reason).text).toMatch(/only email you will get/i);
  });

  it('marks a preview, so a test never reads as a real skip', () => {
    const mail = buildApplyByHandEmail(job, reason, true);
    expect(mail.subject).toContain('[test]');
    expect(mail.text).toMatch(/THIS IS A TEST/);
  });
});
