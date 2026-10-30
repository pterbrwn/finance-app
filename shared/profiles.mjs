export const PROFILE_IDS=Object.freeze(['peter','maddie','joint']);
export const PROFILE_LABELS=Object.freeze({peter:'Peter',maddie:'Maddie',joint:'Joint'});
export const COMBINED_PROFILE='combined';
export const REPORTING_PROFILES=Object.freeze([...PROFILE_IDS,COMBINED_PROFILE]);

export function normalizeProfileId(value,{allowCombined=false}={}){
  const allowed=allowCombined?REPORTING_PROFILES:PROFILE_IDS;
  if(typeof value!=='string'||!allowed.includes(value))throw new TypeError('Choose Peter, Maddie, Joint, or Combined.');
  return value;
}

export function effectiveTransactionProfile(transaction,account){
  const override=transaction?.profileId;
  if(override!==undefined&&override!==null)return normalizeProfileId(override);
  const owner=account?.profileId;
  return owner===undefined||owner===null?null:normalizeProfileId(owner);
}

export function profileMatches(ownerId,viewProfile){
  const view=normalizeProfileId(viewProfile,{allowCombined:true});
  if(view===COMBINED_PROFILE)return true;
  return ownerId===view;
}

export function groupByProfile(rows=[],getOwner=row=>row?.profileId){
  const totals={peter:[],maddie:[],joint:[],unassigned:[]};
  for(const row of rows){const owner=getOwner(row);if(owner===null||owner===undefined)totals.unassigned.push(row);else totals[normalizeProfileId(owner)].push(row);}
  return totals;
}

export function combinedAmountByProfile(rows=[],getAmount=row=>row?.amountCents,getOwner=row=>row?.profileId){
  const totals={peter:0,maddie:0,joint:0,unassigned:0};
  for(const row of rows){const owner=getOwner(row),amount=getAmount(row);if(!Number.isSafeInteger(amount))throw new TypeError('Profile totals require integer cents.');const key=owner===null||owner===undefined?'unassigned':normalizeProfileId(owner);const result=totals[key]+amount;if(!Number.isSafeInteger(result))throw new RangeError('Combined profile total exceeds the safe integer-cent range.');totals[key]=result;}
  totals.combined=totals.peter+totals.maddie+totals.joint+totals.unassigned;
  if(!Number.isSafeInteger(totals.combined))throw new RangeError('Combined profile total exceeds the safe integer-cent range.');
  return totals;
}
