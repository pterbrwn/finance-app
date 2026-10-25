import { amortizeFixedRate } from './mortgages.mjs';

export const SCENARIO_CALCULATION_VERSION='purchase-v1';
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
const AMOUNT_FIELDS=['purchasePrice','downPayment','financedFees','pmiMonthly','propertyTaxMonthly','homeownersInsuranceMonthly','supplementaryInsuranceMonthly','hoaMonthly','maintenanceReserveMonthly','subordinateDebtMonthly','closingCosts','prepaids','credits','earnestPaid','movingCosts','initialRepairs','retainedReserve','otherDebtPayments','currentNonHousingCommitments','currentHousingCost','plannedSavings','safetyMargin','pointsCents'];
export function validateScenarioInput(input={}){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>100)return'Enter a scenario name up to 100 characters.';
  for(const field of AMOUNT_FIELDS){const value=input[field];if(value!==null&&value!==undefined&&(!Number.isSafeInteger(value)||value<0||value>100_000_000_000_000))return'Enter non-negative currency amounts in cents.';}
  if(!Number.isSafeInteger(input.purchasePrice)||input.purchasePrice<=0||!Number.isSafeInteger(input.downPayment)||input.downPayment>input.purchasePrice)return'Down payment must be between zero and the purchase price.';
  if(!Number.isSafeInteger(input.termMonths)||input.termMonths<1||input.termMonths>1200)return'Choose a loan term from 1 to 1,200 months.';
  const rate=String(input.noteRatePercent??'');if(!/^\d{1,3}(?:\.\d{1,8})?$/.test(rate)||Number(rate)>100)return'Enter a note rate between 0 and 100 percent.';
  for(const field of ['aprPercent'])if(input[field]!==null&&input[field]!==undefined&&(!/^\d{1,3}(?:\.\d{1,8})?$/.test(String(input[field]))||Number(input[field])>100))return'Enter a valid APR.';
  for(const field of ['netMonthlyIncome','grossMonthlyIncome'])if(input[field]!==null&&input[field]!==undefined&&(!Number.isSafeInteger(input[field])||input[field]<0))return'Income must be a non-negative amount.';
  if(input.pmiExplicitNone!==true&&(input.pmiMonthly===null||input.pmiMonthly===undefined))return'Enter a PMI estimate or explicitly select no PMI.';
  if(input.taxEscrowed!==undefined&&typeof input.taxEscrowed!=='boolean'||input.insuranceEscrowed!==undefined&&typeof input.insuranceEscrowed!=='boolean'||input.replaceCurrentHousing!==undefined&&typeof input.replaceCurrentHousing!=='boolean')return'Choose valid escrow and current-housing options.';
  if(input.targetDate&&!validDate(input.targetDate))return'Enter a valid target date.';
  if(!validDate(input.rateAsOf))return'Enter the date for this rate assumption.';
  if(input.lockExpiration&&!validDate(input.lockExpiration))return'Enter a valid rate lock expiration.';
  if(input.quoteType&&!['estimate','quote'].includes(input.quoteType))return'Choose estimate or quote.';
  if(typeof input.rateSource!=='string'||!input.rateSource.trim()||input.rateSource.length>120)return'Enter a rate source up to 120 characters.';
  return null;
}

