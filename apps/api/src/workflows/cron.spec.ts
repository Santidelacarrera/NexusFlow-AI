import { cronMatches, isValidCron } from './cron';

describe('cron', () => {
  const d = new Date('2026-03-04T09:30:00Z'); // miércoles (3)
  it('valida expresiones', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('0,30 9 * * *')).toBe(true);
    expect(isValidCron('60 * * * *')).toBe(false);
    expect(isValidCron('* * * *')).toBe(false);
    expect(isValidCron('*/0 * * * *')).toBe(false);
    expect(isValidCron('a b c d e')).toBe(false);
    expect(isValidCron('5-1 * * * *')).toBe(false);
  });
  it('evalúa coincidencias', () => {
    expect(cronMatches('30 9 * * *', d)).toBe(true);
    expect(cronMatches('*/15 9 * * *', d)).toBe(true);
    expect(cronMatches('*/7 * * * *', d)).toBe(false);
    expect(cronMatches('30 9 * * 1-5', d)).toBe(true);
    expect(cronMatches('30 9 * * 0,6', d)).toBe(false);
    expect(cronMatches('30 9 4 3 *', d)).toBe(true);
    expect(cronMatches('invalid', d)).toBe(false);
  });
});
