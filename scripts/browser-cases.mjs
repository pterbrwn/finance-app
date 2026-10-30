import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';

const appRoot = resolve(import.meta.dirname, '..');
export const availableBrowserCases = Object.freeze(['sample-isolation', 'sample-transaction-filters', 'budget-recurring', 'budget-frequency-history', 'budget-two-tab', 'budget-empty-onboarding', 'budget-create-month', 'budget-archive-history', 'budget-history-controls', 'transaction-splits-commitments', 'form-drafts', 'form-cancel', 'refresh-edit', 'snapshot-races', 'operation-restart', 'operation-reload-recovery', 'accessibility-tree', '__self-check-pageerror', '__self-check-assertion']);

function monthInChicago(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return parts.find(part => part.type === 'year').value + '-' + parts.find(part => part.type === 'month').value;
}

function dateInChicago(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return parts.find(part => part.type === 'year').value + '-' + parts.find(part => part.type === 'month').value + '-' + parts.find(part => part.type === 'day').value;
}

function nextMonth(month) {
  const date = new Date(month + '-01T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

function previousMonth(month) {
  const date=new Date(month+'-01T12:00:00Z');date.setUTCMonth(date.getUTCMonth()-1);return date.toISOString().slice(0,7);
}

async function closeChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(() => { child.kill('SIGKILL'); resolvePromise(); }, 5000))
  ]);
}

