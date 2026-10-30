const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
const validProfiles = new Set(['combined','peter','maddie']);
const validOwners = new Set(['','peter','maddie','joint']);

export function readViewState(href, currentMonth, views) {
  const params = new URL(href).searchParams;
  const requestedMonth = params.get('month');
  const requestedView = params.get('page');

  return {
    view: views.includes(requestedView) ? requestedView : 'overview',
    viewProfile: validProfiles.has(params.get('profile')) ? params.get('profile') : 'combined',
    ownerFilter: params.get('profile')==='joint'?'joint':validOwners.has(params.get('owner')||'') ? params.get('owner')||'' : '',
    month: requestedMonth && validMonth.test(requestedMonth) ? requestedMonth : currentMonth,
    search: (params.get('search') || '').slice(0, 120),
    filter: (params.get('category') || '').slice(0, 80),
    accountFilter: (params.get('account') || '').slice(0, 120),
    fromDate: (params.get('from') || '').slice(0, 10),
    toDate: (params.get('to') || '').slice(0, 10),
    reviewOnly: params.get('review') === 'true',
    transactionPageNumber: Math.max(1, Number(params.get('txpage')) || 1)
  };
}

export function writeViewState(pathname, state, currentMonth) {
  const params = new URLSearchParams();
  if (state.view !== 'overview') params.set('page', state.view);
  if (state.viewProfile && state.viewProfile !== 'combined') params.set('profile', state.viewProfile);
  if (state.ownerFilter) params.set('owner', state.ownerFilter);
  if (state.month !== currentMonth) params.set('month', state.month);
  if (state.search) params.set('search', state.search);
  if (state.filter) params.set('category', state.filter);
  if (state.accountFilter) params.set('account', state.accountFilter);
  if (state.fromDate) params.set('from', state.fromDate);
  if (state.toDate) params.set('to', state.toDate);
  if (state.reviewOnly) params.set('review', 'true');
  if (state.view === 'transactions' && state.transactionPageNumber > 1) {
    params.set('txpage', String(state.transactionPageNumber));
  }

  const query = params.toString();
  return pathname + (query ? '?' + query : '');
}
