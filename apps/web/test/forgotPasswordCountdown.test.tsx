import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CloudClient from '../src/lib/cloud/client';

/**
 * The throttled reset request, as the user experiences it.
 *
 * The Worker answers 429 with `retryAfterSec`; this renders the real sign-in
 * screen and drives the real form, so what is asserted is the sentence and the
 * disabled button — not the presence of a state variable. A bare "Too many
 * reset requests" left the submit button live, i.e. it invited the user to keep
 * pressing a control that could only fail again.
 */
const { forgotPassword } = vi.hoisted(() => ({ forgotPassword: vi.fn() }));

vi.mock('@/lib/cloud/client', async (importOriginal) => {
  const actual = await importOriginal<typeof CloudClient>();
  return { ...actual, cloudAuth: { ...actual.cloudAuth, forgotPassword } };
});

const { CloudError } = await import('../src/lib/cloud/client');
const { default: AccountPage } = await import('../src/features/account/AccountPage');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  );
  if (!found) throw new Error(`no button containing "${text}"`);
  return found;
}

function submitButton(): HTMLButtonElement {
  const found = container.querySelector('button[type="submit"]');
  if (!found) throw new Error('no submit button');
  return found as HTMLButtonElement;
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain('Welcome back'));
}

/** Type into the controlled email input the way a user does: value + input event. */
async function typeEmail(value: string): Promise<void> {
  const input = container.querySelector('input[type="email"]') as HTMLInputElement | null;
  if (!input) throw new Error('no email input');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('forgot password throttle', () => {
  beforeEach(() => {
    forgotPassword.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('counts the wait down and keeps the form disabled until it expires', async () => {
    forgotPassword.mockRejectedValueOnce(
      new CloudError('rate_limited', 429, 'Too many reset requests — try later', 3),
    );
    await mount();

    await act(async () => {
      buttonByText('Forgot password?').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await typeEmail('user@example.test');
    vi.useFakeTimers();
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // The cause is still named, and the wait is a real number rather than "later".
    expect(container.textContent).toContain('Too many reset requests — try later');
    expect(container.textContent).toContain('You can request another link in 0:03.');
    expect(submitButton().disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toContain('0:02.');

    // Once the window passes, the notice clears itself and the form works again.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(container.textContent).not.toContain('You can request another link');
    expect(container.textContent).not.toContain('Too many reset requests');
    expect(submitButton().disabled).toBe(false);
  });

  it('leaves the form usable when the failure is not a throttle', async () => {
    forgotPassword.mockRejectedValueOnce(
      new CloudError(
        'direct_unreachable',
        0,
        'Could not reach the cloud — it is blocked on this network.',
      ),
    );
    await mount();

    await act(async () => {
      buttonByText('Forgot password?').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await typeEmail('user@example.test');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(container.textContent).toContain(
      'Could not reach the cloud — it is blocked on this network.',
    );
    expect(container.textContent).not.toContain('You can request another link');
    // A network failure is worth retrying immediately: no invented cooldown.
    expect(submitButton().disabled).toBe(false);
  });
});