export async function runBrowserCase(name) {
  assert.match(process.version, /^v24\.22\.1$/, 'browser cases use pinned Node.js 24.22.1');
  assert.ok(availableBrowserCases.includes(name), `Unknown BROWSER_CASE ${JSON.stringify(name)}; choose ${availableBrowserCases.filter(value => !value.startsWith('__')).join(', ')}`);

  const directory = await mkdtemp(join(tmpdir(), 'ledger-browser-case-'));
  await chmod(directory, 0o700);
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ storageMode: 'sqlite', enablePlaid: false }), { mode: 0o600 });
  const probe = createServer();
  await new Promise((resolvePromise, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const port = probe.address().port;
  await new Promise(resolvePromise => probe.close(resolvePromise));
  let logs = '';
  const serverEnvironment={...process.env,PORT:String(port),LEDGER_NODE_BIN:process.execPath,LEDGER_LOCAL_DATA_DIR:directory,LEDGER_CONFIG_FILE:configPath};
  const spawnServer=()=>{const processHandle=spawn('bash',['scripts/start-ledger.sh'],{cwd:appRoot,env:serverEnvironment,stdio:['ignore','pipe','pipe']});processHandle.stdout.on('data',chunk=>logs+=chunk);processHandle.stderr.on('data',chunk=>logs+=chunk);return processHandle;};
  let child=spawnServer();
  const waitServer=async()=>{for(let attempt=0;attempt<80;attempt++){if(child.exitCode!==null)throw new Error(`synthetic server exited early: ${logs}`);try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)return;}catch{}await new Promise(resolvePromise=>setTimeout(resolvePromise,100));}throw new Error(`synthetic server did not become ready: ${logs}`);};
  const restartServer=async()=>{await closeChild(child);child=spawnServer();await waitServer();};
  let browser, context, page, traceStarted = false;
  const browserErrors = [], consoleErrors = [], apiFailures = [], failures = [], sampleWrites = [];
  const assertBrowserClean = () => { assert.deepEqual(browserErrors, [], 'no uncaught browser errors'); assert.deepEqual(consoleErrors, [], 'no unexpected browser console errors'); };
  try {
    await waitServer();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    traceStarted = true;
    page.on('pageerror', error => { browserErrors.push(error.message); logs += `\npageerror: ${error.message}`; });
    context.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/') && response.status() >= 400) apiFailures.push({ method: response.request().method(), path: url.pathname, status: response.status() });
    });
    page.on('request', request => {
      if (request.url().includes('/api/') && request.method() === 'POST') sampleWrites.push(request.method() + ' ' + new URL(request.url()).pathname);
    });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (!text.startsWith('Failed to load resource:')) consoleErrors.push(text);
      logs += `\nconsole: ${text}`;
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('#app .shell').waitFor({ timeout: 10000 });

    if (name === '__self-check-pageerror') {
      await page.evaluate(() => setTimeout(() => { throw new Error('synthetic injected browser page error'); }, 0));
      await page.waitForTimeout(50);
      assertBrowserClean();
    }
    if (name === '__self-check-assertion') {
      assert.equal('synthetic expected', 'synthetic actual', 'synthetic injected assertion must fail the browser case');
    }

    if (name === 'sample-isolation') {
      const before = await page.evaluate(async () => fetch('/api/state').then(result => result.json()).then(state => ({ revision: state.revision, snapshots: state.balanceSheetSnapshots.length })));
      await page.getByRole('button', { name: 'Explore sample data' }).click();
      assert.equal(await page.locator('.balance-sheet').count(), 0, 'sample preview does not reveal saved balance-sheet data');
      assert.match(await page.locator('.bank-mini').innerText(), /Sample preview/, 'sample preview labels the synthetic mode');
      await page.locator('[data-view="transactions"]').first().click();
      const category = page.locator('[data-category]').first();
      await category.waitFor();
      await category.selectOption({ label: 'Shopping' });
      await page.waitForTimeout(100);
      assert.deepEqual(sampleWrites, [], 'sample edits never send mutation requests');
      const after = await page.evaluate(async () => fetch('/api/state').then(result => result.json()).then(state => ({ revision: state.revision, snapshots: state.balanceSheetSnapshots.length })));
      assert.deepEqual(after, before, 'sample preview leaves persisted revision and snapshots unchanged');
      assert.deepEqual(browserErrors, [], 'sample isolation has no uncaught browser errors');
      assert.deepEqual(consoleErrors, [], 'sample isolation has no browser console errors');
      await context.tracing.stop();
      traceStarted = false;
      console.log('Browser case passed: sample-isolation (fresh synthetic SQLite; saved state, revision, and snapshots remain unchanged).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if (name === 'sample-transaction-filters') {
      const month=monthInChicago(),start=month+'-20',end=month+'-25',rows=()=>page.locator('#transaction-table tbody tr').count();
      await page.getByRole('button',{name:'Explore sample data'}).click();
      await page.locator('[data-view="transactions"]').first().click();
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===22);
      await page.locator('#category-filter').selectOption({label:'Dining'});
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===4);
      await page.locator('#account-filter').selectOption('credit');
      assert.equal(await rows(),4,'category and account filters combine');
      assert.ok((await page.locator('#transaction-table').innerText()).includes('Rewards Credit'),'all matching rows retain the selected account');
      await page.locator('#clear-transaction-filters').click();
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===22);
      await page.locator('#search').fill('Meijer');
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===2);
      await page.locator('#clear-transaction-filters').click();
      await page.locator('#date-from').fill(start);await page.locator('#date-from').dispatchEvent('change');
      await page.locator('#date-to').fill(end);await page.locator('#date-to').dispatchEvent('change');
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===6);
      await page.locator('#clear-transaction-filters').click();
      await page.locator('#date-from').fill(month+'-30');await page.locator('#date-from').dispatchEvent('change');await page.locator('#date-to').fill(month+'-25');await page.locator('#date-to').dispatchEvent('change');
      await page.getByRole('status').filter({hasText:'Start date must be on or before end date'}).waitFor();assert.equal(await rows(),0,'inverted ranges are empty and explained');await page.locator('#clear-transaction-filters').click();
      await page.locator('#review-only').check();
      await page.waitForFunction(()=>document.querySelectorAll('#transaction-table tbody tr').length===0);
      const reviewDownload=page.waitForEvent('download');await page.locator('#export').click();
      const reviewText=await readFile(await (await reviewDownload).path(),'utf8');
      assert.equal(reviewText.trim().split(/\r?\n/).length,1,'export applies active date and needs-review filters');
      assert.match(reviewText.split(/\r?\n/,1)[0],/Account$/,'export preserves account attribution in its CSV header');
      await page.locator('#clear-transaction-filters').click();
      const sampleDownload=page.waitForEvent('download');await page.locator('#export').click();const sampleText=await readFile(await (await sampleDownload).path(),'utf8');assert.match(sampleText,/^Date,Merchant,Category,Amount,Currency,Status,Account/m);assert.match(sampleText,/Everyday Checking/);assert.match(sampleText,/Rewards Credit/,'sample CSV export retains the account for each source row');
      await page.locator('[data-view="budgets"]').first().click();
      const stop=page.getByRole('button',{name:/Stop future funding/}).first();
      assert.equal(await stop.isDisabled(),true,'sample preview marks stop-funding as unavailable');
      assert.equal(await page.locator('[data-budget-stop]').count(),0,'read-only sample cannot start a live mutation');
      assert.deepEqual(sampleWrites,[],'filtering, export, and read-only budget controls do not mutate saved data');
      await page.locator('[data-exit-demo]').first().click();await page.locator('[data-view="transactions"]').first().click();await page.locator('#import').click();
      const importDialog=page.getByRole('dialog');await importDialog.locator('#csv-file').setInputFiles({name:'account-roundtrip.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Merchant,Amount,Category,Currency,Status,Account\n'+month+'-02,Synthetic checking,12.34,Groceries,USD,Posted,Everyday Checking\n'+month+'-03,Synthetic card,5.67,Dining,USD,Posted,Rewards Credit\n')});
      assert.equal(await importDialog.locator('[name="accountColumn"]').inputValue(),'Account','the Account column is detected automatically');assert.equal(await importDialog.locator('[name="account"]').evaluate(element=>element.required),false,'per-row Account data removes the default-account requirement');
      await importDialog.getByRole('button',{name:'Preview file'}).click();await importDialog.getByText('2 rows · 2 account(s)').waitFor();await importDialog.getByRole('button',{name:'Commit 2 rows'}).click();await importDialog.getByText('2 transactions imported').waitFor();
      const importedAccounts=await page.evaluate(async()=>{const [state,result]=await Promise.all([fetch('/api/state').then(response=>response.json()),fetch('/api/transactions?search=Synthetic').then(response=>response.json())]);return result.transactions.filter(row=>row.merchant.startsWith('Synthetic checking')||row.merchant.startsWith('Synthetic card')).map(row=>({merchant:row.merchant,account:state.accounts.find(account=>account.id===row.accountId)?.name})).sort((a,b)=>a.merchant.localeCompare(b.merchant));});assert.deepEqual(importedAccounts,[{merchant:'Synthetic card',account:'Rewards Credit'},{merchant:'Synthetic checking',account:'Everyday Checking'}],'CSV import preserves each row’s account attribution');
      await importDialog.getByRole('button',{name:'Undo this import'}).click();await importDialog.getByText('This import batch was undone.').waitFor();
      assert.deepEqual(browserErrors,[]);assert.deepEqual(consoleErrors,[]);
      console.log('Browser case passed: sample-transaction-filters (search, category, account, date, review, filtered export, and read-only sample budget action).');return;
    }

    if(name==='operation-reload-recovery'){
      await page.locator('[data-view="accounts"]').first().click();await page.locator('#add-account').click();await page.locator('#add-manual').click();
      const dialog=page.getByRole('dialog');await dialog.locator('#manual-name').fill('Synthetic recovery account');await dialog.locator('#manual-institution').fill('Recovery private marker');await dialog.locator('#manual-balance').fill('88.42');await dialog.locator('#manual-asof').fill(dateInChicago());
      let dropped=0;const committed=[];
      await page.route('**/api/manual-account',async route=>{const upstream=await route.fetch(),body=await upstream.json();committed.push({status:upstream.status(),body});dropped++;await route.abort();});
      await dialog.getByRole('button',{name:'Save account'}).click();await dialog.locator('#manual-error').filter({hasText:'Could not reach Ledger'}).waitFor();
      assert.equal(dropped,2,'both the original response and same-ID replay response are lost after server commit');assert.ok(committed.every(result=>result.status===200));
      const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ledger.pending-operations.v1')||'[]'));
      assert.equal(pending.length,1);assert.deepEqual(Object.keys(pending[0]).sort(),['baseRevision','operationId','scope','startedAt']);assert.equal(pending[0].scope,'manual-account');assert.doesNotMatch(JSON.stringify(pending),/Synthetic recovery account|Recovery private marker|88\.42/,'session storage contains no form or account values');
      const accountId=committed[0].body.account.id;assert.equal(committed[1].body.account.id,accountId,'server replay returns the same account identity');
      await page.unroute('**/api/manual-account');await restartServer();await page.reload();
      await page.locator('.operation-recovery').filter({hasText:'confirmed in Ledger'}).waitFor();
      assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ledger.pending-operations.v1')||'[]').length),0,'confirmed operation metadata is cleared after reload');
      const saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.deepEqual(saved.accounts.filter(account=>account.name==='Synthetic recovery account').map(account=>account.id),[accountId],'reload recovery confirms one committed account after a local server restart');
      const beforeUnknownCheck=sampleWrites.length;await page.evaluate(revision=>sessionStorage.setItem('ledger.pending-operations.v1',JSON.stringify([{operationId:'00000000-0000-4000-8000-000000000777',scope:'manual-account',baseRevision:revision,startedAt:new Date().toISOString()}])),saved.revision);await page.reload();
      await page.locator('.operation-recovery').filter({hasText:'does not prove the save failed'}).waitFor();assert.equal(sampleWrites.length,beforeUnknownCheck,'an unknown status never triggers a new write');assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ledger.pending-operations.v1')||'[]').length),1,'unknown status remains available for explicit resolution');
      page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Clear reference after review'}).click();assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('ledger.pending-operations.v1')||'[]').length),0,'clearing the unknown reference requires an explicit user action');
      assert.deepEqual(browserErrors,[]);assert.deepEqual(consoleErrors,[]);
      console.log('Browser case passed: operation-reload-recovery (two lost responses, page reload, server restart, committed and unknown status handling, minimal session metadata, one confirmed account).');return;
    }

    if(name==='budget-history-controls'){
      const setup=await page.evaluate(async month=>{for(const payload of [{categoryId:'system:groceries',amount:10000,mode:'template',month},{categoryId:'system:groceries',amount:20000,mode:'template',month:'2027-01'},{categoryId:'system:groceries',amount:30000,mode:'month',month:'2027-03'}]){const state=await fetch('/api/state').then(response=>response.json()),response=await fetch('/api/budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,revision:state.revision})});if(!response.ok)throw new Error(await response.text());}return fetch('/api/state').then(response=>response.json());},monthInChicago());
      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${monthInChicago()}`);await page.locator('[data-budget-stop="system:groceries"]').waitFor();
      const revisionBeforeCancel=(await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()))).revision;
      await page.locator('[data-budget-stop="system:groceries"]').click();await page.getByText('2027-01',{exact:false}).waitFor();await page.getByRole('button',{name:'Cancel'}).click();
      assert.equal((await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()))).revision,revisionBeforeCancel,'cancelling the future-funding preview writes nothing');
      await page.locator('[data-budget-stop="system:groceries"]').click();await page.locator('[data-confirm-stop]').click();await page.locator('#toast').filter({hasText:'Future funding stopped'}).waitFor();
      const saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.budgetTemplates.find(row=>row.categoryId==='system:groceries'&&row.effectiveFrom==='2027-01'),undefined);assert.equal(saved.budgetTemplates.find(row=>row.categoryId==='system:groceries'&&row.effectiveFrom===new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit'}).formatToParts(new Date()).find(row=>row.type==='year').value+'-'+new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'2-digit'}).formatToParts(new Date()).find(row=>row.type==='month').value).amount,0);assert.equal(saved.monthlyBudgets['2027-03:system:groceries'],0);
      await page.locator('[data-open-budget-history]').click();await page.getByRole('dialog').getByText('budget-stop-future',{exact:false}).waitFor();assert.ok(await page.locator('[data-history-revert]').count()>0,'the history view exposes an explicit revert action');
      assert.deepEqual(browserErrors,[]);assert.deepEqual(consoleErrors,[]);console.log('Browser case passed: budget-history-controls (audited stop-funding preview, cancellation, application, and history view).');return;
    }

    if(name==='transaction-splits-commitments'){
      const testDate=monthInChicago()+'-12';
      const transaction=await page.evaluate(async testDate=>{const state=await fetch('/api/state').then(response=>response.json()),csv=`Date,Merchant,Amount,Category\n${testDate},Synthetic shared purchase,100.00,Other`;const result=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv,account:'Synthetic split account',revision:state.revision,confirmOverlaps:true})});if(!result.ok)throw new Error(await result.text());return fetch('/api/transactions?page=1&limit=100').then(response=>response.json()).then(saved=>saved.transactions.find(row=>row.merchant==='Synthetic shared purchase'));},testDate);
      assert.ok(transaction?.id);await page.goto(`http://127.0.0.1:${port}/?page=transactions`);const row=page.locator('[data-split-transaction="'+transaction.id+'"]').locator('..').locator('..');await page.locator('[data-split-transaction="'+transaction.id+'"]').click();let dialog=page.getByRole('dialog');await dialog.locator('select[name="categoryId"]').nth(0).selectOption('system:groceries');await dialog.locator('input[name="amount"]').nth(0).fill('60.00');await dialog.locator('select[name="categoryId"]').nth(1).selectOption('system:dining');await dialog.locator('input[name="amount"]').nth(1).fill('40.00');await dialog.getByRole('button',{name:'Save split'}).click();await page.waitForTimeout(100);let saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.transactionSplits[0].allocations.reduce((sum,item)=>sum+item.amount,0),10000);let summary=await page.evaluate(async()=>fetch('/api/budget-summary').then(response=>response.json()));assert.equal(summary.actuals.categories['system:groceries'],6000);assert.equal(summary.actuals.categories['system:dining'],4000);
      await page.locator('[data-split-transaction="'+transaction.id+'"]').click();dialog=page.getByRole('dialog');await dialog.locator('[data-undo-split]').click();await page.waitForTimeout(100);saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.transactionSplits.length,0,'split undo restores unsplit state without changing parent');
      const refund=await page.evaluate(async date=>{const state=await fetch('/api/state').then(response=>response.json()),result=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv:`Date,Merchant,Amount,Category\n${date},Synthetic shared purchase refund,-25.00,Other`,account:'Synthetic split account',revision:state.revision,confirmOverlaps:true})});if(!result.ok)throw new Error(await result.text());return fetch('/api/transactions?search=Synthetic%20shared%20purchase%20refund').then(response=>response.json()).then(value=>value.transactions[0]);},nextMonth(monthInChicago())+'-02');await page.reload();await page.locator('[data-reimbursement="'+transaction.id+'"]').click();dialog=page.getByRole('dialog');await dialog.locator('[name=transactionId]').selectOption(refund.id);await dialog.locator('[name=amount]').fill('25.00');await dialog.locator('[name=confirmed]').check();const reimbursementPromise=page.waitForResponse(response=>response.url().endsWith('/api/transaction-reimbursement'));await dialog.getByRole('button',{name:'Save reimbursement link'}).click();const reimbursementResponse=await reimbursementPromise;assert.equal(reimbursementResponse.status(),200,await reimbursementResponse.text());saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.transactionReimbursements[0].transactionId,refund.id);assert.equal(saved.transactionReimbursements[0].reimbursesTransactionId,transaction.id);await dialog.locator('[data-unlink]').click();await page.waitForFunction(()=>document.querySelector('[data-reimbursement-links]')?.textContent?.includes('Removed'));saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.transactionReimbursements[0].status,'unlinked','the explicit remove action preserves an audited link record');await dialog.getByRole('button',{name:'Cancel'}).click();
      await page.locator('[data-view="commitments"]').first().click();const commitmentForm=page.locator('[data-commitment-create]');await commitmentForm.locator('[name=name]').fill('Synthetic Internet');await commitmentForm.locator('[name=amount]').fill('100.00');await commitmentForm.locator('[name=frequency]').selectOption('monthly');await commitmentForm.locator('[name=startDate]').fill(testDate);await commitmentForm.locator('[name=dayOfMonth]').fill('12');await commitmentForm.getByRole('button',{name:'Save commitment'}).click();await page.waitForTimeout(100);saved=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));assert.equal(saved.commitments.length,1);
      await page.locator('[data-view="transactions"]').first().click();await page.locator('[data-link-commitment="'+transaction.id+'"]').click();dialog=page.getByRole('dialog');await dialog.locator('[name=commitmentId]').selectOption(saved.commitments[0].id);await dialog.locator('[name=dueDate]').selectOption(testDate);await dialog.locator('[name=confirmed]').check();const matchResponsePromise=page.waitForResponse(response=>response.url().includes('/api/commitment-match'));await dialog.getByRole('button',{name:'Confirm match'}).click();const matchResponse=await matchResponsePromise;assert.equal(matchResponse.status(),200,await matchResponse.text());const matchResult=await page.evaluate(async()=>fetch('/api/commitments?from=2026-01-01&to=2027-12-31').then(response=>response.json()));assert.equal(matchResult.matches[0].status,'user-confirmed');const actualRows=await page.evaluate(async()=>fetch('/api/transactions?page=1&limit=20').then(response=>response.json()));assert.equal(actualRows.transactions.find(row=>row.id===transaction.id)?.amount,10000);
      assert.deepEqual(browserErrors,[]);assert.deepEqual(consoleErrors,[]);console.log('Browser case passed: transaction-splits-commitments (UI exact-cent split, audit undo, dated commitment, and explicit payment match).');return;
    }

    if(name==='budget-empty-onboarding'){
      await page.locator('[data-view="budgets"]').first().click();
      await page.locator('.budget-page').waitFor();
      assert.ok(await page.locator('[data-budget="Housing"]').count()>0,'an unused system category must be available for its first budget plan');
      await page.locator('[data-new-category]').first().click();
      await page.locator('#new-category-name').fill('Synthetic blank plan');
      await page.locator('dialog button[type=submit]').click();
      await page.locator('dialog').waitFor({state:'detached'});
      const category=await page.evaluate(async()=>fetch('/api/state').then(r=>r.json()).then(s=>s.categoryCatalog.find(c=>c.name==='Synthetic blank plan')));
      assert.ok(category,'the optional amount still creates the category');
      const edit=page.locator(`[data-budget-id="${category.id}"]`);
      await edit.waitFor({timeout:2000});
      console.log('Browser case passed: budget-empty-onboarding (fresh synthetic SQLite; unused system categories and new blank-plan categories are editable).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='budget-create-month'){
      const selected='2026-09';
      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${selected}`);
      await page.locator('.budget-page').waitFor();
      await page.locator('[data-new-category]').first().click();
      await page.locator('#new-category-name').fill('Synthetic selected-month plan');
      await page.locator('#new-category-limit').fill('100');
      await page.locator('dialog button[type=submit]').click();
      await page.locator('dialog').waitFor({state:'detached'});
      const saved=await page.evaluate(async()=>fetch('/api/state').then(r=>r.json()).then(s=>({category:s.categoryCatalog.find(c=>c.name==='Synthetic selected-month plan'),templates:s.budgetTemplates})));
      const template=saved.templates.find(row=>row.categoryId===saved.category.id);
      assert.equal(template?.effectiveFrom,selected,'new recurring budget starts in the month currently being viewed');
      assert.equal(template?.amount,10000,'the original monthly cents are saved exactly');
      await page.locator('[data-new-category]').first().click();
      await page.locator('#new-category-name').fill('Synthetic month-only plan');
      await page.locator('#new-category-limit').fill('25');
      await page.locator('#new-category-scope').selectOption('month');
      await page.locator('dialog button[type=submit]').click();
      await page.locator('dialog').waitFor({state:'detached'});
      const monthOnly=await page.evaluate(async selected=>fetch('/api/state').then(r=>r.json()).then(s=>{const category=s.categoryCatalog.find(c=>c.name==='Synthetic month-only plan');return{category,amount:s.monthlyBudgets[`${selected}:${category.id}`],template:s.budgetTemplates.some(row=>row.categoryId===category.id)}}),selected);
      assert.equal(monthOnly.amount,2500,'month-only scope saves exact cents in the selected override');
      assert.equal(monthOnly.template,false,'month-only scope does not create a recurring template');
      console.log('Browser case passed: budget-create-month (selected effective month and exact cents persist).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='budget-archive-history'){
      const initial=await page.evaluate(async(month)=>{
        let state=await fetch('/api/state').then(r=>r.json());
        const response=await fetch('/api/category-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic archived plan',amount:10000,itemType:'expense',budgetGroup:'Other',schedule:{frequency:'monthly',dueMonth:null,sourceAmount:10000},revision:state.revision})});
        const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));
        const csv=`Date,Merchant,Amount,Category\n${month}-04,Synthetic review purchase,20.00,Groceries\n`,input={csv,account:'Synthetic review account',columnMapping:{date:'Date',merchant:'Merchant',amount:'Amount',category:'Category'},dateFormat:'YYYY-MM-DD',amountMode:'positive-spending'};
        const previewResponse=await fetch('/api/import-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),preview=await previewResponse.json();if(!previewResponse.ok)throw new Error(JSON.stringify(preview));
        const imported=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,revision:preview.revision,confirmOverlaps:true})});if(!imported.ok)throw new Error(await imported.text());return result;
      },monthInChicago());
      const categoryId=initial.category.id;
      await page.reload();
      await page.locator('.metrics').waitFor();
      const budgetMetric=()=>page.locator('.metric').filter({hasText:'Budget remaining'}).locator('.value');
      await budgetMetric().waitFor();
      const before=await budgetMetric().innerText();
      const archived=await page.evaluate(async(id)=>{
        const state=await fetch('/api/state').then(r=>r.json());
        const response=await fetch('/api/category-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,action:'archive',revision:state.revision})});return{status:response.status,body:await response.json()};
      },categoryId);
      assert.equal(archived.status,200);
      await page.reload();
      await page.locator('.metrics').waitFor();
      assert.equal(await budgetMetric().innerText(),before,'archiving a category must not rewrite historical budget totals');
      await page.locator('[data-view="budgets"]').first().click();
      await page.locator(`[data-budget-id="${categoryId}"]`).waitFor();
      console.log('Browser case passed: budget-archive-history (archive preserves the same planned balance in Overview and Budgets).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='accessibility-tree'){
      const month=monthInChicago(),date=month+'-05',seed=await page.evaluate(async({month,date})=>{
        const csv=`Date,Merchant,Amount,Category\n${date},Synthetic accessibility row,12.34,Groceries\n`,base={csv,account:'Synthetic accessibility account',columnMapping:{date:'Date',merchant:'Merchant',amount:'Amount',category:'Category'},dateFormat:'YYYY-MM-DD',amountMode:'positive-spending'};
        const previewResponse=await fetch('/api/import-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(base)}),preview=await previewResponse.json();if(!previewResponse.ok)throw new Error(JSON.stringify(preview));
        const importResponse=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...base,revision:preview.revision,confirmOverlaps:true})}),importResult=await importResponse.json();if(!importResponse.ok)throw new Error(JSON.stringify(importResult));
        const budgetResponse=await fetch('/api/budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({categoryId:'system:groceries',amount:10000,mode:'template',month,schedule:{frequency:'monthly',dueMonth:null},revision:importResult.revision})}),budgetResult=await budgetResponse.json();if(!budgetResponse.ok)throw new Error(JSON.stringify(budgetResult));
        return{imported:importResult.imported,budgetAmount:budgetResult.amount};
      },{month,date});
      assert.equal(seed.imported,1,'the accessibility-tree fixture contains one synthetic transaction');assert.equal(seed.budgetAmount,10000,'the accessibility-tree fixture has one planned budget bucket');
      const accessibility=await context.newCDPSession(page);await accessibility.send('Accessibility.enable');
      const snapshot=async label=>{
        const {nodes}=await accessibility.send('Accessibility.getFullAXTree'),roles=nodes.map(node=>node.role?.value).filter(Boolean),names=nodes.map(node=>node.name?.value).filter(Boolean);
        return{label,roles:[...new Set(roles)].sort(),names};
      };
      const pageSnapshots=[];
      for(const view of ['overview','transactions','budgets','accounts','investments','goals','home','settings']){
        await page.locator(`[data-view="${view}"]`).first().click();await page.waitForTimeout(100);
        const tree=await snapshot(view);pageSnapshots.push(tree);
        assert.ok(tree.roles.includes('main'),`${view} exposes a main landmark in Chromium's accessibility tree`);
        assert.ok(tree.roles.includes('navigation'),`${view} exposes main navigation in Chromium's accessibility tree`);
        assert.ok(tree.roles.includes('heading'),`${view} exposes headings in Chromium's accessibility tree`);
      }
      const transactionTree=pageSnapshots.find(tree=>tree.label==='transactions');
      assert.ok(transactionTree.roles.includes('table')&&transactionTree.roles.includes('row')&&transactionTree.roles.includes('cell'),`Transactions row/cell semantics appear in the accessibility tree: ${transactionTree.roles.join(', ')}`);
      const budgetTree=pageSnapshots.find(tree=>tree.label==='budgets');
      assert.ok(budgetTree.roles.includes('table')&&budgetTree.roles.includes('row')&&budgetTree.roles.includes('cell'),`Budgets row/cell semantics appear in the accessibility tree: ${budgetTree.roles.join(', ')}`);

      await page.locator('[data-view="budgets"]').first().click();await page.locator('[data-new-category]').first().click();
      let dialogTree=await snapshot('category-create-dialog');
      assert.ok(dialogTree.roles.includes('dialog')&&dialogTree.roles.includes('textbox')&&dialogTree.roles.includes('button'),'category creation exposes a named dialog, textbox, and buttons in the accessibility tree');
      assert.ok(dialogTree.names.some(value=>value.includes('New budget bucket')),'category creation dialog name is present in the accessibility tree');
      await page.keyboard.press('Escape');
      await page.locator('[data-view="transactions"]').first().click();await page.locator('#import').click();
      dialogTree=await snapshot('import-dialog');
      assert.ok(dialogTree.roles.includes('dialog')&&dialogTree.roles.includes('textbox')&&dialogTree.roles.includes('button'),'CSV import exposes a dialog and operable controls in the accessibility tree');
      assert.ok(dialogTree.names.some(value=>value.includes('Preview transaction import')),'CSV import dialog name is present in the accessibility tree');
      await page.keyboard.press('Escape');
      assert.deepEqual(browserErrors,[],'accessibility-tree inspection has no browser errors');assert.deepEqual(consoleErrors,[],'accessibility-tree inspection has no console errors');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: accessibility-tree (Chromium AX roles and names verified for all eight views, transaction/budget rows and cells, and category/import dialogs).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if (name === 'form-drafts') {
      async function assertReplaySafeFailure(path, status, contentType, alert, verifyDraft, closeAfter=true) {
        const seen=[];
        await page.route(`**/api/${path}`,async route=>{
          seen.push(route.request().postDataJSON());
          const body=status===502?'<html><body>synthetic gateway error</body></html>':JSON.stringify({error:'Synthetic server failure.'});
          await route.fulfill({status,contentType,body});
        });
        await page.getByRole('dialog').getByRole('button',{name:/Save|Create/}).click();
        await alert.waitFor();
        await verifyDraft();
        assert.equal(await page.getByRole('dialog').evaluate(dialog=>dialog.contains(document.activeElement)),true,`${path} keeps keyboard focus inside the open form after failure`);
        assert.equal(seen.length,2,`${path} retries one ambiguous server failure exactly once`);
        assert.ok(seen[0].clientOperationId,'replay-safe form submits carry a stable operation ID');
        assert.equal(seen[1].clientOperationId,seen[0].clientOperationId,`${path} reuses its operation ID for the retry`);
        assert.deepEqual(seen[1],seen[0],`${path} retries the identical payload`);
        await page.unroute(`**/api/${path}`);
        if(closeAfter)await page.keyboard.press('Escape');
      }

      await page.locator('[data-view="budgets"]').first().click();
      if(await page.locator('form[data-budget]').count()===0){
        await page.locator('[data-new-category]').first().click();const setupDialog=page.getByRole('dialog');
        await setupDialog.locator('#new-category-name').fill('Synthetic form draft budget');await setupDialog.locator('#new-category-limit').fill('50');
        await setupDialog.getByRole('button',{name:'Create bucket'}).click();await page.locator('form[data-budget]').first().waitFor();
      }
      const budgetForm=page.locator('form[data-budget]').first();await budgetForm.waitFor();
      const budgetCategoryId=await budgetForm.getAttribute('data-budget-id');
      await budgetForm.locator('[data-budget-edit]').click();
      await budgetForm.locator('input[name="amount"]').fill('44');
      await budgetForm.locator('select[name="mode"]').selectOption('template');
      await budgetForm.locator('select[name="frequency"]').selectOption('annual');
      await budgetForm.locator('select[name="dueMonth"]').selectOption(String(Number(monthInChicago().slice(5))));
      await page.route('**/api/budget',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic stale budget conflict.'})}));
      await budgetForm.locator('button[type="submit"]').click();
      const budgetAfterConflict=page.locator(`form[data-budget-id="${budgetCategoryId}"]`);
      await budgetAfterConflict.locator('[data-budget-error]').filter({hasText:'Synthetic stale budget conflict'}).waitFor();
      assert.equal(await budgetAfterConflict.locator('input[name="amount"]').inputValue(),'44','budget conflict retains the amount');
      assert.equal(await budgetAfterConflict.locator('select[name="mode"]').inputValue(),'template','budget conflict retains the plan scope');
      assert.equal(await budgetAfterConflict.locator('select[name="frequency"]').inputValue(),'annual','budget conflict retains schedule frequency');
      assert.equal(await budgetAfterConflict.locator('select[name="dueMonth"]').inputValue(),String(Number(monthInChicago().slice(5))),'budget conflict retains due month');
      assert.equal(await budgetAfterConflict.locator('input[name="amount"]').evaluate(field=>document.activeElement===field),true,'budget conflict returns focus to the edited amount');
      await page.unroute('**/api/budget');

      const renameSetup=await page.evaluate(async()=>{const state=await fetch('/api/state').then(response=>response.json()),response=await fetch('/api/category-create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic rename draft category',revision:state.revision})});return{status:response.status,body:await response.json()};});
      assert.equal(renameSetup.status,200,JSON.stringify(renameSetup.body));
      await page.reload();await page.locator('#app .shell').waitFor();await page.locator('[data-view="budgets"]').first().click();
      const renameForm=page.locator(`[data-category-edit="${renameSetup.body.category.id}"]`),renameField=renameForm.locator('[name="name"]');
      await renameField.waitFor();await renameField.fill('Retained category rename draft');
      const renameOperationIds=[];
      await page.route('**/api/category-update',async route=>{renameOperationIds.push(route.request().postDataJSON().clientOperationId);await route.abort();});
      await renameForm.getByRole('button',{name:'Rename',exact:true}).click();
      await page.waitForFunction(({id,value})=>{const field=document.getElementById(id);return field?.value===value&&document.activeElement===field;},{id:`category-name-${renameSetup.body.category.id}`,value:'Retained category rename draft'});
      assert.equal(renameOperationIds.length,2,'category rename retries once after a network error');
      assert.match(renameOperationIds[0],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,'category rename sends a stable operation ID');
      assert.equal(renameOperationIds[1],renameOperationIds[0],'category rename retry reuses its operation ID');
      assert.equal(await renameField.inputValue(),'Retained category rename draft','category rename keeps its draft after a network error');
      assert.equal(await renameField.evaluate(field=>document.activeElement===field),true,'category rename restores focus after rerender');
      const renamePersisted=await page.evaluate(async id=>fetch('/api/state').then(response=>response.json()).then(state=>state.categoryCatalog.find(row=>row.id===id).name),renameSetup.body.category.id);
      assert.equal(renamePersisted,'Synthetic rename draft category','a request lost before delivery does not rename the saved category');
      await page.unroute('**/api/category-update');

      const incomeForm=page.locator('[data-income-plan]');await incomeForm.locator('[name="amount"]').fill('7100');await incomeForm.locator('[name="mode"]').selectOption('template');
      await page.route('**/api/income-plan',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic stale income conflict.'})}));
      await incomeForm.locator('button[type="submit"]').click();
      const incomeAfterConflict=page.locator('[data-income-plan]');await incomeAfterConflict.locator('[data-income-error]').filter({hasText:'Synthetic stale income conflict'}).waitFor();
      assert.equal(await incomeAfterConflict.locator('[name="amount"]').inputValue(),'7100','income conflict retains the entered plan');assert.equal(await incomeAfterConflict.locator('[name="mode"]').inputValue(),'template','income conflict retains recurring scope');await page.unroute('**/api/income-plan');
      assert.equal(await incomeAfterConflict.locator('[name="amount"]').evaluate(field=>document.activeElement===field),true,'income conflict returns focus to the projected-income field');

      await page.locator('.budget-outlook summary').click();
      const outlookForm=page.locator('[data-budget-outlook]');await outlookForm.locator('[name="income"]').fill('145');
      const expenseExpectation=outlookForm.locator('input[name^="expense:"]').first();await expenseExpectation.fill('22');
      await page.route('**/api/budget-outlook',route=>route.fulfill({status:502,contentType:'text/html',body:'<html><body>synthetic gateway error</body></html>'}));
      await outlookForm.locator('button[type="submit"]').click();
      const outlookAfterFailure=page.locator('[data-budget-outlook]');await outlookAfterFailure.locator('[data-outlook-error]').filter({hasText:'Ledger could not complete'}).waitFor();
      assert.equal(await outlookAfterFailure.locator('[name="income"]').inputValue(),'145','outlook network failure retains the income expectation');
      assert.equal(await outlookAfterFailure.locator('input[name^="expense:"]').first().inputValue(),'22','outlook network failure retains the expense expectation');
      assert.equal(await outlookAfterFailure.locator('[name="income"]').evaluate(field=>document.activeElement===field),true,'outlook failure returns focus to its income expectation');
      assert.equal(await outlookAfterFailure.evaluate(form=>form.closest('details')?.open),true,'outlook failure leaves the draft and error visible in its expanded section');await page.unroute('**/api/budget-outlook');

      await page.locator('[data-view="transactions"]').first().click();await page.locator('#import').click();
      let importDialog=page.getByRole('dialog');await importDialog.locator('#import-account').fill('Synthetic failed import');
      await importDialog.locator('#csv-file').setInputFiles({name:'synthetic-draft.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Merchant,Amount,Category\n2026-10-03,Synthetic row,12.34,Groceries\n')});
      await page.route('**/api/import-preview',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic import preview failure.'})}));
      await importDialog.getByRole('button',{name:'Preview file'}).click();await importDialog.locator('#import-error').filter({hasText:'Synthetic import preview failure'}).waitFor();
      assert.equal(await importDialog.locator('#import-account').inputValue(),'Synthetic failed import','failed preview keeps the import account name');
      assert.equal(await importDialog.locator('#csv-file').evaluate(input=>input.files?.[0]?.name),'synthetic-draft.csv','failed preview keeps the selected file');
      assert.equal(await importDialog.locator('[name="dateColumn"]').inputValue(),'Date','failed preview keeps detected column mappings');
      assert.equal(await importDialog.locator('[name="amountMode"]').inputValue(),'positive-spending','failed preview keeps the amount convention');
      await page.unroute('**/api/import-preview');
      await importDialog.getByRole('button',{name:'Preview file'}).click();await importDialog.locator('#import-preview').waitFor();
      await importDialog.getByRole('button',{name:'Commit 1 rows'}).click();await page.getByText('1 transactions imported',{exact:false}).waitFor();
      await page.keyboard.press('Escape');await page.locator('[data-view="transactions"]').first().click();
      const importedRow=page.locator('#transaction-table tr').filter({hasText:'Synthetic row'}),categorySelect=importedRow.locator('[data-category]');await categorySelect.waitFor();
      await page.route('**/api/category',route=>route.abort());await categorySelect.selectOption({label:'Shopping'});
      await page.locator('#toast').filter({hasText:'category change(s) failed'}).waitFor();await page.unroute('**/api/category');
      assert.equal(await page.locator('#transaction-table tr').filter({hasText:'Synthetic row'}).locator('[data-category]').inputValue(),'system:groceries','a failed transaction-category save does not appear successful or change the saved category');

      await page.locator('[data-new-category]').first().click();
      let dialog=page.getByRole('dialog');
      await dialog.locator('#new-category-name').fill('Retained synthetic bucket');
      await dialog.locator('#new-category-limit').fill('37.50');
      await dialog.locator('#new-category-frequency').selectOption('annual');
      await dialog.locator('#new-category-due-month').selectOption(String(Number(monthInChicago().slice(5))));
      await assertReplaySafeFailure('category-create',500,'application/json',dialog.locator('#category-error').filter({hasText:'Synthetic server failure'}),async()=>{
        assert.equal(await dialog.locator('#new-category-name').inputValue(),'Retained synthetic bucket');
        assert.equal(await dialog.locator('#new-category-limit').inputValue(),'37.50');
        assert.equal(await dialog.locator('#new-category-frequency').inputValue(),'annual');
        assert.equal(await dialog.locator('#new-category-due-month').inputValue(),String(Number(monthInChicago().slice(5))));
      });

      await page.locator('[data-view="accounts"]').first().click();
      await page.locator('#add-account').click();
      await page.getByRole('dialog').locator('#add-manual').click();
      dialog=page.getByRole('dialog');
      await dialog.locator('#manual-name').fill('Retained synthetic account');
      await dialog.locator('#manual-institution').fill('Synthetic institution');
      await dialog.locator('#manual-balance').fill('845.12');
      await dialog.locator('#manual-asof').fill(dateInChicago());
      await dialog.locator('#manual-notes').fill('Retained account notes');
      await assertReplaySafeFailure('manual-account',500,'application/json',dialog.locator('#manual-error').filter({hasText:'Synthetic server failure'}),async()=>{
        assert.equal(await dialog.locator('#manual-name').inputValue(),'Retained synthetic account');
        assert.equal(await dialog.locator('#manual-institution').inputValue(),'Synthetic institution');
        assert.equal(await dialog.locator('#manual-balance').inputValue(),'845.12');
        assert.equal(await dialog.locator('#manual-notes').inputValue(),'Retained account notes');
      });

      await page.locator('[data-view="goals"]').first().click();
      await page.locator('#new-goal').click();
      dialog=page.getByRole('dialog');
      await dialog.locator('#goal-name').fill('Retained synthetic goal');
      await dialog.locator('#goal-target').fill('8400');
      await dialog.locator('#goal-date').fill('2027-12-31');
      await assertReplaySafeFailure('goal',502,'text/html',dialog.getByRole('alert').filter({hasText:'Ledger could not complete'}),async()=>{
        assert.equal(await dialog.locator('#goal-name').inputValue(),'Retained synthetic goal');
        assert.equal(await dialog.locator('#goal-target').inputValue(),'8400');
        assert.equal(await dialog.locator('#goal-date').inputValue(),'2027-12-31');
      });

      const currentState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const propertyResponse=await page.evaluate(async revision=>fetch('/api/property',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic property for form recovery',address:'Synthetic address',ownershipBps:10000,valuation:null,revision})}).then(response=>response.json()),currentState.revision);
      assert.ok(propertyResponse.property?.id,'synthetic setup creates a property for the mortgage form case');
      await page.reload();
      await page.locator('[data-view="home"]').first().click();
      await page.locator(`[data-edit-property="${propertyResponse.property.id}"]`).click();
      dialog=page.getByRole('dialog');
      await dialog.locator('[name="name"]').fill('Retained edited property');
      await dialog.locator('[name="address"]').fill('Retained synthetic address');
      await dialog.locator('[name="valuation"]').fill('321000');
      await dialog.locator('[name="valuationAsOf"]').fill(dateInChicago());
      await assertReplaySafeFailure('property',500,'application/json',dialog.getByRole('alert').filter({hasText:'Synthetic server failure'}),async()=>{
        assert.equal(await dialog.locator('[name="name"]').inputValue(),'Retained edited property');
        assert.equal(await dialog.locator('[name="address"]').inputValue(),'Retained synthetic address');
        assert.equal(await dialog.locator('[name="valuation"]').inputValue(),'321000');
      });

      await page.locator(`[data-new-mortgage="${propertyResponse.property.id}"]`).click();
      dialog=page.getByRole('dialog');
      await dialog.locator('[name="lender"]').fill('Retained synthetic lender');
      await dialog.locator('[name="loanType"]').selectOption('fixed');
      await dialog.locator('[name="balance"]').fill('240000');
      await dialog.locator('[name="balanceAsOf"]').fill(dateInChicago());
      await assertReplaySafeFailure('mortgage',502,'text/html',dialog.getByRole('alert').filter({hasText:'Ledger could not complete'}),async()=>{
        assert.equal(await dialog.locator('[name="lender"]').inputValue(),'Retained synthetic lender');
        assert.equal(await dialog.locator('[name="balance"]').inputValue(),'240000');
        assert.equal(await dialog.locator('[name="balanceAsOf"]').inputValue(),dateInChicago());
      });

      await page.locator('#new-scenario').click();
      dialog=page.getByRole('dialog');
      await dialog.locator('[name="name"]').fill('Retained synthetic scenario');
      await dialog.locator('[name="purchasePrice"]').fill('250000');
      await dialog.locator('[name="downPayment"]').fill('25000');
      await dialog.locator('[name="termMonths"]').fill('360');
      await dialog.locator('[name="noteRatePercent"]').fill('6.5');
      while(await dialog.locator('details:not([open]) > summary').count())await dialog.locator('details:not([open]) > summary').first().click();
      for(const field of ['financedFees','propertyTaxMonthly','homeownersInsuranceMonthly','supplementaryInsuranceMonthly','hoaMonthly','maintenanceReserveMonthly','subordinateDebtMonthly','closingCosts','prepaids','credits','earnestPaid','movingCosts','initialRepairs','retainedReserve','pointsCents'])await dialog.locator(`[name="${field}"]`).fill('0');
      await dialog.locator('[name="pmiExplicitNone"]').check();
      await assertReplaySafeFailure('scenario',500,'application/json',dialog.getByRole('alert').filter({hasText:'Synthetic server failure'}),async()=>{
        assert.equal(await dialog.locator('[name="name"]').inputValue(),'Retained synthetic scenario');
        assert.equal(await dialog.locator('[name="purchasePrice"]').inputValue(),'250000');
        assert.equal(await dialog.locator('[name="downPayment"]').inputValue(),'25000');
        assert.equal(await dialog.locator('[name="retainedReserve"]').inputValue(),'0');
        assert.equal(await dialog.locator('[name="pmiExplicitNone"]').isChecked(),true);
      },false);

      let duplicateSubmitRequests=0;
      await page.route('**/api/scenario',async route=>{duplicateSubmitRequests++;await new Promise(resolvePromise=>setTimeout(resolvePromise,150));await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic stale revision conflict.'})});});
      const scenarioForm=dialog.locator('form');
      await scenarioForm.locator('[name="name"]').focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');
      await dialog.getByRole('alert').filter({hasText:'Synthetic stale revision conflict'}).waitFor();
      assert.equal(duplicateSubmitRequests,1,'two concurrent submissions of the same scenario payload produce one request');
      assert.equal(await dialog.locator('[name="name"]').inputValue(),'Retained synthetic scenario','the conflicted double-submit keeps its draft');
      await page.unroute('**/api/scenario');
      await page.keyboard.press('Escape');

      assert.deepEqual(browserErrors,[],'form retries and preserved drafts have no uncaught browser errors');
      assert.deepEqual(consoleErrors,[],'form retries and preserved drafts have no browser console errors');
      let setupState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const allocationAccount=await page.evaluate(async input=>fetch('/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic allocation cash',type:'depository',subtype:'checking',balance:100000,asOf:input.asOf,currency:'USD',includeInReporting:true,revision:input.revision})}).then(response=>response.json()),{revision:setupState.revision,asOf:dateInChicago()});
      assert.ok(allocationAccount.account?.id,'synthetic setup creates eligible cash for the allocation-dialog case');
      setupState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const allocationGoal=await page.evaluate(async revision=>fetch('/api/goal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic allocation draft goal',target:50000,targetDate:'2027-12-31',priority:1,monthlyContribution:0,apyBps:0,revision})}).then(response=>response.json()),setupState.revision);
      assert.ok(allocationGoal.goal?.id,'synthetic setup creates an active goal for the allocation-dialog case');
      await page.reload();await page.locator('[data-view="goals"]').first().click();
      await page.locator(`[data-allocate-goal="${allocationGoal.goal.id}"]`).click();
      const allocationForm=page.getByRole('dialog');await allocationForm.locator('[data-allocation-account]').fill('25');
      await page.route('**/api/goal-allocations',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic allocation conflict.'})}));
      await allocationForm.getByRole('button',{name:'Save allocations'}).click();
      await allocationForm.getByRole('alert').filter({hasText:'Synthetic allocation conflict'}).waitFor();
      assert.equal(await allocationForm.locator('[data-allocation-account]').inputValue(),'25','allocation conflict retains the proposed amount');
      assert.equal(await allocationForm.evaluate(dialog=>dialog.contains(document.activeElement)),true,'allocation conflict keeps keyboard focus inside its dialog');await page.unroute('**/api/goal-allocations');
      await allocationForm.locator('#cancel-allocation').click();
      await page.locator('[data-view="transactions"]').first().click();
      await page.locator('#search').fill('Synthetic row');
      const importedBulkRow=page.locator('#transaction-table tr').filter({hasText:'Synthetic row'});await importedBulkRow.waitFor();
      await importedBulkRow.locator('[data-select-transaction]').check();
      await page.locator('#bulk-category').selectOption('system:shopping');
      const beforeBulkConflict=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20row').then(response=>response.json()).then(result=>result.transactions[0]));
      await page.route('**/api/category-bulk',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Synthetic bulk category conflict.'})}));
      await page.locator('#apply-bulk-category').click();
      await page.locator('#toast').filter({hasText:'Synthetic bulk category conflict'}).waitFor();
      assert.equal(await page.locator('[data-select-transaction]').count(),1,'a failed bulk edit keeps the selected transaction');
      assert.equal(await page.locator('#bulk-category').inputValue(),'system:shopping','a failed bulk edit keeps the chosen category');
      assert.equal(await page.locator('#apply-bulk-category').evaluate(button=>document.activeElement===button),true,'bulk-category conflict returns focus to its apply control');
      const afterBulkConflict=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20row').then(response=>response.json()).then(result=>result.transactions[0]));
      assert.deepEqual(afterBulkConflict,beforeBulkConflict,'a rejected bulk category edit changes no transaction');
      await page.unroute('**/api/category-bulk');
      assert.deepEqual(apiFailures.map(row=>row.status),[409,409,502,502,500,500,500,500,500,502,502,500,500,502,502,500,500,409,409,409],'only injected synthetic conflicts and server failures reach the browser, including both replay-safe outlook attempts');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: form-drafts (budget, income, outlook, import, category, bulk, account, goal, property, mortgage, and scenario drafts survive injected failures; retries reuse one operation ID and concurrent submits deduplicate).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='form-cancel'){
      async function create(path,input){const state=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));const result=await page.evaluate(async value=>{const response=await fetch('/api/'+value.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value.input,revision:value.revision})});return{status:response.status,body:await response.json()};},{path,input,revision:state.revision});assert.equal(result.status,200,`${path} synthetic setup: ${JSON.stringify(result.body)}`);return result.body;}
      const today=dateInChicago();
      const account=(await create('manual-account',{name:'Synthetic cancel cash',type:'depository',subtype:'checking',balance:500000,currency:'USD',asOf:today,includeInReporting:true})).account;
      const goal=(await create('goal',{name:'Synthetic cancel goal',target:100000,targetDate:'2027-12-31',priority:1,monthlyContribution:0,apyBps:0})).goal;
      const property=(await create('property',{name:'Synthetic cancel property',address:'',ownershipBps:10000,valuation:null})).property;
      const mortgage=(await create('mortgage',{propertyId:property.id,lender:'Synthetic cancel lender',loanType:'other',statementBalance:2000000,balanceAsOf:today,originalPrincipal:null,originationDate:null,annualRatePercent:'',termMonths:null,components:{}})).mortgage;
      await page.reload();
      const writesBeforeCancellation=sampleWrites.length;
      const baseline=await page.evaluate(async()=>{const state=await fetch('/api/state').then(response=>response.json());return{revision:state.revision,accounts:state.accounts.map(row=>row.id),goals:state.goals.map(row=>row.id),properties:state.properties.map(row=>row.id),mortgages:(state.mortgages||[]).map(row=>row.id),scenarios:(state.scenarios||[]).map(row=>row.id),categories:state.categoryCatalog.map(row=>row.id)};});
      async function cancelByButton(open,button){await open();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.locator(button).click();await dialog.waitFor({state:'detached'});}
      async function dismissConfirmation(trigger,expected){let message='';page.once('dialog',async dialog=>{message=dialog.message();await dialog.dismiss();});await trigger();assert.match(message,expected,'the canceled confirmation describes its action');}
      await page.locator('[data-view="transactions"]').first().click();
      await cancelByButton(()=>page.locator('#import').click(),'#cancel-import');
      await cancelByButton(()=>page.locator('[data-new-category]').first().click(),'#cancel-category');
      await page.locator('[data-view="accounts"]').first().click();
      await page.locator('#add-account').click();await page.getByRole('dialog').locator('#add-manual').click();
      await cancelByButton(async()=>{},'#cancel-manual');
      await page.locator(`[data-edit-manual="${account.id}"]`).click();
      await cancelByButton(async()=>{},'#cancel-manual');
      await dismissConfirmation(()=>page.locator(`[data-archive-account="${account.id}"]`).click(),/Archive Synthetic cancel cash/);
      await page.locator('[data-view="goals"]').first().click();
      await cancelByButton(()=>page.locator('#new-goal').click(),'#cancel-goal');
      await page.locator(`[data-edit-goal="${goal.id}"]`).click();
      await cancelByButton(async()=>{},'#cancel-goal');
      await dismissConfirmation(()=>page.locator(`[data-archive-goal="${goal.id}"]`).click(),/Archive.*Synthetic cancel goal/);
      await page.locator(`[data-allocate-goal="${goal.id}"]`).click();
      const allocationDialog=page.getByRole('dialog');await allocationDialog.locator('[data-allocation-account]').fill('12.34');
      await allocationDialog.locator('#cancel-allocation').click();await allocationDialog.waitFor({state:'detached'});
      await page.locator('[data-view="home"]').first().click();
      await cancelByButton(()=>page.locator('#new-property').click(),'[data-close]');
      await page.locator(`[data-edit-property="${property.id}"]`).click();
      await cancelByButton(async()=>{},'[data-close]');
      await dismissConfirmation(()=>page.locator(`[data-archive-property="${property.id}"]`).click(),/Archive Synthetic cancel property/);
      await page.locator(`[data-new-mortgage="${property.id}"]`).click();
      await cancelByButton(async()=>{},'[data-close]');
      await page.locator(`[data-edit-mortgage="${mortgage.id}"]`).click();
      await cancelByButton(async()=>{},'[data-close]');
      await dismissConfirmation(()=>page.locator(`[data-archive-mortgage="${mortgage.id}"]`).click(),/Archive this mortgage record/);
      await cancelByButton(()=>page.locator('#new-scenario').click(),'[data-close]');
      const result=await page.evaluate(async()=>{const state=await fetch('/api/state').then(response=>response.json());return{revision:state.revision,accounts:state.accounts.map(row=>row.id),goals:state.goals.map(row=>row.id),properties:state.properties.map(row=>row.id),mortgages:(state.mortgages||[]).map(row=>row.id),scenarios:(state.scenarios||[]).map(row=>row.id),categories:state.categoryCatalog.map(row=>row.id)};});
      assert.deepEqual(result,baseline,'cancelled forms leave persisted records and the revision unchanged');
      assert.deepEqual(sampleWrites.slice(writesBeforeCancellation),[],'opening and cancelling forms sends no mutation requests');
      assert.deepEqual(result.accounts,[account.id]);assert.deepEqual(result.goals,[goal.id]);assert.deepEqual(result.properties,[property.id]);
      assert.deepEqual(browserErrors,[],'form cancellation has no uncaught browser errors');assert.deepEqual(consoleErrors,[],'form cancellation has no browser console errors');
      assert.deepEqual(apiFailures,[],'form cancellation causes no API failures');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: form-cancel (import, category, account, goal, allocation, property, mortgage, and scenario create/edit dialogs close without a mutation or revision change).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='refresh-edit'){
      const today=dateInChicago(),month=monthInChicago();
      await page.goto(`http://127.0.0.1:${port}/?page=accounts`);await page.locator('#add-account').waitFor();
      let refreshStateStartedResolve;const refreshStateStarted=new Promise(resolvePromise=>refreshStateStartedResolve=resolvePromise);let releaseRefreshState;const refreshStateGate=new Promise(resolvePromise=>releaseRefreshState=resolvePromise);let delayNextState=true;
      await page.route('**/api/state',async route=>{if(delayNextState&&route.request().method()==='GET'){delayNextState=false;const response=await route.fetch();refreshStateStartedResolve();await refreshStateGate;await route.fulfill({response});}else await route.continue();});
      await page.locator('#add-account').click();await page.getByRole('dialog').locator('#add-manual').click();
      let dialog=page.getByRole('dialog');await dialog.locator('#manual-name').fill('Synthetic refresh race saved');await dialog.locator('#manual-balance').fill('125.00');await dialog.locator('#manual-asof').fill(today);
      const saveResponse=page.waitForResponse(response=>response.url().endsWith('/api/manual-account')&&response.request().method()==='POST');
      await dialog.getByRole('button',{name:'Save account'}).click();assert.equal((await saveResponse).status(),200,'the first synthetic account save succeeds before its refresh');
      await refreshStateStarted;
      await page.locator('#add-account').click();await page.getByRole('dialog').locator('#add-manual').click();
      dialog=page.getByRole('dialog');await dialog.locator('#manual-name').fill('Unsaved draft during refresh');await dialog.locator('#manual-institution').fill('Keep this draft');await dialog.locator('#manual-balance').fill('987.65');await dialog.locator('#manual-asof').fill(today);
      const summaryResponse=page.waitForResponse(response=>response.url().includes('/api/month-summary?month='+encodeURIComponent(month))&&response.request().method()==='GET');
      releaseRefreshState();await summaryResponse;
      await page.locator('#add-account').waitFor();
      assert.equal(await page.getByRole('dialog').locator('#manual-name').inputValue(),'Unsaved draft during refresh','a completed snapshot refresh preserves an open account draft');
      assert.equal(await page.getByRole('dialog').locator('#manual-institution').inputValue(),'Keep this draft');
      assert.equal(await page.getByRole('dialog').locator('#manual-balance').inputValue(),'987.65');
      const state=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.deepEqual(state.accounts.filter(account=>account.name==='Synthetic refresh race saved').map(account=>account.balance),[12500],'the committed save remains visible exactly once');
      assert.equal(state.accounts.some(account=>account.name==='Unsaved draft during refresh'),false,'the unsaved draft is not persisted by the refresh');
      await page.unroute('**/api/state');
      assert.deepEqual(apiFailures,[],'refresh during editing has no API failures');assert.deepEqual(browserErrors,[],'refresh during editing has no uncaught browser errors');assert.deepEqual(consoleErrors,[],'refresh during editing has no browser console errors');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: refresh-edit (a delayed successful refresh preserves a separate open form draft and does not persist it).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='operation-restart'){
      const assertCommittedReplayAfterRestart=async(path,input,label)=>{
        let committed=null;
        await page.route(`**/api/${path}`,async route=>{const upstream=await route.fetch();committed={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();});
        const attempt=await page.evaluate(async({path,input})=>{try{const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{networkError:false,status:response.status};}catch{return{networkError:true};}},{path,input});
        assert.deepEqual(attempt,{networkError:true},label+' response is lost after commit');
        await page.unroute(`**/api/${path}`);
        assert.equal(committed?.status,200,label+' committed before restart');
        const replay=await page.evaluate(async({path,input})=>{const response=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},{path,input});
        assert.equal(replay.status,200,JSON.stringify(replay.body));
        assert.deepEqual(replay.body,committed.body,label+' returns the original result after restart');
        return committed.body;
      };
      const state=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const payload=await page.evaluate(input=>({clientOperationId:crypto.randomUUID(),name:'Synthetic uncertain account',institution:'Synthetic institution',type:'depository',subtype:'checking',balance:48123,asOf:input.asOf,currency:'USD',includeInReporting:true,notes:'Idempotency replay across restart',revision:input.revision}),{revision:state.revision,asOf:dateInChicago()});
      let upstreamResult=null;
      await page.route('**/api/manual-account',async route=>{const upstream=await route.fetch();upstreamResult={status:upstream.status(),body:await upstream.json()};await route.abort();});
      const firstAttempt=await page.evaluate(async input=>{try{const response=await fetch('/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{networkError:false,status:response.status};}catch{return{networkError:true};}},payload);
      assert.deepEqual(firstAttempt,{networkError:true},'the synthetic client loses the committed response');
      assert.equal(upstreamResult?.status,200,'the server committed the create before the response was dropped');
      assert.ok(upstreamResult.body.account?.id,'the committed result contains a stable account ID');
      await page.unroute('**/api/manual-account');
      let savedState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.deepEqual(savedState.accounts.filter(account=>account.name===payload.name).map(account=>account.id),[upstreamResult.body.account.id],'the uncertain create persisted exactly once before restart');
      await restartServer();
      const replay=await page.evaluate(async input=>{const response=await fetch('/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},payload);
      assert.equal(replay.status,200,JSON.stringify(replay.body));assert.deepEqual(replay.body,upstreamResult.body,'replaying after a server restart returns the original result');
      savedState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.deepEqual(savedState.accounts.filter(account=>account.name===payload.name).map(account=>account.id),[upstreamResult.body.account.id],'recovery after restart does not duplicate the created account');
      const changedPayload={...payload,name:'Synthetic changed payload'};
      const mismatch=await page.evaluate(async input=>{const response=await fetch('/api/manual-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},changedPayload);
      assert.equal(mismatch.status,409,'the same operation ID with a different payload conflicts after restart');
      savedState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(savedState.accounts.filter(account=>account.name===payload.name).length,1,'a mismatched replay leaves the committed account unchanged');
      assert.equal(savedState.accounts.filter(account=>account.name===changedPayload.name).length,0,'a mismatched replay creates no second account');

      const scenarioInput={name:'Synthetic restart scenario',targetDate:'2027-10-25',purchasePrice:40000000,downPayment:8000000,financedFees:0,termMonths:360,noteRatePercent:'6.5',pmiExplicitNone:true,propertyTaxMonthly:50000,homeownersInsuranceMonthly:15000,supplementaryInsuranceMonthly:0,hoaMonthly:7500,maintenanceReserveMonthly:30000,subordinateDebtMonthly:0,taxEscrowed:false,insuranceEscrowed:false,closingCosts:1200000,prepaids:400000,credits:300000,earnestPaid:500000,movingCosts:0,initialRepairs:0,retainedReserve:0,otherDebtPayments:0,currentNonHousingCommitments:0,currentHousingCost:0,plannedSavings:0,safetyMargin:0,pointsCents:0,netMonthlyIncome:null,grossMonthlyIncome:null,replaceCurrentHousing:true,rateSource:'Manual',rateAsOf:'2026-10-25',quoteType:'estimate'};
      const beforeScenario=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const scenarioCreateInput={input:scenarioInput,revision:beforeScenario.revision,clientOperationId:crypto.randomUUID()};
      const scenarioCreateResult=await assertCommittedReplayAfterRestart('scenario',scenarioCreateInput,'home-scenario create');
      assert.ok(scenarioCreateResult.scenario?.id,'scenario-create replay returns the original scenario ID');
      const scenario=scenarioCreateResult.scenario;
      const afterScenarioCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterScenarioCreate.revision,scenarioCreateResult.revision,'scenario-create replay does not advance the revision twice');
      const goalBeforeCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const goalCreateResult=await assertCommittedReplayAfterRestart('goal',{name:'Synthetic restart standalone goal',target:120000,targetDate:'2027-12-31',priority:2,monthlyContribution:0,apyBps:0,revision:goalBeforeCreate.revision,clientOperationId:crypto.randomUUID()},'savings-goal create');
      assert.ok(goalCreateResult.goal?.id,'goal-create replay returns the original goal ID');
      const afterGoalCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterGoalCreate.revision,goalCreateResult.revision,'goal-create replay does not advance the revision twice');
      const beforeBalanceSnapshot=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      let committedSnapshotResult=null;
      await page.route('**/api/balance-snapshot',async route=>{const upstream=await route.fetch();committedSnapshotResult={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();});
      const lostSnapshotResponse=await page.evaluate(async revision=>{try{const response=await fetch('/api/balance-snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})});return{networkError:false,status:response.status};}catch{return{networkError:true};}},beforeBalanceSnapshot.revision);
      assert.deepEqual(lostSnapshotResponse,{networkError:true},'the synthetic balance-snapshot response is lost after commit');
      await page.unroute('**/api/balance-snapshot');
      assert.equal(committedSnapshotResult?.status,200,JSON.stringify(committedSnapshotResult));
      assert.equal(committedSnapshotResult.body.existing,false,'the first snapshot request creates today’s snapshot');
      const afterSnapshotCommit=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterSnapshotCommit.revision,beforeBalanceSnapshot.revision+1,'the uncertain snapshot advances the revision once');
      const snapshotReplay=await page.evaluate(async revision=>{const response=await fetch('/api/balance-snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision})});return{status:response.status,body:await response.json()};},beforeBalanceSnapshot.revision);
      assert.equal(snapshotReplay.status,200,JSON.stringify(snapshotReplay.body));
      assert.equal(snapshotReplay.body.existing,true,'retry reads back the committed snapshot after restart');
      assert.equal(snapshotReplay.body.snapshot.id,committedSnapshotResult.body.snapshot.id,'snapshot recovery returns the same persisted snapshot ID');
      const afterSnapshotReplay=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterSnapshotReplay.revision,afterSnapshotCommit.revision,'snapshot read-back does not advance the revision twice');
      assert.equal(afterSnapshotReplay.balanceSheetSnapshots.filter(row=>row.date===committedSnapshotResult.body.snapshot.date).length,1,'snapshot recovery does not create a duplicate for the same date');
      const beforeGoal=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const goalPayload=await page.evaluate(({scenarioId,revision})=>({clientOperationId:crypto.randomUUID(),scenarioId,revision}),{scenarioId:scenario.id,revision:beforeGoal.revision});
      let committedGoalResult=null;
      await page.route('**/api/scenario-goal',async route=>{const upstream=await route.fetch();committedGoalResult={status:upstream.status(),body:await upstream.json()};await route.abort();});
      const lostGoalResponse=await page.evaluate(async input=>{try{const response=await fetch('/api/scenario-goal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{networkError:false,status:response.status};}catch{return{networkError:true};}},goalPayload);
      assert.deepEqual(lostGoalResponse,{networkError:true},'the scenario-goal client loses the committed response');
      assert.equal(committedGoalResult?.status,200,'the scenario goal committed before its response was dropped');
      assert.ok(committedGoalResult.body.goalId,'the committed scenario-goal result contains a stable goal ID');
      await page.unroute('**/api/scenario-goal');
      const afterGoalCommit=await page.evaluate(async()=>{const [state,scenarioState]=await Promise.all([fetch('/api/state').then(response=>response.json()),fetch('/api/scenarios').then(response=>response.json())]);return{...state,scenarios:scenarioState.scenarios};});
      assert.equal(afterGoalCommit.revision,beforeGoal.revision+1,'the uncertain scenario-goal apply advances the revision once');
      assert.equal(afterGoalCommit.scenarios.find(row=>row.id===scenario.id).linkedGoalId,committedGoalResult.body.goalId,'the scenario links to the committed goal');
      assert.equal(afterGoalCommit.goals.filter(row=>row.id===committedGoalResult.body.goalId).length,1,'the uncertain apply creates one goal');
      await restartServer();
      const goalReplay=await page.evaluate(async input=>{const response=await fetch('/api/scenario-goal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},goalPayload);
      assert.equal(goalReplay.status,200,JSON.stringify(goalReplay.body));
      assert.deepEqual(goalReplay.body,committedGoalResult.body,'replaying the scenario-goal apply after restart returns the original result');
      const afterGoalReplay=await page.evaluate(async()=>{const [state,scenarioState]=await Promise.all([fetch('/api/state').then(response=>response.json()),fetch('/api/scenarios').then(response=>response.json())]);return{...state,scenarios:scenarioState.scenarios};});
      assert.equal(afterGoalReplay.revision,afterGoalCommit.revision,'scenario-goal recovery does not advance the revision twice');
      assert.equal(afterGoalReplay.goals.filter(row=>row.id===committedGoalResult.body.goalId).length,1,'scenario-goal recovery does not duplicate the linked goal');
      assert.equal(afterGoalReplay.goals.find(row=>row.id===committedGoalResult.body.goalId).target,scenario.result.allInAcquisitionFunding,'the recovered goal retains the scenario funding target');
      const beforeBudget=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const budgetPayload=await page.evaluate(({scenarioId,revision})=>({clientOperationId:crypto.randomUUID(),scenarioId,revision}),{scenarioId:scenario.id,revision:beforeBudget.revision});
      let committedBudgetResult=null;
      await page.route('**/api/scenario-budget',async route=>{const upstream=await route.fetch();committedBudgetResult={status:upstream.status(),body:await upstream.json()};await route.abort();});
      const lostBudgetResponse=await page.evaluate(async input=>{try{const response=await fetch('/api/scenario-budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{networkError:false,status:response.status};}catch{return{networkError:true};}},budgetPayload);
      assert.deepEqual(lostBudgetResponse,{networkError:true},'the scenario-budget client loses the committed response');
      assert.equal(committedBudgetResult?.status,200,'the scenario budget committed before its response was dropped');
      await page.unroute('**/api/scenario-budget');
      const afterBudgetCommit=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterBudgetCommit.revision,beforeBudget.revision+1,'the uncertain scenario-budget apply advances the revision once');
      const committedTemplate=afterBudgetCommit.budgetTemplates.find(row=>row.categoryId==='system:housing'&&row.effectiveFrom===committedBudgetResult.body.month);
      assert.equal(committedTemplate?.amount,committedBudgetResult.body.amount,'the committed budget template has the returned amount');
      await restartServer();
      const budgetReplay=await page.evaluate(async input=>{const response=await fetch('/api/scenario-budget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},budgetPayload);
      assert.equal(budgetReplay.status,200,JSON.stringify(budgetReplay.body));
      assert.deepEqual(budgetReplay.body,committedBudgetResult.body,'replaying the scenario-budget apply after restart returns the original result');
      const afterBudgetReplay=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterBudgetReplay.revision,afterBudgetCommit.revision,'scenario-budget recovery does not advance the revision twice');
      assert.equal(afterBudgetReplay.budgetTemplates.filter(row=>row.categoryId==='system:housing'&&row.effectiveFrom===committedBudgetResult.body.month).length,1,'scenario-budget recovery leaves exactly one effective Housing template');

      await page.locator('[data-view="transactions"]').first().click();
      await page.locator('#import').click();
      const importDialog=page.getByRole('dialog'),importDate=monthInChicago()+'-01',importCsv=`Date,Merchant,Amount,Category\n${importDate},Synthetic restart import,12.34,Groceries\n`;
      await importDialog.locator('#import-account').fill('Synthetic restart import account');
      await importDialog.locator('#csv-file').setInputFiles({name:'synthetic-restart-import.csv',mimeType:'text/csv',buffer:Buffer.from(importCsv)});
      await importDialog.getByRole('button',{name:'Preview file'}).click();
      await importDialog.getByText('1 rows · 1 account(s)').waitFor();
      const revisionBeforeImport=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()).then(state=>state.revision));
      let importAttempts=0,committedImportResult=null;const importOperationIds=[];
      await page.route('**/api/import',async route=>{
        const input=route.request().postDataJSON();importOperationIds.push(input.clientOperationId);importAttempts++;
        if(importAttempts===1){const upstream=await route.fetch();committedImportResult={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();}
        else await route.continue();
      });
      await importDialog.getByRole('button',{name:'Commit 1 rows'}).click();
      await importDialog.getByText('1 transactions imported',{exact:false}).waitFor();
      await page.unroute('**/api/import');
      assert.equal(committedImportResult?.status,200,'the synthetic import committed before its first response was dropped');
      assert.equal(importAttempts,2,'the import client retries once after the server restart');
      assert.match(importOperationIds[0],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,'CSV import sends a stable operation ID');
      assert.equal(importOperationIds[1],importOperationIds[0],'the automatic import retry preserves its operation ID');
      assert.equal(committedImportResult.body.imported,1,'the saved import result records one imported transaction');
      assert.equal(committedImportResult.body.revision,revisionBeforeImport+1,'the import result records one revision increment');
      const importedRows=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20restart%20import').then(response=>response.json()));
      assert.deepEqual(importedRows.transactions.map(row=>row.id),[`csv:${committedImportResult.body.batchId}:0`],'the restarted import retry leaves exactly one deterministic transaction ID');
      assert.equal(importedRows.transactions[0].amount,1234,'the committed import preserves the original amount');
      const stateAfterImport=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterImport.revision,committedImportResult.body.revision,'the replay does not advance the import revision a second time');
      assert.deepEqual(stateAfterImport.accounts.filter(row=>row.name==='Synthetic restart import account').map(row=>row.id),[importedRows.transactions[0].accountId],'the replay leaves one CSV account linked to the imported transaction');
      const accountUpdatePayload={id:importedRows.transactions[0].accountId,action:'include',value:false,revision:stateAfterImport.revision,clientOperationId:crypto.randomUUID()};
      const accountUpdateResult=await assertCommittedReplayAfterRestart('account-update',accountUpdatePayload,'synthetic imported-account update');
      const stateAfterAccountUpdate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterAccountUpdate.revision,accountUpdateResult.revision,'account-update replay does not advance the revision twice');
      assert.equal(stateAfterAccountUpdate.accounts.find(row=>row.id===accountUpdatePayload.id).includeInReporting,false,'account-update replay preserves the committed reporting choice');
      await page.keyboard.press('Escape');
      await importDialog.waitFor({state:'detached'});

      await page.reload();await page.locator('#app .shell').waitFor();await page.locator('[data-view="transactions"]').first().click();
      const importedCategory=page.locator('#transaction-table tr').filter({hasText:'Synthetic restart import'}).locator('[data-category]');
      await importedCategory.waitFor();
      const revisionBeforeCategory=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()).then(state=>state.revision));
      let categoryAttempts=0,committedCategoryResult=null;const categoryOperationIds=[];
      await page.route('**/api/category',async route=>{
        const input=route.request().postDataJSON();categoryOperationIds.push(input.clientOperationId);categoryAttempts++;
        if(categoryAttempts===1){const upstream=await route.fetch();committedCategoryResult={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();}
        else await route.continue();
      });
      const categoryRetryResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/category'&&response.request().method()==='POST');
      await importedCategory.selectOption('system:shopping');
      const categoryReplay=await categoryRetryResponse;
      await page.unroute('**/api/category');
      assert.equal(committedCategoryResult?.status,200,'the category update committed before its first response was dropped');
      assert.equal(categoryAttempts,2,'the category client retries once after the server restart');
      assert.match(categoryOperationIds[0],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,'transaction category update sends a stable operation ID');
      assert.equal(categoryOperationIds[1],categoryOperationIds[0],'the category retry preserves its operation ID');
      assert.deepEqual(await categoryReplay.json(),committedCategoryResult.body,'the category retry returns the original result after restart');
      assert.equal(committedCategoryResult.body.revision,revisionBeforeCategory+1,'the category result records one revision increment');
      const categorizedRows=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20restart%20import').then(response=>response.json()));
      assert.deepEqual(categorizedRows.transactions.map(row=>row.id),[`csv:${committedImportResult.body.batchId}:0`],'the category replay keeps the same imported transaction');
      assert.equal(categorizedRows.transactions[0].overrideCategoryId,'system:shopping','the category replay persists the selected category');
      const stateAfterCategory=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterCategory.revision,committedCategoryResult.body.revision,'the category replay does not advance the revision twice');

      await page.locator('[data-view="goals"]').first().click();
      await page.locator(`[data-allocate-goal="${committedGoalResult.body.goalId}"]`).click();
      const allocationAccountId=upstreamResult.body.account.id,allocationDialog=page.getByRole('dialog'),allocationInput=allocationDialog.locator('[data-allocation-account="'+allocationAccountId+'"]');
      await allocationInput.fill('100.00');
      const revisionBeforeAllocation=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()).then(state=>state.revision));
      let allocationAttempts=0,committedAllocationResult=null;const allocationOperationIds=[];
      await page.route('**/api/goal-allocations',async route=>{
        const input=route.request().postDataJSON();allocationOperationIds.push(input.clientOperationId);allocationAttempts++;
        if(allocationAttempts===1){const upstream=await route.fetch();committedAllocationResult={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();}
        else await route.continue();
      });
      await allocationDialog.getByRole('button',{name:'Save allocations'}).click();
      await allocationDialog.waitFor({state:'detached'});
      await page.unroute('**/api/goal-allocations');
      assert.equal(committedAllocationResult?.status,200,'the synthetic goal allocation committed before its first response was dropped');
      assert.equal(allocationAttempts,2,'the allocation client retries once after the server restart');
      assert.match(allocationOperationIds[0],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,'goal allocation sends a stable operation ID');
      assert.equal(allocationOperationIds[1],allocationOperationIds[0],'the allocation retry preserves its operation ID');
      assert.equal(committedAllocationResult.body.revision,revisionBeforeAllocation+1,'the allocation result records one revision increment');
      const stateAfterAllocation=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterAllocation.revision,committedAllocationResult.body.revision,'allocation replay does not advance the revision twice');
      assert.deepEqual(stateAfterAllocation.goalAllocations.filter(row=>row.goalId===committedGoalResult.body.goalId&&row.active!==false).map(row=>({accountId:row.accountId,amount:row.amount})),[{accountId:allocationAccountId,amount:10000}],'the replay leaves one exact active cash allocation');

      const reportingDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const propertyCreateResult=await assertCommittedReplayAfterRestart('property',{name:'Synthetic restart property',address:'Synthetic address',ownershipBps:10000,valuation:25000000,valuationAsOf:reportingDate,valuationSource:'owner_estimate',revision:stateAfterAllocation.revision,clientOperationId:crypto.randomUUID()},'property create');
      assert.ok(propertyCreateResult.property?.id,'property-create replay returns the original property ID');
      const afterPropertyCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterPropertyCreate.revision,propertyCreateResult.revision,'property-create replay does not advance the revision twice');
      const mortgageRevision=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()).then(state=>state.revision));
      const mortgageCreateResult=await assertCommittedReplayAfterRestart('mortgage',{propertyId:propertyCreateResult.property.id,lender:'Synthetic restart lender',loanType:'fixed',statementBalance:20000000,balanceAsOf:reportingDate,originalPrincipal:25000000,originationDate:'2020-10-25',annualRatePercent:'6.5',termMonths:360,ownerDebtShareBps:10000,components:{principalInterest:100000,extraPrincipal:0},revision:mortgageRevision,clientOperationId:crypto.randomUUID()},'mortgage create');
      assert.ok(mortgageCreateResult.mortgage?.id,'mortgage-create replay returns the original mortgage ID');
      const afterMortgageCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(afterMortgageCreate.revision,mortgageCreateResult.revision,'mortgage-create replay does not advance the revision twice');
      const mortgage=mortgageCreateResult.mortgage,mortgageUpdatePayload={id:mortgage.id,propertyId:mortgage.propertyId,lender:mortgage.lender,loanType:mortgage.loanType,linkedAccountId:mortgage.linkedAccountId,statementBalance:19900000,balanceAsOf:reportingDate,originalPrincipal:mortgage.originalPrincipal,originationDate:mortgage.originationDate,annualRatePercent:mortgage.annualRatePercent,termMonths:mortgage.termMonths,ownerDebtShareBps:mortgage.ownerDebtShareBps,components:mortgage.components,taxInsuranceEscrowed:mortgage.taxInsuranceEscrowed,revision:afterMortgageCreate.revision,clientOperationId:crypto.randomUUID()};
      let committedMortgageResult=null;
      await page.route('**/api/mortgage',async route=>{const upstream=await route.fetch();committedMortgageResult={status:upstream.status(),body:await upstream.json()};await restartServer();await route.abort();});
      const lostMortgageResponse=await page.evaluate(async input=>{try{const response=await fetch('/api/mortgage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{networkError:false,status:response.status};}catch{return{networkError:true};}},mortgageUpdatePayload);
      assert.deepEqual(lostMortgageResponse,{networkError:true},'the mortgage update client loses the committed response');
      assert.equal(committedMortgageResult?.status,200,'the mortgage update committed before its response was dropped');
      await page.unroute('**/api/mortgage');
      const mortgageReplay=await page.evaluate(async input=>{const response=await fetch('/api/mortgage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},mortgageUpdatePayload);
      assert.equal(mortgageReplay.status,200,JSON.stringify(mortgageReplay.body));
      assert.deepEqual(mortgageReplay.body,committedMortgageResult.body,'replaying the mortgage update after restart returns the original result');
      const stateAfterMortgageReplay=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterMortgageReplay.revision,committedMortgageResult.body.revision,'mortgage replay does not advance the revision twice');
      const savedMortgage=stateAfterMortgageReplay.propertySummary.properties.find(row=>row.id===mortgage.propertyId)?.mortgages.find(row=>row.id===mortgage.id);
      assert.equal(savedMortgage?.statementBalance,19900000,'the recovered mortgage retains the committed statement balance');

      const beforeAllocationUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const allocationUndoPayload={batchId:committedAllocationResult.body.batchId,revision:beforeAllocationUndo.revision,clientOperationId:crypto.randomUUID()};
      const allocationUndoResult=await assertCommittedReplayAfterRestart('goal-allocation-undo',allocationUndoPayload,'goal-allocation undo');
      assert.equal(allocationUndoResult.undone,1,'the allocation undo reports one reverted allocation');
      const stateAfterAllocationUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterAllocationUndo.revision,allocationUndoResult.revision,'allocation undo replay does not advance the revision twice');
      assert.equal(stateAfterAllocationUndo.goalAllocations.filter(row=>row.goalId===committedGoalResult.body.goalId&&row.active!==false).length,0,'allocation undo replay leaves no active allocation from its batch');

      const transactionId=`csv:${committedImportResult.body.batchId}:0`,beforeBulkUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const categoryBulkResult=await assertCommittedReplayAfterRestart('category-bulk',{clientOperationId:crypto.randomUUID(),ids:[transactionId],categoryId:'system:dining',revision:beforeBulkUndo.revision},'bulk category edit');
      assert.equal(categoryBulkResult.count,1,'bulk category replay reports the selected row count');
      const beforeCategoryBulkUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(beforeCategoryBulkUndo.revision,categoryBulkResult.revision,'bulk category replay does not advance the revision twice');
      const categoryBulkUndoPayload={batchId:categoryBulkResult.batchId,revision:beforeCategoryBulkUndo.revision,clientOperationId:crypto.randomUUID()};
      const categoryBulkUndoResult=await assertCommittedReplayAfterRestart('category-bulk-undo',categoryBulkUndoPayload,'category-bulk undo');
      assert.equal(categoryBulkUndoResult.undone,1,'the category-bulk undo reports one reverted row');
      const stateAfterCategoryBulkUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterCategoryBulkUndo.revision,categoryBulkUndoResult.revision,'category-bulk undo replay does not advance the revision twice');
      const afterCategoryBulkUndo=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20restart%20import').then(response=>response.json()));
      assert.equal(afterCategoryBulkUndo.transactions[0].overrideCategoryId,'system:shopping','category-bulk undo replay restores the prior category');

      const beforeCategoryCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const categoryCreateInput={name:'Synthetic restart category',revision:beforeCategoryCreate.revision,clientOperationId:crypto.randomUUID()};
      const categoryCreateResult=await assertCommittedReplayAfterRestart('category-create',categoryCreateInput,'custom-category create');
      assert.ok(categoryCreateResult.category?.id,'category-create replay returns the original category ID');
      const stateAfterCategoryCreate=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterCategoryCreate.revision,categoryCreateResult.revision,'category-create replay does not advance the revision twice');
      const beforeCategoryRename=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const assignCustomCategory=await page.evaluate(async input=>{const response=await fetch('/api/category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return{status:response.status,body:await response.json()};},{id:transactionId,category:categoryCreateResult.category.name,categoryId:categoryCreateResult.category.id,revision:beforeCategoryRename.revision});
      assert.equal(assignCustomCategory.status,200,JSON.stringify(assignCustomCategory.body));
      const renameState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const categoryRenamePayload={id:categoryCreateResult.category.id,action:'rename',name:'Synthetic restart renamed category',revision:renameState.revision,clientOperationId:crypto.randomUUID()};
      const categoryRenameResult=await assertCommittedReplayAfterRestart('category-update',categoryRenamePayload,'custom-category rename');
      const renamedState=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(renamedState.revision,categoryRenameResult.revision,'category rename replay does not advance the revision twice');
      assert.equal(renamedState.categoryCatalog.find(row=>row.id===categoryCreateResult.category.id).name,categoryRenameResult.category.name,'category rename replay preserves the stable category identity and name');
      const renamedTransaction=await page.evaluate(async()=>fetch('/api/transactions?search=Synthetic%20restart%20import').then(response=>response.json()).then(result=>result.transactions[0]));
      assert.equal(renamedTransaction.overrideCategoryId,categoryCreateResult.category.id,'category rename replay updates the transaction category ID');
      assert.equal(renamedTransaction.override,'Synthetic restart renamed category','category rename replay updates the effective transaction category');

      const beforeImportUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      const importUndoPayload={batchId:committedImportResult.body.batchId,revision:beforeImportUndo.revision,clientOperationId:crypto.randomUUID()};
      const importUndoResult=await assertCommittedReplayAfterRestart('import-undo',importUndoPayload,'CSV import undo');
      assert.equal(importUndoResult.undone,1,'the import undo reports one removed row');
      const stateAfterImportUndo=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
      assert.equal(stateAfterImportUndo.revision,importUndoResult.revision,'import undo replay does not advance the revision twice');
      assert.equal(stateAfterImportUndo.transactionCount,0,'import undo replay leaves the synthetic transaction removed exactly once');

      const month=monthInChicago();
      const replayBudgetMutation=async(path,payload,label,verify)=>{
        const before=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
        const input={...payload,revision:before.revision,clientOperationId:crypto.randomUUID()};
        const result=await assertCommittedReplayAfterRestart(path,input,label);
        const after=await page.evaluate(async()=>fetch('/api/state').then(response=>response.json()));
        assert.equal(after.revision,before.revision+1,label+' advances the revision once');
        assert.equal(after.revision,result.revision,label+' replay does not advance the revision twice');
        verify(after,result);
      };
      await replayBudgetMutation('budget',{categoryId:'system:groceries',amount:43000,mode:'month',month},'monthly budget edit',(saved)=>assert.equal(saved.monthlyBudgets[`${month}:system:groceries`],43000,'the committed monthly budget amount persists'));
      await replayBudgetMutation('budget-reset',{categoryId:'system:groceries',month},'monthly budget reset',(saved)=>assert.equal(Object.hasOwn(saved.monthlyBudgets||{},`${month}:system:groceries`),false,'the committed budget reset removes the monthly override'));
      await replayBudgetMutation('income-plan',{month,mode:'month',amount:500000},'monthly income plan edit',(saved)=>assert.equal(saved.monthlyIncomePlans[month],500000,'the committed monthly income plan persists'));
      await replayBudgetMutation('income-plan-reset',{month},'monthly income plan reset',(saved)=>assert.equal(Object.hasOwn(saved.monthlyIncomePlans||{},month),false,'the committed income-plan reset removes the monthly override'));
      const budgetSummary=await page.evaluate(async month=>fetch('/api/budget-summary?month='+encodeURIComponent(month)).then(response=>response.json()),month);
      await replayBudgetMutation('budget-outlook',{month,changes:{actualIncome:budgetSummary.actuals.income,income:12500,expenses:{'system:utilities':7500}}},'budget outlook edit',(saved)=>{assert.equal(saved.monthlyBudgetOutlooks[month].income.expectedTotal,budgetSummary.actuals.income+12500,'the committed outlook income expectation persists');assert.equal(saved.monthlyBudgetOutlooks[month].expenses['system:utilities'].expectedTotal,(budgetSummary.actuals.categories['system:utilities']||0)+7500,'the committed outlook expense expectation persists');});
      assert.deepEqual(apiFailures.map(row=>row.status),[409],'only the deliberate changed-payload replay is rejected');
      assert.deepEqual(browserErrors,[],'operation replay across restart has no uncaught browser errors');assert.deepEqual(consoleErrors,[],'operation replay across restart has no browser console errors');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: operation-restart (manual/import/category/scenario/goal/property/mortgage creates, account/category updates, balance-snapshot read-back, scenario applies, CSV transaction edits, allocation, budget/income/outlook edits and resets, and three undo operations recover after restart without duplicates).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if(name==='snapshot-races'){
      const month=monthInChicago(),prior=previousMonth(month),csv=`Date,Merchant,Amount,Category\n${month}-05,Alpha race marker,10.00,Groceries\n${month}-06,Beta race marker,20.00,Groceries\n${prior}-03,Prior month race marker,5.50,Groceries\n`;
      const importInput={csv,account:'Synthetic snapshot race import',columnMapping:{date:'Date',merchant:'Merchant',amount:'Amount',category:'Category'},dateFormat:'YYYY-MM-DD',amountMode:'positive-spending'};
      const seed=await page.evaluate(async input=>{const previewResponse=await fetch('/api/import-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),preview=await previewResponse.json();if(!previewResponse.ok)throw new Error(JSON.stringify(preview));const savedResponse=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...input,revision:preview.revision,confirmOverlaps:true})}),saved=await savedResponse.json();return{preview,saved,status:savedResponse.status};},importInput);
      assert.equal(seed.status,200,JSON.stringify(seed.saved));assert.equal(seed.saved.imported,3,'synthetic setup persists exact rows for month and query races');
      await page.goto(`http://127.0.0.1:${port}/?page=transactions&month=${month}`);
      const search=page.locator('#search');await search.waitFor();
      let alphaStartedResolve,alphaResponseResolve;const alphaStarted=new Promise(resolvePromise=>alphaStartedResolve=resolvePromise),alphaResponse=new Promise(resolvePromise=>alphaResponseResolve=resolvePromise);let releaseAlpha;
      const alphaGate=new Promise(resolvePromise=>releaseAlpha=resolvePromise);
      await page.route('**/api/transactions*',async route=>{const requestUrl=new URL(route.request().url());if(requestUrl.searchParams.get('search')==='Alpha race marker'){alphaStartedResolve();await alphaGate;const response=await route.fetch();await route.fulfill({response});alphaResponseResolve();}else await route.continue();});
      await search.fill('Alpha race marker');await alphaStarted;
      const betaResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get('search')==='Beta race marker');
      await search.fill('Beta race marker');assert.equal((await betaResponse).status(),200,'the newer search request completes while the older request remains delayed');
      await page.locator('#transaction-table').getByText('Beta race marker',{exact:true}).waitFor();
      const alphaBrowserResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get('search')==='Alpha race marker');
      releaseAlpha();await alphaResponse;await alphaBrowserResponse;await page.waitForTimeout(100);
      assert.equal(await page.locator('#search').inputValue(),'Beta race marker','the latest search remains selected after the old response completes');
      assert.equal(await page.locator('#transaction-table').getByText('Beta race marker',{exact:true}).count(),1,'the latest search result remains visible');
      assert.equal(await page.locator('#transaction-table').getByText('Alpha race marker',{exact:true}).count(),0,'the older search response cannot replace the current result');
      await page.unroute('**/api/transactions*');

      await page.goto(`http://127.0.0.1:${port}/?page=overview&month=${month}`);await page.locator('#month').waitFor();await page.locator('.metric.featured .value').filter({hasText:'$30.00'}).waitFor();
      let priorStartedResolve,priorResponseResolve;const priorStarted=new Promise(resolvePromise=>priorStartedResolve=resolvePromise),priorResponse=new Promise(resolvePromise=>priorResponseResolve=resolvePromise);let releasePrior;
      const priorGate=new Promise(resolvePromise=>releasePrior=resolvePromise);
      await page.route('**/api/month-summary*',async route=>{const requested=new URL(route.request().url()).searchParams.get('month');if(requested===prior){priorStartedResolve();await priorGate;const response=await route.fetch();await route.fulfill({response});priorResponseResolve();}else await route.continue();});
      await page.locator('#month').selectOption(prior);await priorStarted;await page.locator('#month').selectOption(month);
      await page.locator('.metric.featured .value').filter({hasText:'$30.00'}).waitFor();
      releasePrior();await priorResponse;await page.waitForTimeout(100);
      assert.equal(await page.locator('#month').inputValue(),month,'the newer reporting month remains selected');
      assert.equal(await page.locator('.metric.featured .value').innerText(),'$30.00','the delayed prior-month summary cannot replace the current-month totals');
      await page.unroute('**/api/month-summary*');
      assert.deepEqual(browserErrors,[],'delayed query responses produce no uncaught browser errors');assert.deepEqual(consoleErrors,[],'delayed query responses produce no browser console errors');
      assert.deepEqual(apiFailures,[],'snapshot races do not trigger API failures');
      await context.tracing.stop();traceStarted=false;
      console.log('Browser case passed: snapshot-races (delayed search and prior-month responses cannot replace newer query snapshots).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    const month = monthInChicago(), followingMonth = nextMonth(month);
    await page.locator('[data-view="budgets"]').first().click();
    if (await page.locator('form[data-budget]').count() === 0) {
      await page.locator('[data-new-category]').click();
      const categoryDialog = page.getByRole('dialog');
      await categoryDialog.locator('#new-category-name').fill(name === 'budget-frequency-history' ? 'Synthetic annual schedule' : 'Synthetic recurring budget');
      if (['budget-recurring', 'budget-two-tab'].includes(name)) await categoryDialog.locator('#new-category-limit').fill('75');
      if (name === 'budget-frequency-history') {
        await categoryDialog.locator('#new-category-limit').fill('1200');
        await categoryDialog.locator('#new-category-frequency').selectOption('annual');
        await categoryDialog.locator('#new-category-due-month').selectOption(String(Number(month.slice(5))));
      }
      await categoryDialog.getByRole('button', { name: 'Create bucket' }).click();
      await page.locator('form[data-budget]').first().waitFor();
    }
    const form = () => page.locator('form[data-budget]').first();
    await form().waitFor();
    const categoryId = await form().getAttribute('data-budget-id');
    if (name === 'budget-recurring') {
      await form().locator('[data-budget-edit]').click();
      await form().locator('select[name="mode"]').waitFor({ state: 'visible' });
    }

    if (name === 'budget-two-tab') {
      const secondTab = await context.newPage();
      await secondTab.goto(`http://127.0.0.1:${port}/?page=budgets&month=${month}`);
      const secondForm = secondTab.locator(`form[data-budget-id="${categoryId}"]`);
      await secondForm.waitFor();
      await secondForm.locator('[data-budget-edit]').click();
      await form().locator('[data-budget-edit]').click();
      await secondForm.locator('input[name="amount"]').fill('90');
      await form().locator('input[name="amount"]').fill('80');
      let response = page.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
      await form().locator('button[type="submit"]').click();
      assert.equal((await response).status(), 200, 'the first browser tab saves its current revision');
      await page.locator('p.form-status').filter({ hasText: 'Budget saved.' }).waitFor();

      response = secondTab.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
      await secondForm.locator('button[type="submit"]').click();
      assert.equal((await response).status(), 409, 'the stale second tab receives a real conflict');
      await secondForm.locator('[data-budget-error]').filter({ hasText: 'another tab' }).waitFor();
      assert.equal(await secondForm.locator('input[name="amount"]').inputValue(), '90', 'the conflicted second-tab draft is retained');
      let persisted = await page.evaluate(async id => fetch('/api/state').then(result => result.json()).then(state => state.budgetTemplates.find(row => row.categoryId === id && row.effectiveFrom === document.querySelector('#month').value)?.amount), categoryId);
      assert.equal(persisted, 8000, 'the first tab value remains saved after the conflict');

      response = secondTab.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
      await secondForm.locator('button[type="submit"]').click();
      assert.equal((await response).status(), 200, 'reapplying the retained draft is a new explicit save');
      await secondTab.locator('p.form-status').filter({ hasText: 'Budget saved.' }).waitFor();
      persisted = await page.evaluate(async id => fetch('/api/state').then(result => result.json()).then(state => state.budgetTemplates.find(row => row.categoryId === id && row.effectiveFrom === document.querySelector('#month').value)?.amount), categoryId);
      assert.equal(persisted, 9000, 'the explicit retry saves exactly the retained second-tab draft');
      assert.deepEqual(apiFailures.map(row => [row.method, row.path, row.status]), [['POST', '/api/budget', 409]], 'the only API failure is the expected stale revision conflict');
      assert.deepEqual(browserErrors, [], 'two-tab conflict handling has no uncaught browser errors');
      assert.deepEqual(consoleErrors, [], 'two-tab conflict handling has no browser console errors');
      await secondTab.close();
      await context.tracing.stop();
      traceStarted = false;
      console.log('Browser case passed: budget-two-tab (fresh synthetic SQLite; conflict preserves draft and requires an explicit save).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    if (name === 'budget-frequency-history') {
      const october = month, november = followingMonth, dueMonth = String(Number(month.slice(5)));
      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${october}`);
      const octoberForm = page.locator(`form[data-budget-id="${categoryId}"]`);
      await octoberForm.waitFor();
      await octoberForm.locator('[data-budget-edit]').click();
      await octoberForm.locator('input[name="amount"]').fill('1200');
      await octoberForm.locator('select[name="frequency"]').selectOption('annual');
      await octoberForm.locator('select[name="dueMonth"]').selectOption(dueMonth);
      await octoberForm.locator('select[name="mode"]').selectOption('template');
      let response = page.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
      await octoberForm.locator('button[type="submit"]').click();
      assert.equal((await response).status(), 200, 'the annual October recurring plan saves');
      await page.locator('p.form-status').filter({ hasText: 'Budget saved.' }).waitFor();
      assert.equal(await octoberForm.locator('input[name="amount"]').inputValue(), '1200.00', 'October editor keeps the annual source amount');
      assert.equal(await octoberForm.locator('select[name="frequency"]').inputValue(), 'annual');
      assert.equal(await octoberForm.locator('select[name="dueMonth"]').inputValue(), dueMonth);

      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${november}`);
      const novemberForm = page.locator(`form[data-budget-id="${categoryId}"]`);
      await novemberForm.waitFor();
      await novemberForm.locator('[data-budget-edit]').click();
      await novemberForm.locator('input[name="amount"]').fill('200');
      await novemberForm.locator('select[name="frequency"]').selectOption('monthly');
      await novemberForm.locator('select[name="dueMonth"]').selectOption('');
      await novemberForm.locator('select[name="mode"]').selectOption('month');
      response = page.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
      await novemberForm.locator('button[type="submit"]').click();
      assert.equal((await response).status(), 200, 'the November monthly override saves independently');
      await page.locator('p.form-status').filter({ hasText: 'Budget saved.' }).waitFor();
      const savedSchedules = await page.evaluate(async () => fetch('/api/state').then(result => result.json()));
      assert.deepEqual(savedSchedules.budgetTemplateSchedules[categoryId + ':' + october], { frequency: 'annual', dueMonth: Number(dueMonth), sourceAmount: 120000 }, 'the October template owns its annual schedule metadata');
      assert.deepEqual(savedSchedules.monthlyBudgetSchedules[november + ':' + categoryId], { frequency: 'monthly', dueMonth: null, sourceAmount: 20000 }, 'the November override owns its own monthly schedule metadata');

      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${october}`);
      const octoberAfterOverride = page.locator(`form[data-budget-id="${categoryId}"]`);
      await octoberAfterOverride.waitFor();
      assert.equal(await octoberAfterOverride.locator('input[name="amount"]').inputValue(), '1200.00', 'editing October retains its annual source amount after the November override');
      assert.equal(await octoberAfterOverride.locator('select[name="frequency"]').inputValue(), 'annual', 'editing October retains its annual frequency');
      assert.equal(await octoberAfterOverride.locator('select[name="dueMonth"]').inputValue(), dueMonth, 'editing October retains its due month');

      await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${november}`);
      const novemberAfterReload = page.locator(`form[data-budget-id="${categoryId}"]`);
      await novemberAfterReload.waitFor();
      assert.equal(await novemberAfterReload.locator('input[name="amount"]').inputValue(), '200.00', 'the November override survives a reload');
      assert.equal(await novemberAfterReload.locator('select[name="frequency"]').inputValue(), 'monthly');
      await novemberAfterReload.locator('[data-budget-edit]').click();
      await novemberAfterReload.getByRole('button', { name: /Reset .* month override/ }).click();
      await page.locator('.budget-message').filter({ hasText: 'Month override reset to its recurring template.' }).waitFor();
      assert.equal(await novemberAfterReload.locator('input[name="amount"]').inputValue(), '1200.00', 'reset restores the annual source amount');
      assert.equal(await novemberAfterReload.locator('select[name="frequency"]').inputValue(), 'annual', 'reset restores the full annual schedule');
      assert.equal(await novemberAfterReload.locator('select[name="dueMonth"]').inputValue(), dueMonth, 'reset restores the due month');
      const resetSchedules = await page.evaluate(async () => fetch('/api/state').then(result => result.json()));
      assert.equal(Object.hasOwn(resetSchedules.monthlyBudgetSchedules, november + ':' + categoryId), false, 'reset removes only the November override schedule');
      assert.deepEqual(resetSchedules.budgetTemplateSchedules[categoryId + ':' + october], { frequency: 'annual', dueMonth: Number(dueMonth), sourceAmount: 120000 }, 'reset leaves the October annual template untouched');
      assert.deepEqual(browserErrors, [], 'frequency history has no uncaught browser errors');
      assert.deepEqual(consoleErrors, [], 'frequency history has no browser console errors');
      await context.tracing.stop();
      traceStarted = false;
      console.log('Browser case passed: budget-frequency-history (October annual source and due month survive a November monthly override, reload, and reset).');
      assert.deepEqual(browserErrors, [], 'browser case completes without uncaught errors');
      assert.deepEqual(consoleErrors, [], 'browser case completes without console errors');
      return;
    }

    await form().locator('select[name="mode"]').selectOption('template');
    await form().locator('input[name="amount"]').fill('75');
    let response = page.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
    await form().locator('button[type="submit"]').click();
    assert.equal((await response).status(), 200, 'the synthetic recurring budget saves');
    await page.locator('p.form-status').filter({ hasText: 'Budget saved.' }).waitFor();

    await form().locator('[data-budget-edit]').click();
    await form().locator('select[name="mode"]').selectOption('month');
    await form().locator('input[name="amount"]').fill('0');
    response = page.waitForResponse(result => result.url().endsWith('/api/budget') && result.request().method() === 'POST');
    await form().locator('button[type="submit"]').click();
    assert.equal((await response).status(), 200, 'an explicit zero month override saves');
    const monthState = await page.evaluate(async key => fetch('/api/state').then(result => result.json()).then(state => ({ state, key })), month + ':' + categoryId);
    assert.equal(monthState.state.monthlyBudgets[monthState.key], 0, 'zero month override remains distinct from missing data');

    await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${followingMonth}`);
    const followingForm = page.locator(`form[data-budget-id="${categoryId}"]`);
    await followingForm.waitFor();
    assert.equal(await followingForm.locator('input[name="amount"]').inputValue(), '75.00', 'the recurring $75 template appears in the next month despite the prior month zero override');

    await page.goto(`http://127.0.0.1:${port}/?page=budgets&month=${month}`);
    const currentForm = page.locator(`form[data-budget-id="${categoryId}"]`);
    await currentForm.waitFor();
    assert.equal(await currentForm.locator('input[name="amount"]').inputValue(), '0.00', 'the explicit zero remains visible when returning to its month');
    await currentForm.locator('[data-budget-edit]').click();
    await currentForm.getByRole('button', { name: /Reset .* month override/ }).click();
    await page.locator('.budget-message').filter({ hasText: 'Month override reset to its recurring template.' }).waitFor();
    assert.equal(await currentForm.locator('input[name="amount"]').inputValue(), '75.00', 'reset restores the recurring template');
    const finalState = await page.evaluate(async () => fetch('/api/state').then(result => result.json()));
    assert.equal(Object.hasOwn(finalState.monthlyBudgets, month + ':' + categoryId), false, 'reset removes the override from persisted state');
    assert.equal(finalState.budgetTemplates.find(row => row.categoryId === categoryId && row.effectiveFrom === month)?.amount, 7500, 'the original template remains unchanged');
    assert.deepEqual(apiFailures, [], 'the isolated recurring-budget case has no unexpected API failures');
    assert.deepEqual(browserErrors, [], 'the isolated recurring-budget case has no uncaught browser errors');
    assert.deepEqual(consoleErrors, [], 'the isolated recurring-budget case has no browser console errors');
    await context.tracing.stop();
    traceStarted = false;
    console.log(`Browser case passed: ${name} (fresh synthetic SQLite; recurring $75 template, next-month resolution, zero override, reset).`);
  } catch (error) {
    const artifactRoot = process.env.LEDGER_BROWSER_ARTIFACTS || join(tmpdir(), 'ledger-browser-failures');
    await (await import('node:fs/promises')).mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    await chmod(artifactRoot, 0o700);
    const artifacts = await mkdtemp(join(artifactRoot, 'failure-case-'));
    await chmod(artifacts, 0o700);
    if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
    if (traceStarted && context) await context.tracing.stop({ path: join(artifacts, 'trace.zip') }).catch(() => {});
    await writeFile(join(artifacts, 'failure.txt'), String(error?.stack || error) + '\n\n' + logs, { mode: 0o600 });
    await writeFile(join(artifacts, 'requests.json'), JSON.stringify({ sampleWrites, apiFailures, browserErrors, consoleErrors, accessibilityFailures: failures }, null, 2), { mode: 0o600 });
    console.error(`Browser case failure artifacts retained at ${artifacts}`);
    throw error;
  } finally {
    await browser?.close();
    await closeChild(child);
    await rm(directory, { recursive: true, force: true });
  }
}
