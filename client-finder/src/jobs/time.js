// Timezone helpers without external libraries.

function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
export function zonedToUtc(y, m, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone); // second pass handles DST edges
  return new Date(ts);
}

export function localDateParts(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  return { y: parts.year, m: parts.month, d: parts.day };
}

export function localDateString(date, timeZone) {
  const { y, m, d } = localDateParts(date, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Next occurrence of HH:MM local time strictly after `from`. */
export function nextDailyRun(hhmm, timeZone, from = new Date()) {
  const [hh, mm] = hhmm.split(':').map(Number);
  let { y, m, d } = localDateParts(from, timeZone);
  for (let i = 0; i < 3; i++) {
    const candidate = zonedToUtc(y, m, d, hh, mm, timeZone);
    if (candidate > from) return candidate;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  throw new Error('Could not compute next run');
}
