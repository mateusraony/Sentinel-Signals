// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import DbQuotaBanner from './DbQuotaBanner.jsx';
import { reportDbQuotaExhausted, reportDbReachable, resetDbStatusForTests } from '@/lib/dbStatus';

beforeEach(() => resetDbStatusForTests());
afterEach(cleanup);

describe('DbQuotaBanner', () => {
  it('não aparece com o banco normal', () => {
    render(<DbQuotaBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('aparece quando a API responde db_quota, com a hora do último dado', () => {
    reportDbReachable(Date.parse('2026-10-19T12:30:00'));
    render(<DbQuotaBanner />);
    act(() => reportDbQuotaExhausted());
    expect(screen.getByRole('alert').textContent).toMatch(/Banco de dados sem cota/);
    expect(screen.getByRole('alert').textContent).toMatch(/último dado carregado às 12:30/);
  });

  it('sem resposta boa anterior não inventa horário', () => {
    render(<DbQuotaBanner />);
    act(() => reportDbQuotaExhausted());
    expect(screen.getByRole('alert').textContent).not.toMatch(/último dado/);
  });

  it('some sozinho quando o banco volta', () => {
    render(<DbQuotaBanner />);
    act(() => reportDbQuotaExhausted());
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => reportDbReachable());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
