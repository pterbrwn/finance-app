import Decimal from 'decimal.js';
import { isFreshObservation } from './dates.mjs';

Decimal.set({precision:40,rounding:Decimal.ROUND_HALF_UP});
const addSafeCents=(total,amount,label)=>{
  const result=total+amount;
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(amount)||!Number.isSafeInteger(result))throw new RangeError(`${label} exceeds the safe integer-cent range.`);
  return result;
};
const roundCents=value=>{
  const result=new Decimal(value).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();
  if(!Number.isSafeInteger(result))throw new RangeError('Loan projection exceeds the safe integer-cent range.');
  return result;
};

export function amortizeFixedRate({principal,annualRatePercent,termMonths,extraPrincipal=0,scheduledPayment=null}){
  const invalid='Enter a positive balance, a term from 1 to 1,200 months, and non-negative extra principal.';
  if(!Number.isSafeInteger(principal)||principal<=0||!Number.isSafeInteger(termMonths)||termMonths<1||termMonths>1200||!Number.isSafeInteger(extraPrincipal)||extraPrincipal<0||scheduledPayment!==null&&(!Number.isSafeInteger(scheduledPayment)||scheduledPayment<=0||extraPrincipal>Number.MAX_SAFE_INTEGER-scheduledPayment))return{available:false,reason:invalid};
  let annualRate;try{annualRate=new Decimal(annualRatePercent);}catch{return{available:false,reason:'Enter a valid annual note rate.'};}
  if(!annualRate.isFinite()||annualRate.isNegative()||annualRate.greaterThan(100))return{available:false,reason:'Annual rate must be between 0 and 100 percent.'};
  try{
    const opening=new Decimal(principal),monthlyRate=annualRate.div(1200);
    const exactPayment=monthlyRate.isZero()?opening.div(termMonths):opening.mul(monthlyRate).div(new Decimal(1).minus(new Decimal(1).plus(monthlyRate).pow(-termMonths)));
    const payment=scheduledPayment??roundCents(exactPayment),firstInterest=roundCents(opening.mul(monthlyRate));
    if(!Number.isSafeInteger(payment))throw new RangeError('Loan projection exceeds the safe integer-cent range.');
    if(payment<=firstInterest)return{available:false,reason:'The scheduled payment does not reduce principal; this input is non-amortizing.'};
    let balance=principal,totalInterest=0;const schedule=[];
    for(let period=1;period<=termMonths&&balance>0;period++){
      const interest=roundCents(new Decimal(balance).mul(monthlyRate));
      const scheduledPrincipal=Math.max(0,payment-interest),principalCapacity=addSafeCents(scheduledPrincipal,extraPrincipal,'Loan principal payment'),principalPaid=period===termMonths?balance:Math.min(balance,principalCapacity);
      if(principalPaid<=0)return{available:false,reason:'The modeled payment does not reduce principal.'};
      const closing=balance-principalPaid,paid=addSafeCents(interest,principalPaid,'Loan payment');
      if(period===termMonths&&scheduledPayment!==null&&paid>addSafeCents(scheduledPayment,extraPrincipal,'Loan payment'))return{available:false,reason:'The scheduled payment leaves a balloon at maturity. Enter a payment that fully amortizes this loan or use a loan type with an explicit balloon balance.'};
      schedule.push({period,openingBalance:balance,scheduledPayment:Math.min(payment,paid),extraPrincipal:Math.min(extraPrincipal,Math.max(0,principalPaid-Math.max(0,payment-interest))),interest,principal:principalPaid,closingBalance:closing,totalPayment:paid});
      totalInterest=addSafeCents(totalInterest,interest,'Total loan interest');balance=closing;
    }
    return{available:balance===0,payment,termMonths:schedule.length,totalInterest,totalPaid:addSafeCents(principal,totalInterest,'Total loan payments'),schedule,rounding:'Round-half-up to cents for regular payment and period interest; extra principal is applied after interest; final payment is capped at remaining principal plus interest.'};
  }catch(error){
    if(error instanceof RangeError)return{available:false,reason:'Projected loan totals exceed the safe integer-cent range.'};
    throw error;
  }
}

export function compareAmortization(input){
  const base=amortizeFixedRate({...input,extraPrincipal:0}),extra=amortizeFixedRate(input);
  if(!base.available||!extra.available)return{available:false,base,extra};
  return{available:true,base,extra,interestSaved:Math.max(0,base.totalInterest-extra.totalInterest),monthsSaved:Math.max(0,base.termMonths-extra.termMonths)};
}

