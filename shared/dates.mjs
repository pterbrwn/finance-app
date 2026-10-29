export function reportingDate(value=new Date()) {
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  const instant=value instanceof Date&&Number.isFinite(value.getTime())?value:new Date(value);
  if(!Number.isFinite(instant.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);
  return `${parts.find(part=>part.type==='year').value}-${parts.find(part=>part.type==='month').value}-${parts.find(part=>part.type==='day').value}`;
}

export function observationAgeDays(observedAt,asOf=new Date()) {
  if(typeof observedAt!=='string'||!observedAt)return Infinity;
  if(/^\d{4}-\d{2}-\d{2}$/.test(observedAt)){
    const observed=new Date(observedAt+'T12:00:00Z'),current=new Date(reportingDate(asOf)+'T12:00:00Z');
    if(!Number.isFinite(observed.getTime())||observed.toISOString().slice(0,10)!==observedAt)return Infinity;
    return (current.getTime()-observed.getTime())/86_400_000;
  }
  const instant=Date.parse(observedAt),current=asOf instanceof Date?asOf.getTime():Date.parse(typeof asOf==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(asOf)?asOf+'T12:00:00Z':asOf);
  return Number.isFinite(instant)&&Number.isFinite(current)?(current-instant)/86_400_000:Infinity;
}

export function isFreshObservation(observedAt,asOf=new Date(),maxAgeDays=1) {
  const age=observationAgeDays(observedAt,asOf);
  return age>=0&&age<=maxAgeDays;
}
