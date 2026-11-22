import { describe, it, expect } from 'vitest';
import moment from 'moment';
import { dayLabel } from './dayLabel.js';

describe('dayLabel', () => {
  const now = moment('2026-11-22T10:00:00');
  it('hoje, ontem e uma data antiga', () => {
    expect(dayLabel(moment('2026-11-22T00:05:00'), now)).toBe('Hoje');
    expect(dayLabel(moment('2026-11-21T23:59:00'), now)).toBe('Ontem');
    expect(dayLabel(moment('2026-11-20T12:00:00'), now)).toBe('20/11/2026');
  });
  it('a virada do dia é pelo calendário, não por 24 h corridas', () => {
    expect(dayLabel(moment('2026-11-21T09:00:00'), moment('2026-11-22T00:30:00'))).toBe('Ontem');
  });
});
