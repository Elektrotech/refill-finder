// Öffnungszeiten-Parser.
// Die Angaben bei Karte von Morgen sind Freitext: mal OSM-Syntax ("Mo-Fr 08:00-18:00; Sa 09:00-13:00"),
// mal deutsche Prosa ("Montag bis Freitag von 8 bis 18 Uhr"). parseHours() versteht beides, solange
// der Text eindeutig ist, und gibt sonst null zurück – dann zeigt die App den Originaltext an,
// statt einen womöglich falschen "Geöffnet"-Status zu behaupten.

export const DAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

const DAY_INDEX = {
  mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6,
  di: 1, mi: 2, do: 3, so: 6,
};

// Reihenfolge ist wichtig: lange Wörter zuerst, damit "Montags" nicht zu "mos" wird.
const REPLACEMENTS = [
  [/\bmontags?\b|\bmonday\b|\bmon\b/g, 'mo'],
  [/\bdienstags?\b|\btuesday\b|\btue\b/g, 'di'],
  [/\bmittwochs?\b|\bwednesday\b|\bwed\b/g, 'mi'],
  [/\bdonnerstags?\b|\bthursday\b|\bthu\b|\bdon\b/g, 'do'],
  [/\bfreitags?\b|\bfriday\b|\bfri\b|\bfrei\b/g, 'fr'],
  [/\bsamstags?\b|\bsonnabends?\b|\bsaturday\b|\bsat\b/g, 'sa'],
  [/\bsonntags?\b|\bsunday\b|\bsun\b/g, 'so'],
  [/\b(t[äa]e?glich|jeden tag|daily)\b/g, 'mo-so'],
  [/\b(geschlossen|ruhetag|closed)\b/g, 'off'],
  [/\b(mo|di|mi|do|fr|sa|so|tu|we|th|su)\./g, '$1'],
  [/(\d{1,2})\.(\d{2})/g, '$1:$2'],
  [/(\d)\s*h\b/g, '$1'],
  [/\buhr\b/g, ''],
  [/\bvon\b/g, ''],
  [/\s+bis\s+|[–—]/g, '-'],
  [/\s+und\s+|&|\+/g, ','],
  [/\bph off\b/g, ''],
];

const TOKEN_RE = /\s+|(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?|([a-z]{2})\b|(off)\b|([;\n/|.])|(,)|(:)|(-)/y;

function tokenize(s) {
  const tokens = [];
  TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < s.length) {
    const start = TOKEN_RE.lastIndex;
    const m = TOKEN_RE.exec(s);
    if (!m || m.index !== start) return null;
    if (m[1] !== undefined) {
      const h1 = +m[1], m1 = +(m[2] || 0), h2 = +m[3], m2 = +(m[4] || 0);
      if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
      tokens.push({ t: 'time', from: h1 * 60 + m1, to: h2 * 60 + m2 });
    } else if (m[6] !== undefined) {
      tokens.push({ t: 'off' });
    } else if (m[5] !== undefined) {
      if (!(m[5] in DAY_INDEX)) return null;
      tokens.push({ t: 'day', d: DAY_INDEX[m[5]] });
    } else if (m[7] !== undefined) {
      tokens.push({ t: 'rule' });
    } else if (m[8] !== undefined) {
      tokens.push({ t: 'comma' });
    } else if (m[10] !== undefined) {
      tokens.push({ t: 'dash' });
    }
    // Leerzeichen und ":" (z. B. "Mo-Fr: 9-18") werden ignoriert.
  }
  return tokens;
}

function dayRange(a, b) {
  const days = [];
  for (let d = a; ; d = (d + 1) % 7) {
    days.push(d);
    if (d === b) break;
  }
  return days;
}

/**
 * @returns {null | {always: true} | {always: false, week: Array<Array<[number, number]>>}}
 *   week[0] = Montag; Intervalle in Minuten ab Mitternacht, Ende darf > 1440 sein (über Mitternacht).
 */
