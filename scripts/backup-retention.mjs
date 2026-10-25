import { basename } from 'node:path';

export function parseDailyBackupName(value) {
  const name = basename(value);
  const match = /^daily-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z\.sqlite$/.exec(name);
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  if (!Number.isFinite(date.getTime()) || `daily-${date.toISOString().replaceAll(':', '-')}.sqlite` !== name) return null;
  return { name, date };
}

function isoWeekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function retainedBackupNames(entries, { dailyCount = 7, weeklyCount = 4 } = {}) {
  const daily = entries
    .map(entry => {
      const parsed = parseDailyBackupName(entry.name);
      return parsed ? { ...entry, ...parsed } : null;
    })
    .filter(Boolean)
    .filter(entry => Number.isFinite(entry.date.getTime()))
    .sort((a, b) => b.date - a.date || a.name.localeCompare(b.name));
  const keep = new Set(daily.slice(0, dailyCount).map(entry => entry.name));
  const latestPerWeek = new Map();
  for (const entry of daily) {
    const key = isoWeekKey(entry.date);
    if (!latestPerWeek.has(key)) latestPerWeek.set(key, entry);
  }
  [...latestPerWeek.values()].slice(0, weeklyCount).forEach(entry => keep.add(entry.name));
  for (const entry of entries) {
    const name = basename(entry.name);
    if (/^pre-migration-\d+-to-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.sqlite$/.test(name)) keep.add(name);
  }
  return keep;
}
