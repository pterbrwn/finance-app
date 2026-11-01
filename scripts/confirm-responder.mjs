const queues = new WeakMap();
const autoLogs = new WeakMap();
export const confirmErrors = [];

export function installConfirmResponder(page) {
  if (queues.has(page)) return;
  const queue = [];
  queues.set(page, queue);
  let polling = false;
  const next = () => queue.find(entry => !entry.settled);
  const settle = (entry, error) => { entry.settled = true; queue.splice(queue.indexOf(entry), 1); if (error) confirmErrors.push(error); entry.resolve(); };
  page.on('dialog', async dialog => {
    const entry = next();
    if (!entry && autoLogs.has(page)) { autoLogs.get(page).push(dialog.message()); await dialog.accept().catch(() => {}); return; }
    if (!entry) { confirmErrors.push(`unexpected native dialog (${dialog.type()}): ${dialog.message()}`); await dialog.dismiss().catch(() => {}); return; }
    entry.settled = true;
    const matches = !entry.pattern || entry.pattern.test(dialog.message());
    await (entry.action === 'accept' && matches ? dialog.accept() : dialog.dismiss()).catch(() => {});
    settle(entry, matches ? null : `native dialog text did not match ${entry.pattern}: ${dialog.message()}`);
  });
  const timer = setInterval(async () => {
    if (polling || page.isClosed()) return;
    polling = true;
    try {
      const entry = next(), auto = autoLogs.get(page);
      if (!entry && !auto) return;
      const dialog = page.locator('dialog.confirm-dialog');
      if (await dialog.count() === 0) return;
      if (!entry) { auto.push(await dialog.locator('[data-confirm-message]').innerText()); await dialog.locator('[data-confirm-ok]').click(); return; }
      entry.settled = true;
      const message = await dialog.locator('[data-confirm-message]').innerText();
      const matches = !entry.pattern || entry.pattern.test(message);
      await dialog.locator(entry.action === 'accept' && matches ? '[data-confirm-ok]' : '[data-confirm-cancel]').click();
      settle(entry, matches ? null : `confirmation text did not match ${entry.pattern}: ${message}`);
    } catch { /* the page or dialog changed while polling; try again */ }
    finally { polling = false; }
  }, 40);
  timer.unref();
  page.on('close', () => clearInterval(timer));
}

export function confirmNext(page, action = 'accept', pattern = null) {
  installConfirmResponder(page);
  return new Promise(resolve => queues.get(page).push({ action, pattern, resolve, settled: false }));
}

export function assertConfirmClean() {
  if (confirmErrors.length) throw new Error('confirmation problems: ' + confirmErrors.join(' | '));
}

export function autoConfirm(page, log = []) {
  installConfirmResponder(page);
  autoLogs.set(page, log);
  return log;
}