export function calculateHomeScenario(input={},funding={}){
  const error=validateScenarioInput(input);if(error)return{available:false,error};
  const amount=field=>input[field]||0,loanPrincipal=input.purchasePrice-input.downPayment+amount('financedFees');
  const amortization=loanPrincipal?amortizeFixedRate({principal:loanPrincipal,annualRatePercent:input.noteRatePercent,termMonths:input.termMonths}):{available:true,payment:0,schedule:[],totalInterest:0,totalPaid:0,termMonths:0};
  if(!amortization.available)return{available:false,error:amortization.reason};
  const tax=amount('propertyTaxMonthly'),insurance=amount('homeownersInsuranceMonthly')+amount('supplementaryInsuranceMonthly'),pmi=input.pmiExplicitNone?0:amount('pmiMonthly'),hoa=amount('hoaMonthly'),maintenance=amount('maintenanceReserveMonthly'),subordinate=amount('subordinateDebtMonthly');
  const escrowedTaxes=input.taxEscrowed===true,escrowedInsurance=input.insuranceEscrowed===true;
  const lenderPayment=amortization.payment+pmi+(escrowedTaxes?tax:0)+(escrowedInsurance?insurance:0);
  const ownershipOutflow=lenderPayment+(escrowedTaxes?0:tax)+(escrowedInsurance?0:insurance)+hoa+maintenance+subordinate;
  const remainingCashToClose=Math.max(0,input.downPayment+amount('closingCosts')+amount('prepaids')+amount('pointsCents')-amount('credits')-amount('earnestPaid'));
  const allInAcquisitionFunding=remainingCashToClose+amount('movingCosts')+amount('initialRepairs')+amount('retainedReserve');
  const eligibleCash=Math.max(0,funding.eligibleCash||0),allocatedGoalFunds=Math.max(0,funding.allocatedGoalFunds||0),availableFunds=eligibleCash+allocatedGoalFunds;
  const fundingShortfall=Math.max(0,allInAcquisitionFunding-availableFunds),cashAfterClosing=availableFunds-remainingCashToClose-amount('movingCosts')-amount('initialRepairs');
  const gross=input.grossMonthlyIncome;
  const dtiHousing=amortization.payment+tax+insurance+pmi+hoa+subordinate;
  const dtiPercent=Number.isSafeInteger(gross)&&gross>0?(dtiHousing+amount('otherDebtPayments'))/gross*100:null;
  const net=input.netMonthlyIncome,existingHousing=input.replaceCurrentHousing?0:amount('currentHousingCost');
  const cashFlowSurplus=Number.isSafeInteger(net)?net-amount('currentNonHousingCommitments')-existingHousing-ownershipOutflow-amount('plannedSavings')-amount('safetyMargin'):null;
  const rateSensitivity=[-100,-50,50,100,200].map(delta=>{const rate=Math.max(0,Number(input.noteRatePercent)+delta/100);const pi=loanPrincipal?amortizeFixedRate({principal:loanPrincipal,annualRatePercent:String(rate),termMonths:input.termMonths}):{available:true,payment:0};return{changeBps:delta,ratePercent:rate,available:pi.available,payment:pi.available?pi.payment:null,ownershipOutflow:pi.available?ownershipOutflow-amortization.payment+pi.payment:null};});
  const taxInsuranceSensitivity=[10,20].map(percent=>({increasePercent:percent,ownershipOutflow:ownershipOutflow+Math.round((tax+insurance)*percent/100)}));
  const incomeSensitivity=[10,20].map(percent=>({decreasePercent:percent,cashFlowSurplus:Number.isSafeInteger(net)?cashFlowSurplus-Math.round(net*percent/100):null}));
  const maintenanceSensitivity=[10,20].map(percent=>({increasePercent:percent,ownershipOutflow:ownershipOutflow+Math.round(maintenance*percent/100)}));
  return{available:true,calculationVersion:SCENARIO_CALCULATION_VERSION,loanPrincipal,principalAndInterest:amortization.payment,modeledTotalInterest:amortization.totalInterest,termMonths:amortization.termMonths,lenderPayment,ownershipOutflow,monthlyComponents:{principalAndInterest:amortization.payment,pmi,taxes:tax,insurance,hoa,maintenanceReserve:maintenance,subordinateDebt:subordinate,lenderPayment},remainingCashToClose,allInAcquisitionFunding,alreadyPaid:amount('earnestPaid'),eligibleCash,allocatedGoalFunds,availableFunds,fundingShortfall,cashAfterClosing,retainedReserve:amount('retainedReserve'),dtiHousing,dtiPercent,cashFlowSurplus,currentHousingReplaced:input.replaceCurrentHousing===true,rateSource:input.rateSource||'Manual assumption',rateAsOf:input.rateAsOf||null,quoteType:input.quoteType||'estimate',aprPercent:input.aprPercent??null,pointsCents:amount('pointsCents'),lockExpiration:input.lockExpiration||null,fundingAsOf:funding.asOf||null,rateSensitivity,taxInsuranceSensitivity,incomeSensitivity,maintenanceSensitivity};
}