export function summarizeProperties(properties=[],mortgages=[],accounts=[],items=[],asOf=new Date()){
  const activeProperties=properties.filter(property=>!property.archivedAt),activeMortgages=mortgages.filter(mortgage=>!mortgage.archivedAt);
  const accountById=new Map(accounts.map(account=>[account.id,account]));
  const itemById=new Map(items.map(item=>[item.id,item]));
  const rows=activeProperties.map(property=>{
    const liens=activeMortgages.filter(mortgage=>mortgage.propertyId===property.id).map(mortgage=>{
      const projection=mortgage.loanType==='fixed'&&mortgage.originalPrincipal!==null&&mortgage.annualRatePercent!==null&&mortgage.termMonths!==null?compareAmortization({principal:mortgage.originalPrincipal,annualRatePercent:mortgage.annualRatePercent,termMonths:mortgage.termMonths,extraPrincipal:mortgage.components?.extraPrincipal||0}):{available:false,reason:'Projection unavailable for this loan type or incomplete original terms.'};
      let projectedBalanceAtStatement=null;
      if(projection.available&&mortgage.originationDate&&mortgage.balanceAsOf){const start=new Date(mortgage.originationDate+'T12:00:00Z'),asOf=new Date(mortgage.balanceAsOf+'T12:00:00Z'),months=Math.max(0,(asOf.getUTCFullYear()-start.getUTCFullYear())*12+asOf.getUTCMonth()-start.getUTCMonth());projectedBalanceAtStatement=months===0?mortgage.originalPrincipal:projection.base.schedule[Math.min(months,projection.base.schedule.length)-1]?.closingBalance??0;}
      const linkedAccount=mortgage.linkedAccountId?accountById.get(mortgage.linkedAccountId):null,linkedAsOf=linkedAccount?.balanceAsOf||(linkedAccount?.itemId?(itemById.get(linkedAccount.itemId)?.lastSuccess||itemById.get(linkedAccount.itemId)?.lastSync):null)||null;
      return{...mortgage,balanceAsOf:mortgage.balanceAsOf||(!Number.isSafeInteger(mortgage.statementBalance)?linkedAsOf:null),projection,projectedBalanceAtStatement,balanceVariance:Number.isSafeInteger(projectedBalanceAtStatement)&&Number.isSafeInteger(mortgage.statementBalance)?mortgage.statementBalance-projectedBalanceAtStatement:null};
    }),value=Number.isSafeInteger(property.valuation)?property.valuation:null;
    let debt=0,ownerDebt=0,debtComplete=true;const seen=new Set();
    for(const mortgage of liens){
      if(mortgage.linkedAccountId){if(seen.has(mortgage.linkedAccountId)){debtComplete=false;continue;}seen.add(mortgage.linkedAccountId);}
      const account=mortgage.linkedAccountId?accountById.get(mortgage.linkedAccountId):null;
      const linkedAsOf=account?.balanceAsOf||(account?.itemId?(itemById.get(account.itemId)?.lastSuccess||itemById.get(account.itemId)?.lastSync):null)||null;
      const linkedBalanceEligible=account&&account.currency==='USD'&&!account.archivedAt&&account.includeInReporting!==false&&Number.isSafeInteger(account.balance)&&isFreshObservation(linkedAsOf,asOf,45);
      const balance=Number.isSafeInteger(mortgage.statementBalance)?mortgage.statementBalance:linkedBalanceEligible?Math.abs(account.balance):null;
      if(balance===null){debtComplete=false;continue;}debt=addSafeCents(debt,balance,'Property mortgage debt');
      if(Number.isSafeInteger(mortgage.ownerDebtShareBps))ownerDebt=addSafeCents(ownerDebt,roundCents(new Decimal(balance).mul(mortgage.ownerDebtShareBps).div(10000)),'Owner mortgage debt');
      else if(property.ownershipBps===10000)ownerDebt=addSafeCents(ownerDebt,balance,'Owner mortgage debt');
      else debtComplete=false;
    }
    const ownershipBps=Number.isSafeInteger(property.ownershipBps)?property.ownershipBps:10000;
    const ownerValue=value===null?null:roundCents(new Decimal(value).mul(ownershipBps).div(10000));
    return{...property,mortgages:liens.map(mortgage=>({...mortgage,linkedAccount: mortgage.linkedAccountId?accountById.get(mortgage.linkedAccountId)||null:null})),lienCount:liens.length,wholePropertyEquity:value===null||!debtComplete?null:value-debt,ownerValue,ownerDebt:debtComplete?ownerDebt:null,ownerEquity:ownerValue===null||!debtComplete?null:ownerValue-ownerDebt,debtComplete};
  });
  return{properties:rows,propertyCount:rows.length};
}
