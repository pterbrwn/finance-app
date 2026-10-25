import { cents } from './money.mjs';

export function providerAccountKey(itemId, accountId) {
  return `plaid:${encodeURIComponent(itemId)}:${encodeURIComponent(accountId)}`;
}

export function accountRecord(account, itemId) {
  return {
    id: providerAccountKey(itemId, account.account_id),
    providerAccountId: account.account_id,
    itemId,
    name: account.name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    balance: cents(account.balances.current),
    availableBalance: cents(account.balances.available),
    currency: account.balances.iso_currency_code || account.balances.unofficial_currency_code || 'UNKNOWN'
  };
}

export function investmentHoldings(data, itemId) {
  const securities = new Map(data.securities.map(security => [security.security_id, security]));
  return data.holdings.map(holding => {
    const security = securities.get(holding.security_id);
    return {
      itemId,
      accountId: providerAccountKey(itemId, holding.account_id),
      securityId: holding.security_id,
      name: security?.name || 'Unnamed holding',
      ticker: security?.ticker_symbol || null,
      quantity: holding.quantity,
      value: cents(holding.institution_value),
      costBasis: cents(holding.cost_basis),
      currency: holding.iso_currency_code || holding.unofficial_currency_code || 'UNKNOWN',
      asOf: holding.institution_price_as_of || security?.close_price_as_of || null
    };
  });
}
