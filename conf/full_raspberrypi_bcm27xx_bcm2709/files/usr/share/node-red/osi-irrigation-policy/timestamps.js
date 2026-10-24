'use strict';

function parseInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const sqlite = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(text);
  const dateParts = sqlite || iso;
  if (!dateParts) return null;
  const year = Number(dateParts[1]); const month = Number(dateParts[2]); const day = Number(dateParts[3]);
  const hour = sqlite ? Number(dateParts[4]) : 0; const minute = sqlite ? Number(dateParts[5]) : 0; const second = sqlite ? Number(dateParts[6]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const calendar = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
      || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second) return null;
  if (sqlite) return calendar.getTime();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = { parseInstant };
