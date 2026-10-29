import { expect, type Page, test } from '@playwright/test';
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
