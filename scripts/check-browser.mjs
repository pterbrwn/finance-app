import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

assert.match(process.version,/^v24\.22\.1$/,'browser acceptance uses pinned Node.js 24.22.1');
const appRoot=resolve(import.meta.dirname,'..'),directory=await mkdtemp(join(tmpdir(),'ledger-browser-'));
await (await import('node:fs/promises')).chmod(directory,0o700);
const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify({enablePlaid:false}),{mode:0o600});
const probe=createServer();await new Promise((resolve,reject)=>probe.once('error',reject).listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const child=spawn('bash',['scripts/start-ledger.sh'],{cwd:appRoot,env:{...process.env,PORT:String(port),LEDGER_NODE_BIN:process.execPath,LEDGER_LOCAL_DATA_DIR:directory,LEDGER_CONFIG_FILE:configPath},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
let browser;
try{
  let ready=false;
  for(let attempt=0;attempt<80;attempt++){
    if(child.exitCode!==null)throw new Error(`synthetic server exited early: ${logs}`);
    try{const response=await fetch(`http://127.0.0.1:${port}/api/health`);ready=response.ok;}catch{}
    if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,`synthetic server did not become ready: ${logs}`);
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
  page.on('pageerror',error=>logs+=`\npageerror: ${error.message}`);
  page.on('console',message=>{if(message.type()==='error')logs+=`\nconsole: ${message.text()}`;});
  const failures=[];
  async function audit(label){
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    const serious=result.violations.filter(row=>['critical','serious'].includes(row.impact));
    failures.push(...serious.map(row=>({label,id:row.id,impact:row.impact,description:row.description,nodes:row.nodes.slice(0,3).map(node=>node.target)})));
  }
  async function visit(view){await page.locator(`[data-view="${view}"]`).first().click();await page.waitForTimeout(100);await audit(view);}
  await page.goto(`http://127.0.0.1:${port}/`);await page.locator('#app .shell').waitFor({timeout:10000}).catch(error=>{throw new Error(`app did not render: ${logs}\n${error.message}`);});
  await audit('overview');
  for(const view of ['transactions','budgets','accounts','investments','goals','home','settings'])await visit(view);

  await page.locator('[data-view="transactions"]').first().click();
  const emptyCount=await page.evaluate(async()=>((await fetch('/api/state')).json()).then(state=>state.transactionCount));assert.equal(emptyCount,0,'the initial manual-only dataset is empty');
  await page.locator('#import').click();
  const cancelledImport=page.getByRole('dialog');
  await cancelledImport.locator('#import-account').fill('Cancelled browser import');
  await cancelledImport.locator('#csv-file').setInputFiles({name:'cancelled.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Merchant,Amount,Category\n2026-10-12,Cancelled Market,24.50,Groceries\n')});
  await cancelledImport.locator('#cancel-import').click();
  assert.equal(await page.getByRole('dialog').count(),0,'cancelling a CSV preview closes without committing');
  await page.locator('#import').click();
  const importDialog=page.getByRole('dialog');
  await importDialog.locator('#import-account').fill('Synthetic browser account');
  await importDialog.locator('#csv-file').setInputFiles({name:'browser.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Merchant,Amount,Category\n2026-10-12,Synthetic Market,24.50,Groceries\n')});
  await importDialog.getByRole('button',{name:'Preview file'}).click();
  await importDialog.getByText('1 rows for Synthetic browser account').waitFor();
  await importDialog.getByRole('button',{name:'Commit 1 rows'}).click();
  await importDialog.getByText('1 transactions imported').waitFor();
  await importDialog.getByRole('button',{name:'Undo this import'}).click();
  await importDialog.getByText('This import batch was undone.').waitFor();
  await audit('import-dialog');
  await page.keyboard.press('Escape');

  await page.locator('#import').click();
  const bulkImportDialog=page.getByRole('dialog');
  await bulkImportDialog.locator('#import-account').fill('Synthetic bulk account');
  await bulkImportDialog.locator('#csv-file').setInputFiles({name:'bulk.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Merchant,Amount,Category\n2026-10-13,Synthetic bulk market,18.75,Groceries\n')});
  await bulkImportDialog.getByRole('button',{name:'Preview file'}).click();
  await bulkImportDialog.getByText('1 rows for Synthetic bulk account').waitFor();
  const bulkCommitResponse=page.waitForResponse(response=>response.url().endsWith('/api/import')&&response.request().method()==='POST');
  await bulkImportDialog.getByRole('button',{name:'Commit 1 rows'}).click();
  const bulkImportBatch=await(await bulkCommitResponse).json();
  await page.keyboard.press('Escape');
  await page.locator('#search').fill('Synthetic bulk market');
  await page.getByText('Synthetic bulk market',{exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'Select Synthetic bulk market'}).check();
  await page.locator('#bulk-category').waitFor();
  await page.locator('#bulk-category').selectOption({label:'Shopping'});
  assert.ok(await page.locator('#bulk-category').inputValue(),'bulk category selection is populated');
  await page.locator('#apply-bulk-category').waitFor();
  const bulkEditResponse=page.waitForResponse(response=>response.url().endsWith('/api/category-bulk')&&response.request().method()==='POST');
  await page.locator('#apply-bulk-category').click();
  const bulkEditResult=await bulkEditResponse;
  assert.equal(bulkEditResult.status(),200,`bulk category API response: ${await bulkEditResult.text()}`);
  await page.locator('#undo-bulk-category').waitFor();
  await page.locator('#search').fill('Synthetic');
  await page.locator('#category-filter').selectOption({label:'Groceries'});
  await page.getByText('Synthetic Market',{exact:true}).waitFor();
  assert.equal(await page.getByText('Synthetic bulk market',{exact:true}).count(),0,'source category filter excludes the transaction after it receives an override');
  await page.locator('#category-filter').selectOption({label:'Shopping'});
  await page.getByText('Synthetic bulk market',{exact:true}).waitFor();
  const scopedExportDownload=page.waitForEvent('download');await page.locator('#export').click();
  const scopedExport=await scopedExportDownload,path=await scopedExport.path(),scopedCSV=await readFile(path,'utf8');
  assert.match(scopedCSV,/Synthetic bulk market/,'category-scoped exports include the matching effective-category transaction');
  assert.doesNotMatch(scopedCSV,/Synthetic Market/,'category-scoped exports exclude other source-category transactions');
  await page.locator('#category-filter').selectOption('');
  await page.locator('#undo-bulk-category').click();
  await page.getByText('Synthetic bulk market',{exact:true}).waitFor();
  const exportDownload=page.waitForEvent('download');await page.locator('#export').click();assert.match((await exportDownload).suggestedFilename(),/^ledger-.*\.csv$/);

  await page.locator('[data-view="budgets"]').first().click();
  await page.locator('[data-new-category]').click();
  const categoryDialog=page.getByRole('dialog');
  await categoryDialog.getByText('begins in the current reporting month').waitFor();
  await categoryDialog.locator('#new-category-name').fill('Browser test category');
  await categoryDialog.getByRole('button',{name:'Create bucket'}).click();
  await page.getByText('Browser test category',{exact:true}).first().waitFor();
  const categoryName=page.locator('.category-manage-row input').first();
  await categoryName.fill('Browser renamed category');await categoryName.press('Tab');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.category-manage-row input')?.value==='Browser renamed category');
  assert.equal(await page.locator('.category-manage-row input').first().inputValue(),'Browser renamed category','keyboard submission renames a category');
  const budgetForm=page.locator('form[data-budget]').first();
  await budgetForm.locator('input[name="amount"]').fill('0');await budgetForm.locator('button[type="submit"]').click();
  await page.getByRole('status').filter({hasText:'Budget saved.'}).waitFor();

  await page.locator('[data-view="accounts"]').first().click();
  await page.locator('#add-account').click();
  const addAccountDialog=page.getByRole('dialog');await addAccountDialog.locator('#add-manual').click();
  const accountDialog=page.getByRole('dialog');
  await accountDialog.locator('#manual-name').fill('Synthetic savings checking');
  await accountDialog.locator('#manual-type').selectOption('depository');
  await accountDialog.locator('#manual-balance').fill('1000');
  await accountDialog.locator('#manual-asof').fill('2026-10-25');
  await accountDialog.getByRole('button',{name:'Save account'}).click();
  await page.getByText('Synthetic savings checking',{exact:true}).first().waitFor();

  await page.locator('[data-view="goals"]').first().click();
  await page.locator('#new-goal').click();
  const goalDialog=page.getByRole('dialog');
  await goalDialog.locator('#goal-name').fill('Browser emergency goal');
  await goalDialog.locator('#goal-target').fill('250');
  await goalDialog.locator('#goal-date').fill('2027-12-31');
  await audit('goal-dialog');
  await goalDialog.getByRole('button',{name:'Save goal'}).click();
  await page.getByText('Browser emergency goal',{exact:true}).first().waitFor();
  await page.locator('[data-allocate-goal]').first().click();
  const allocationDialog=page.getByRole('dialog');
  await allocationDialog.locator('[data-allocation-account]').fill('500');
  await allocationDialog.getByRole('button',{name:'Save allocations'}).click();
  await page.getByText(/Scheduled month-end contributions:.*2026-10-31/).waitFor();

  await page.locator('[data-view="home"]').first().click();
  await page.locator('#new-scenario').click();
  const scenarioDialog=page.getByRole('dialog');
  await scenarioDialog.locator('[name="name"]').fill('Browser purchase estimate');
  await scenarioDialog.locator('[name="purchasePrice"]').fill('250000');
  await scenarioDialog.locator('[name="downPayment"]').fill('25000');
  await scenarioDialog.locator('[name="termMonths"]').fill('360');
  await scenarioDialog.locator('[name="noteRatePercent"]').fill('6.5');
  while(await scenarioDialog.locator('details:not([open]) > summary').count())await scenarioDialog.locator('details:not([open]) > summary').first().click();
  for(const field of ['financedFees','propertyTaxMonthly','homeownersInsuranceMonthly','supplementaryInsuranceMonthly','hoaMonthly','maintenanceReserveMonthly','subordinateDebtMonthly','closingCosts','prepaids','credits','earnestPaid','movingCosts','initialRepairs','retainedReserve','pointsCents'])await scenarioDialog.locator(`[name="${field}"]`).fill('0');
  await scenarioDialog.locator('[name="pmiExplicitNone"]').check();
  await scenarioDialog.locator('[name="rateSource"]').fill('Synthetic browser check');
  await audit('scenario-dialog');
  await scenarioDialog.getByRole('button',{name:'Save scenario'}).click();
  await page.getByText('Browser purchase estimate',{exact:true}).first().waitFor();

  const mobileControls=await page.locator('nav[aria-label="Main navigation"] button').evaluateAll(buttons=>buttons.map(button=>Math.round(button.getBoundingClientRect().height)));
  assert.ok(mobileControls.every(height=>height>=44),`mobile navigation controls are at least 44px high: ${mobileControls}`);

  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:900});
    const overflow=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
    assert.ok(overflow.document<=overflow.viewport+1&&overflow.body<=overflow.viewport+1,`horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`);
    await audit(`category-${width}px`);
  }
  await page.setViewportSize({width:720,height:900});
  const zoomOverflow=await page.evaluate(()=>{const content=document.querySelector('.content');return{effectiveViewport:innerWidth,contentWidth:content?.clientWidth,contentScrollWidth:content?.scrollWidth,document:document.documentElement.scrollWidth};});
  assert.ok(zoomOverflow.contentScrollWidth<=zoomOverflow.contentWidth+1,`essential content overflows at 200% zoom-equivalent 720 CSS px: ${JSON.stringify(zoomOverflow)}`);
  await audit('category-200%-zoom');
  if(failures.length)throw new Error('Serious accessibility violations: '+JSON.stringify(failures));
  console.log('Browser acceptance passed: 1440/390/320 px layout, 720 CSS px at 200% zoom, import preview/commit/undo, category and budget edits, goal/scenario saves, keyboard workflows, and zero serious/critical axe violations across tested views.');
}finally{
  await browser?.close();
  if(child.exitCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await closed;}
  await rm(directory,{recursive:true,force:true});
}
