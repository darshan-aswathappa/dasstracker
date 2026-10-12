import { describe, it, expect } from 'vitest';
import { parseArgs } from '../scripts/apply-probe.js';

/** Narrow the union for assertions. */
const ok = (r: ReturnType<typeof parseArgs>) => {
  if ('error' in r) throw new Error(`expected success, got: ${r.error}`);
  return r;
};
const err = (r: ReturnType<typeof parseArgs>) => {
  if (!('error' in r)) throw new Error('expected an error');
  return r.error;
};

describe('parseArgs', () => {
  it('defaults to a dry run on the newest entry-level job', () => {
    const a = ok(parseArgs([]));
    expect(a).toEqual({ target: null, submit: false, emailOnly: false, alert: false });
  });

  it('takes a card id or a URL', () => {
    expect(ok(parseArgs(['550021'])).target).toBe('550021');
    const url = 'https://talentacquisition.3ds.com/careersection/qa/jobapply.ftl?job=550021';
    expect(ok(parseArgs([url])).target).toBe(url);
  });

  it('refuses an unrecognised argument instead of ignoring it', () => {
    // A stray --help alongside --email-only once sent a real email, because
    // unknown arguments were silently dropped.
    expect(err(parseArgs(['550021', '--email-only', '--help']))).toMatch(/--help/);
    expect(err(parseArgs(['--dry']))).toMatch(/unrecognised/);
    expect(err(parseArgs(['-y']))).toMatch(/unrecognised/);
  });

  it('refuses more than one job', () => {
    expect(err(parseArgs(['550021', '550029']))).toMatch(/expected one job/);
  });

  it('requires --submit to name the job explicitly', () => {
    expect(err(parseArgs(['--submit']))).toMatch(/named explicitly/);
    expect(ok(parseArgs(['550021', '--submit'])).submit).toBe(true);
  });

  it('refuses --submit together with --email-only', () => {
    expect(err(parseArgs(['550021', '--submit', '--email-only']))).toMatch(/only one/);
  });

  it('refuses --alert on its own', () => {
    expect(err(parseArgs(['550021', '--alert']))).toMatch(/only applies together/);
    expect(ok(parseArgs(['550021', '--email-only', '--alert'])).alert).toBe(true);
  });

  it('never infers submit from anything but the flag', () => {
    for (const argv of [['550021'], ['550021', '--email-only'], []]) {
      expect(ok(parseArgs(argv)).submit).toBe(false);
    }
  });
});
