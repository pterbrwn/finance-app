import Decimal from 'decimal.js';

Decimal.set({precision:40,rounding:Decimal.ROUND_HALF_UP});
const roundCents=value=>new Decimal(value).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();

export function amortizeFixedRate({principal,annualRatePercent,termMonths,extraPrincipal=0,scheduledPayment=null}){
  if(!Number.isSafeInteger(principal)||principal<=0||!Number.isSafeInteger(termMonths)||termMonths<1||termMonths>1200||!Number.isSafeInteger(extraPrincipal)||extraPrincipal<0||scheduledPayment!==null&&(!Number.isSafeInteger(scheduledPayment)||scheduledPayment<=0)) return{available:false,reason:'Enter a positive balance, a term from 1 to 1,200 months, and non-negative extra principal.'};
  let annualRate;try{annualRate=new Decimal(annualRatePercent);}catch{return{available:false,reason:'Enter a valid annual note rate.'};}
  if(!annualRate.isFinite()||annualRate.isNegative()||annualRate.greaterThan(100))return{available:false,reason:'Annual rate must be between 0 and 100 percent.'};
  const opening=new Decimal(principal),monthlyRate=annualRate.div(1200);
  const exactPayment=monthlyRate.isZero()?opening.div(termMonths):opening.mul(monthlyRate).div(new Decimal(1).minus(new Decimal(1).plus(monthlyRate).pow(-termMonths)));
  const payment=scheduledPayment??roundCents(exactPayment),firstInterest=roundCents(opening.mul(monthlyRate));
  if(payment<=firstInterest)return{available:false,reason:'The scheduled payment does not reduce principal; this input is non-amortizing.'};
  let balance=principal,totalInterest=0;const schedule=[];
  for(let period=1;period<=termMonths&&balance>0;period++){
    const interest=roundCents(new Decimal(balance).mul(monthlyRate));
    const scheduledPrincipal=Math.max(0,payment-interest),principalPaid=period===termMonths?balance:Math.min(balance,scheduledPrincipal+extraPrincipal);
    if(principalPaid<=0)return{available:false,reason:'The modeled payment does not reduce principal.'};
    const closing=balance-principalPaid,paid=interest+principalPaid;
    schedule.push({period,openingBalance:balance,scheduledPayment:Math.min(payment,paid),extraPrincipal:Math.min(extraPrincipal,Math.max(0,principalPaid-Math.max(0,payment-interest))),interest,principal:principalPaid,closingBalance:closing,totalPayment:paid});
    totalInterest+=interest;balance=closing;
  }
  return{available:balance===0,payment,termMonths: schedule.length,totalInterest,totalPaid:principal+totalInterest,schedule,rounding:'Round-half-up to cents for regular payment and period interest; extra principal is applied after interest; final payment is capped at remaining principal plus interest.'};
}

export function compareAmortization(input){
  const base=amortizeFixedRate({...input,extraPrincipal:0}),extra=amortizeFixedRate(input);
  if(!base.available||!extra.available)return{available:false,base,extra};
  return{available:true,base,extra,interestSaved:Math.max(0,base.totalInterest-extra.totalInterest),monthsSaved:Math.max(0,base.termMonths-extra.termMonths)};
}

export function summarizeProperties(properties=[],mortgages=[],accounts=[]){
  const activeProperties=properties.filter(property=>!property.archivedAt),activeMortgages=mortgages.filter(mortgage=>!mortgage.archivedAt);
  const accountById=new Map(accounts.map(account=>[account.id,account]));
  const rows=activeProperties.map(property=>{
    const liens=activeMortgages.filter(mortgage=>mortgage.propertyId===property.id).map(mortgage=>{
      const projection=mortgage.loanType==='fixed'&&mortgage.originalPrincipal!==null&&mortgage.annualRatePercent!==null&&mortgage.termMonths!==null?compareAmortization({principal:mortgage.originalPrincipal,annualRatePercent:mortgage.annualRatePercent,termMonths:mortgage.termMonths,extraPrincipal:mortgage.components?.extraPrincipal||0}):{available:false,reason:'Projection unavailable for this loan type or incomplete original terms.'};
      let projectedBalanceAtStatement=null;
      if(projection.available&&mortgage.originationDate&&mortgage.balanceAsOf){const start=new Date(mortgage.originationDate+'T12:00:00Z'),asOf=new Date(mortgage.balanceAsOf+'T12:00:00Z'),months=Math.max(0,(asOf.getUTCFullYear()-start.getUTCFullYear())*12+asOf.getUTCMonth()-start.getUTCMonth());projectedBalanceAtStatement=months===0?mortgage.originalPrincipal:projection.base.schedule[Math.min(months,projection.base.schedule.length)-1]?.closingBalance??0;}
      return{...mortgage,projection,projectedBalanceAtStatement,balanceVariance:Number.isSafeInteger(projectedBalanceAtStatement)&&Number.isSafeInteger(mortgage.statementBalance)?mortgage.statementBalance-projectedBalanceAtStatement:null};
    }),value=Number.isSafeInteger(property.valuation)?property.valuation:null;
    let debt=0,ownerDebt=0,debtComplete=true;const seen=new Set();
    for(const mortgage of liens){
      if(mortgage.linkedAccountId){if(seen.has(mortgage.linkedAccountId)){debtComplete=false;continue;}seen.add(mortgage.linkedAccountId);}
      const account=mortgage.linkedAccountId?accountById.get(mortgage.linkedAccountId):null;
      const balance=Number.isSafeInteger(mortgage.statementBalance)?mortgage.statementBalance:account&&Number.isSafeInteger(account.balance)?Math.abs(account.balance):null;
      if(balance===null){debtComplete=false;continue;}debt+=balance;
      if(Number.isSafeInteger(mortgage.ownerDebtShareBps))ownerDebt+=roundCents(new Decimal(balance).mul(mortgage.ownerDebtShareBps).div(10000));
      else if(property.ownershipBps===10000)ownerDebt+=balance;
      else debtComplete=false;
    }
    const ownershipBps=Number.isSafeInteger(property.ownershipBps)?property.ownershipBps:10000;
    const ownerValue=value===null?null:roundCents(new Decimal(value).mul(ownershipBps).div(10000));
    return{...property,mortgages:liens.map(mortgage=>({...mortgage,linkedAccount: mortgage.linkedAccountId?accountById.get(mortgage.linkedAccountId)||null:null})),lienCount:liens.length,wholePropertyEquity:value===null||!debtComplete?null:value-debt,ownerValue,ownerDebt:debtComplete?ownerDebt:null,ownerEquity:ownerValue===null||!debtComplete?null:ownerValue-ownerDebt,debtComplete};
  });
  return{properties:rows,propertyCount:rows.length};
}
