// @vitest-environment jsdom
/**
 * The footer appears on every kind of screen: sign-in, employee portal, and the
 * admin area - the three layouts that render it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { App } from '../../src/frontend/App.js';
import {
  renderWithProviders,
  stubFetch,
  adminEmployee,
  ADMIN_USER,
  SESSION_USER,
  todayPayload,
  ok,
  fail,
} from './helpers.js';

const CREDIT = 'Developed in-house by the AMCO Information Technology Department, 2026.';
const NOTICE = 'This website is intended for internal use only.';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const expectFooter = async () => {
  const footer = await screen.findByRole('contentinfo');
  expect(footer).toHaveTextContent(CREDIT);
  expect(footer).toHaveTextContent(NOTICE);
};

describe('Site footer', () => {
  it('is on the sign-in page', async () => {
    stubFetch({ '/api/auth/me': fail(401, 'Not authenticated') });
    renderWithProviders(<App />, { route: '/login' });
    await screen.findByRole('heading', { name: 'CanteenHub' });
    await expectFooter();
  });

  it('is on the employee portal', async () => {
    stubFetch({ '/api/auth/me': ok(SESSION_USER), '/api/me/today': ok(todayPayload()) });
    renderWithProviders(<App />, { route: '/' });
    await screen.findByText('Portal Tester');
    await expectFooter();
  });

  it('is in the admin area', async () => {
    stubFetch({
      '/api/auth/me': ok(ADMIN_USER),
      '/api/admin/employees': ok({ employees: [adminEmployee()], total: 1 }),
    });
    renderWithProviders(<App />, { route: '/admin/employees' });
    await screen.findByRole('heading', { name: 'Employees' });
    await expectFooter();
  });
});
