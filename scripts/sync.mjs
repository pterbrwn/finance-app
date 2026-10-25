const origin = 'http://127.0.0.1:' + (process.env.PORT || '3000');
const request = async (path, options) => {
  const response = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Local sync request failed.');
  return payload;
};
try {
  const state = await request('/api/state');
  if (!state.setup.configured || !state.items.some(item => item.lifecycle !== 'unlinked')) {
    console.log('Bank sync skipped: bank setup is incomplete or no linked provider is available.');
  } else {
    const { job: started } = await request('/api/scheduled-sync', { method: 'POST' });
    if (!started?.id) {
      console.log('Bank sync skipped: no linked provider is available.');
    } else {
      const deadline = Date.now() + 15 * 60_000;
      let job = started;
      while (job.id === started.id && job.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2_000));
        ({ job } = await request('/api/sync-status'));
      }
      if (job?.id !== started.id || job.status !== 'succeeded') throw new Error('Bank sync did not finish successfully. Check the local dashboard.');
      console.log('Bank sync completed.');
    }
  }
} catch {
  console.error('Bank sync needs attention. Check the local dashboard and Ledger service.');
  process.exitCode = 1;
}
