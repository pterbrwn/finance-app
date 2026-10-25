const origin = 'http://127.0.0.1:' + (process.env.PORT || '3000');
try {
  const stateResponse = await fetch(origin + '/api/state', { signal: AbortSignal.timeout(10_000) });
  if (!stateResponse.ok) throw new Error();
  const state = await stateResponse.json();
  if (!state.setup.configured || !state.items.length) {
    console.log('Bank sync skipped: bank setup is incomplete.');
  } else {
    const response = await fetch(origin + '/api/scheduled-sync', { method: 'POST', signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !(await response.json()).ok) throw new Error();
    console.log('Bank sync completed.');
  }
} catch {
  console.error('Bank sync needs attention. Check the local dashboard and Ledger service.');
  process.exitCode = 1;
}
