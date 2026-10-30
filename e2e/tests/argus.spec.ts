import { type AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { SMTPServer } from 'smtp-server';
import { ADMIN_PASSWORD, GITHUB_TOKEN } from '../global-setup';

const NEW_PASSWORD = 'Browser-Root-Pass-42';

/** Fails the test on uncaught page errors and console errors (including Content-Security-Policy violations). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    // 401s are the expected answer to "am I signed in?" before sign-in; anything else counts.
    if (m.type() === 'error' && !/status of 401/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function signIn(page: Page, password = NEW_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Username or email').fill('admin');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (password === NEW_PASSWORD) await expect(page.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
}

test.describe.serial('Argus in a browser', () => {
  test('first sign-in forces a password change, then opens the dashboard', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in to Argus' })).toBeVisible();
    await signIn(page, ADMIN_PASSWORD);

    await expect(page.getByText('Choose a new password')).toBeVisible();
    await page.getByLabel('Current password').fill(ADMIN_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('every page in the navigation renders without errors', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await expect(page.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
    const links = await page.locator('nav a[href^="/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')!))]);
    expect(links.length).toBeGreaterThan(10);
    for (const href of links) {
      await page.goto(href);
      await expect(page.locator('h1').first(), `heading on ${href}`).toBeVisible();
      await expect(page.getByText('Something went wrong'), `error on ${href}`).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });

  test('connects GitHub, monitors a repository, and turns its leaked secrets into tickets', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/admin/sources');
    await page.getByRole('button', { name: 'Connect source' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Acme GitHub');
    await dialog.getByLabel('GitHub Enterprise Server URL').fill(process.env.ARGUS_E2E_GITHUB_URL!);
    await dialog.getByLabel('Organisation').fill('acme');
    await dialog.getByLabel('Access token').fill(GITHUB_TOKEN);
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText(/Connected as argus-bot/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    // The webhook secret is shown once.
    await page.getByRole('button', { name: 'Done' }).click();

    await page.goto('/repositories');
    await expect(page.getByRole('link', { name: 'acme/shop' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Select acme/shop').check();
    await page.getByRole('button', { name: 'Start monitoring' }).click();
    await expect(page.getByRole('row', { name: /acme\/shop/ }).getByText('Monitored')).toBeVisible();

    // Activation queues the first scan within a scheduler tick; wait for it to finish.
    await page.getByRole('link', { name: 'acme/shop' }).click();
    await expect(page).toHaveURL(/\/repositories\/[0-9a-f-]{36}$/);
    const scans = `/api/v1/repos/${page.url().split('/').pop()}/scans`;
    await expect
      .poll(async () => ((await (await page.request.get(scans)).json()) as { items: { status: string }[] }).items[0]?.status, { timeout: 60_000 })
      .toBe('succeeded');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Scan now' })).toBeVisible();

    await page.goto('/tickets');
    const ticket = page.getByRole('link', { name: /GitHub personal access token/ }).first();
    await expect(ticket).toBeVisible({ timeout: 30_000 });
    await ticket.click();
    await page.getByLabel('Change status').selectOption({ label: 'In progress' });
    await expect(page.getByText('In progress').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('bulk start and stop monitoring only apply to a selection of one kind', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/repositories');
    const start = page.getByRole('button', { name: 'Start monitoring' });
    const stop = page.getByRole('button', { name: 'Stop monitoring' });
    // acme/shop is monitored (from the previous test); acme/billing is not.
    await expect(page.getByRole('row', { name: /acme\/billing/ }).getByText('Not monitored')).toBeVisible();

    await page.getByLabel('Select acme/shop').check();
    await expect(start).toBeDisabled();
    await expect(stop).toBeEnabled();

    await page.getByLabel('Select acme/shop').uncheck();
    await page.getByLabel('Select acme/billing').check();
    await expect(start).toBeEnabled();
    await expect(stop).toBeDisabled();

    await page.getByLabel('Select acme/shop').check();
    await expect(start).toBeDisabled();
    await expect(stop).toBeDisabled();
    await expect(page.getByText(/mixes monitored and not monitored/)).toBeVisible();

    await page.getByLabel('Select acme/shop').uncheck();
    await expect(start).toBeEnabled();
    await expect(page.getByText(/mixes monitored and not monitored/)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('saves a filtered ticket list as a view and applies it again', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/tickets');
    await page.getByRole('group', { name: 'Severity' }).getByRole('button', { name: 'high' }).click();
    await expect(page).toHaveURL(/severity=high/);
    await page.getByRole('button', { name: 'Save view' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('High severity');
    await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('View saved.')).toBeVisible();

    await page.goto('/tickets');
    await expect(page).not.toHaveURL(/severity=/);
    await page.getByLabel('Saved views').selectOption({ label: 'High severity' });
    await expect(page).toHaveURL(/severity=high/);
    expect(errors).toEqual([]);
  });

  test('an administrator invites a user, who signs up through the link', async ({ page, browser }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Invite users' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role').selectOption({ label: 'Viewer' });
    await dialog.getByLabel('Note (optional)').fill('Browser test');
    await dialog.getByRole('button', { name: 'Create invite link' }).click();
    const link = (await page.getByRole('dialog').locator('pre').textContent())!;
    expect(link).toMatch(/\/invite#[\w-]{20,}$/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('row', { name: /Browser test/ }).getByText('0 of 1')).toBeVisible();

    const guest = await browser.newPage();
    const guestErrors = watchErrors(guest);
    await guest.goto(link);
    await expect(guest.getByText(/You are invited as Viewer/)).toBeVisible();
    await guest.getByLabel('Username').fill('invited.viewer');
    await guest.getByLabel('Display name').fill('Invited Viewer');
    await guest.getByLabel('Password', { exact: true }).fill('Invited-Viewer-Pass-7');
    await guest.getByLabel('Confirm password').fill('Invited-Viewer-Pass-7');
    await guest.getByRole('button', { name: 'Create account' }).click();
    await expect(guest.getByRole('heading', { name: 'Welcome, Invited Viewer' })).toBeVisible();
    await guest.close();

    await page.reload();
    await expect(page.getByText('No active invite links')).toBeVisible();
    await expect(page.getByText('@invited.viewer')).toBeVisible();
    expect(errors).toEqual([]);
    expect(guestErrors).toEqual([]);
  });

  test('copies one-time secrets on plain HTTP, where the Clipboard API is missing', async ({ page }) => {
    // Browsers only offer navigator.clipboard on HTTPS or localhost; remove it to behave like http://<server-ip>.
    await page.addInitScript(`
      Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined });
      document.addEventListener('copy', (e) => { window.copied = e.target.value.slice(e.target.selectionStart, e.target.selectionEnd); });
    `);
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/admin/users');
    await page.getByRole('button', { name: 'Invite users' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create invite link' }).click();
    const link = (await page.getByRole('dialog').locator('pre').textContent())!;
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate('window.copied')).toBe(link);
    expect(errors).toEqual([]);
  });

  test('shows the bundled documentation and the live API reference', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.getByRole('link', { name: 'Documentation' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Argus documentation' })).toBeVisible();

    // Links between docs stay in the app; a link to a heading scrolls to it.
    await page.getByRole('article').getByRole('link', { name: 'User management' }).first().click();
    await expect(page).toHaveURL(/\/docs\/features\/user-management$/);
    await expect(page.getByRole('heading', { level: 1, name: 'User management' })).toBeVisible();
    await page.goto('/docs/features/user-management#invite-links');
    await expect(page.getByRole('heading', { level: 2, name: /Invite links/ })).toBeInViewport();

    await page.getByLabel('Search the docs').fill('gitleaks offline');
    await page.getByRole('navigation', { name: 'Documentation' }).getByRole('link', { name: /Scanners, findings/ }).click();
    await expect(page).toHaveURL(/\/docs\/features\/scanners-and-findings$/);

    await page.getByRole('link', { name: 'API reference' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'API reference' })).toBeVisible();
    await page.getByLabel('Filter endpoints').fill('invites/accept');
    await page.getByRole('button', { name: /\/api\/v1\/invites\/accept/ }).click();
    await expect(page.getByText('JSON body')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'username*' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a user signs in with a link from their email', async ({ page }) => {
    const mails: { to: string[]; raw: string }[] = [];
    const smtp = new SMTPServer({
      authOptional: true,
      logger: false,
      onData: (stream, session, cb) => {
        let raw = '';
        stream.on('data', (d: Buffer) => (raw += d.toString()));
        stream.on('end', () => (mails.push({ to: session.envelope.rcptTo.map((r) => r.address), raw }), cb()));
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    try {
      const errors = watchErrors(page);
      await signIn(page);
      // Set-up through the API: an email channel, and an email address for the user invited earlier.
      const csrf = (await page.context().cookies()).find((c) => c.name === 'argus_csrf')!.value;
      const headers = { 'x-csrf-token': csrf };
      const port = (smtp.server.address() as AddressInfo).port;
      await page.request.post('/api/v1/integrations/channels', {
        headers,
        data: { type: 'email_smtp', name: 'Team mail', enabled: true, config: { host: '127.0.0.1', port, security: 'starttls', authMode: 'none', from: 'argus@acme.com', fromName: 'Argus' } },
      });
      const viewer = ((await (await page.request.get('/api/v1/users?search=invited.viewer')).json()) as { items: { id: string }[] }).items[0];
      expect((await page.request.patch(`/api/v1/users/${viewer.id}`, { headers, data: { email: 'viewer@example.com' } })).ok()).toBe(true);

      await page.goto('/admin/security');
      await page.getByLabel('Allow sign-in links').check();
      await page.getByLabel('Send links with').selectOption({ label: 'Team mail' });
      await page.getByRole('button', { name: 'Save settings' }).click();
      await expect(page.getByText(/saved/i).first()).toBeVisible();
      await page.getByRole('button', { name: 'Sign out' }).click();

      await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
      await page.getByLabel('Username or email').fill('viewer@example.com');
      await page.getByRole('button', { name: 'Email me a link' }).click();
      await expect(page.getByText('Check your inbox')).toBeVisible();

      await expect.poll(() => mails.length, { timeout: 15_000 }).toBe(1);
      expect(mails[0].to).toEqual(['viewer@example.com']);
      const link = /(http:\/\/127\.0\.0\.1:\d+\/login#link=[\w-]+)/.exec(mails[0].raw.replace(/=\r?\n/g, '').replace(/=3D/g, '='))![1];
      await page.goto(link);
      await expect(page.getByRole('heading', { name: 'Welcome, Invited Viewer' })).toBeVisible();
      expect(page.url()).not.toContain('link=');
      expect(errors).toEqual([]);
      await page.getByRole('button', { name: 'Sign out' }).click();
    } finally {
      await new Promise<void>((r) => smtp.close(() => r()));
    }
  });

  test('branding changes the product name on the sign-in page', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page);
    await page.goto('/admin/system');
    await page.getByLabel('Product name').fill('Contoso Security');
    await page.getByLabel('Sign-in notice').fill('Authorised use only.');
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText('Branding saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Contoso Security' })).toBeVisible();
    await expect(page.getByText('Authorised use only.')).toBeVisible();
    await expect(page).toHaveTitle('Contoso Security');
    expect(errors).toEqual([]);
  });
});