export function parseHours(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.toLowerCase().trim().replace(/;+\s*$/, '');
  if (/^(24\s*\/\s*7|mo-su 00:00-24:00|rund um die uhr)$/.test(s)) return { always: true };
  for (const [re, rep] of REPLACEMENTS) s = s.replace(re, rep);

  const tokens = tokenize(s);
  if (!tokens || !tokens.length) return null;

  const rules = [];
  let days = null;      // Tage der aktuellen Regel
  let times = [];       // Zeiten der aktuellen Regel
  let off = false;
  let additive = false; // durch Komma abgetrennte Regeln ergänzen statt zu überschreiben
  let sep = 'rule';     // letzter Trenner: 'rule' | 'comma' | null
  let pendingRange = false;

  const flush = () => {
    if (!days) return true;
    if (!times.length && !off) return false; // Tage ohne Zeiten: unklar
    rules.push({ days, times, off, additive });
    days = null; times = []; off = false;
    return true;
  };

  for (const tok of tokens) {
    if (tok.t === 'day') {
      if (pendingRange) {
        const from = days.pop();
        days.push(...dayRange(from, tok.d));
        pendingRange = false;
      } else if (days && !times.length && !off && sep === 'comma') {
        days.push(tok.d);
      } else if (days && !times.length && !off) {
        return null; // "Mo Di" ohne Trenner
      } else {
        const wasComma = sep === 'comma';
        if (!flush()) return null;
        days = [tok.d];
        additive = wasComma;
      }
      sep = null;
    } else if (tok.t === 'dash') {
      if (!days || times.length || off || sep !== null) return null;
      pendingRange = true;
    } else if (tok.t === 'time') {
      if (!days || pendingRange) return null;
      let { from, to } = tok;
      if (to <= from) to += 1440;
      times.push([from, to]);
      sep = null;
    } else if (tok.t === 'off') {
      if (!days || pendingRange) return null;
      off = true;
      sep = null;
    } else if (tok.t === 'comma') {
      if (pendingRange) return null;
      sep = 'comma';
    } else if (tok.t === 'rule') {
      if (pendingRange || !flush()) return null;
      sep = 'rule';
    }
  }
  if (pendingRange || !flush() || !rules.length) return null;

  const week = Array.from({ length: 7 }, () => []);
  for (const r of rules) {
    for (const d of r.days) {
      if (r.off) week[d] = [];
      else if (r.additive) week[d] = week[d].concat(r.times);
      else week[d] = r.times.slice();
    }
  }
  for (const day of week) day.sort((a, b) => a[0] - b[0]);
  if (week.every(d => !d.length)) return null;
  if (week.every(d => d.length === 1 && d[0][0] === 0 && d[0][1] >= 1440)) return { always: true };
  return { always: false, week };
}

export function formatMinutes(min) {
  const m = ((min % 1440) + 1440) % 1440;
  if (min === 1440) return '24:00';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Status zum Zeitpunkt `now`.
 * @returns {{open: boolean, soon?: boolean, text: string}}
 */
export function hoursStatus(parsed, now = new Date()) {
  if (!parsed) return null;
  if (parsed.always) return { open: true, text: 'Rund um die Uhr geöffnet' };
  const { week } = parsed;
  const today = (now.getDay() + 6) % 7;
  const mins = now.getHours() * 60 + now.getMinutes();
  const yesterday = (today + 6) % 7;

  const openInterval =
    week[today].find(([a, b]) => a <= mins && mins < b) ||
    week[yesterday].map(([a, b]) => [a - 1440, b - 1440]).find(([a, b]) => a <= mins && mins < b);
  if (openInterval) {
    const end = openInterval[1];
    return { open: true, soon: end - mins <= 60, text: `Geöffnet bis ${formatMinutes(end)}` };
  }

  for (let offset = 0; offset < 8; offset++) {
    const d = (today + offset) % 7;
    const next = week[d].find(([a]) => offset > 0 || a > mins);
    if (next) {
      const when = offset === 0 ? 'heute' : offset === 1 ? 'morgen' : DAY_SHORT[d];
      return { open: false, text: `Geschlossen · öffnet ${when} ${formatMinutes(next[0])}` };
    }
  }
  return { open: false, text: 'Geschlossen' };
}

/** Wochenübersicht für die Detailansicht, gleiche Tage werden zusammengefasst. */
export function weekTable(parsed) {
  if (!parsed) return null;
  if (parsed.always) return [{ days: 'Mo–So', hours: 'rund um die Uhr' }];
  const fmt = day => day.length ? day.map(([a, b]) => `${formatMinutes(a)}–${formatMinutes(b)}`).join(', ') : 'geschlossen';
  const rows = [];
  for (let d = 0; d < 7; d++) {
    const hours = fmt(parsed.week[d]);
    const last = rows[rows.length - 1];
    if (last && last.hours === hours && last.to === d - 1) {
      last.to = d;
    } else {
      rows.push({ from: d, to: d, hours });
    }
  }
  return rows.map(r => ({
    days: r.from === r.to ? DAY_LONG[r.from] : `${DAY_SHORT[r.from]}–${DAY_SHORT[r.to]}`,
    hours: r.hours,
    from: r.from,
    to: r.to,
  }));
}
