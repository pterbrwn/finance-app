export const STATE_KEY = 'finance/owner-v1.json';

export const blankState = () => ({
  version: 1,
  owner: null,
  items: [],
  accounts: [],
  transactions: [],
  holdings: [],
  goals: [],
  goalAllocations: [],
  goalAllocationLedger: [],
  properties: [],
  mortgages: [],
  mortgageSnapshots: [],
  scenarios: [],
  customCategories: [],
  budgets: {},
  lastSync: null,
  lease: null
});

export function createStateRepository(store) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') {
    throw new TypeError('State storage must provide get and conditional put methods.');
  }

  async function read() {
    const object = await store.get(STATE_KEY);
    return { state: object ? await object.json() : blankState(), etag: object?.etag };
  }

  async function mutate(update) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, etag } = await read();
      await update(state);
      const saved = await store.put(STATE_KEY, JSON.stringify(state), {
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' }
      });
      if (saved) return state;
    }
    throw Object.assign(new Error('Another update is in progress. Please try again.'), { status: 409 });
  }

  return Object.freeze({ read, mutate });
}

const repositories = new WeakMap();

export function repositoryFor(environment) {
  if (environment.REPOSITORY) return environment.REPOSITORY;
  if (!environment.BUCKET) throw Object.assign(new Error('Storage is unavailable. Please try again later.'), { status: 503 });
  if (!repositories.has(environment)) repositories.set(environment, createStateRepository(environment.BUCKET));
  return repositories.get(environment);
}
