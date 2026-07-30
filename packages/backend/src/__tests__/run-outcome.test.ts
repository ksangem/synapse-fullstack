/**
 * Run outcome classification.
 *
 * The case that motivated this: re-running an integration over an UNCHANGED source
 * reads every record, publishes none (the inbox suppresses them all as duplicates),
 * and settles as 'success' with zero deliveries. The registry card rendered that as
 * "Finished · reading source… · 0 delivered" — a settled run wearing the label of an
 * in-flight one, with no hint that nothing needed doing. These assertions pin the
 * distinctions the label depends on.
 */

import { describe, it, expect } from 'vitest';
import { classifyOutcome } from '../hub/records-delivery';

const base = { status: 'success', finished: true, expectedOut: 0, recordsRead: 0, delivered: 0, failed: 0 };

describe('classifyOutcome', () => {
  it('reports a re-run over an unchanged source as no-new-records, not an empty success', () => {
    // 27 rows read, all duplicate-suppressed → nothing published, nothing delivered.
    expect(classifyOutcome({ ...base, recordsRead: 27, expectedOut: 0 })).toBe('no-new-records');
  });

  it('distinguishes an EMPTY source from an unchanged one', () => {
    expect(classifyOutcome({ ...base, recordsRead: 0, expectedOut: 0 })).toBe('no-source-records');
  });

  it('never labels an errored run as finished-clean', () => {
    // A source that throws mid-read fails the RUN without failing any single record,
    // so `failed` is 0 and only the run status carries the bad news.
    expect(classifyOutcome({ ...base, status: 'error', recordsRead: 5, expectedOut: 5 })).toBe('failed');
  });

  it('keeps the operator stop distinct from both success and failure', () => {
    expect(classifyOutcome({ ...base, status: 'cancelled', recordsRead: 9, expectedOut: 4, delivered: 4 })).toBe('stopped');
  });

  it('separates a partial failure from a total one', () => {
    expect(classifyOutcome({ ...base, expectedOut: 10, recordsRead: 10, delivered: 7, failed: 3 })).toBe('partial');
    expect(classifyOutcome({ ...base, expectedOut: 10, recordsRead: 10, delivered: 0, failed: 10 })).toBe('failed');
  });

  it('reports a clean delivery', () => {
    expect(classifyOutcome({ ...base, expectedOut: 27, recordsRead: 27, delivered: 27 })).toBe('delivered');
  });

  it('is "running" until the run settles, whatever the counts look like', () => {
    expect(classifyOutcome({ ...base, finished: false })).toBe('running');
    expect(classifyOutcome({ ...base, finished: false, status: 'error' })).toBe('running');
  });
});
