// Testfälle für js/hours.js – Eingaben stammen überwiegend aus echten Karte-von-Morgen-Einträgen.
import { parseHours, hoursStatus, weekTable } from '../js/hours.js';

const H = (h, m = 0) => h * 60 + m;
// 2026-10-26 ist ein Montag.
const at = (dayOffset, h, m = 0) => new Date(2026, 9, 26 + dayOffset, h, m);

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  erwartet: ${e}\n  erhalten: ${a}`);
}

test('OSM-Syntax mit mehreren Regeln', () => {
  const p = parseHours('Mo-Th 10:00-13:00,14:00-17:30; Fr 10:00-13:00,14:00-16:00');
  eq(p.week[0], [[H(10), H(13)], [H(14), H(17, 30)]]);
  eq(p.week[4], [[H(10), H(13)], [H(14), H(16)]]);
  eq(p.week[5], []);
});

test('Spätere Regel überschreibt Tag (OSM-Semantik)', () => {
  const p = parseHours('Mo 08:30-17:00; Tu-Fr 08:30-13:00; Th 08:30-18:00');
  eq(p.week[3], [[H(8, 30), H(18)]]);
  eq(p.week[2], [[H(8, 30), H(13)]]);
});

test('Komma-Regel ergänzt Tag', () => {
  const p = parseHours('Mo-Fr 08:00-12:00, Do 13:30-18:00');
  eq(p.week[3], [[H(8), H(12)], [H(13, 30), H(18)]]);
});

test('Deutsche Kurzformen mit Punkten und Uhr', () => {
  const p = parseHours('Mo.-Fr. 7.00-19.00, Sa. 7.00– 14.00 Uhr, So geschlossen');
  eq(p.week[0], [[H(7), H(19)]]);
  eq(p.week[5], [[H(7), H(14)]]);
  eq(p.week[6], []);
});

test('Ausgeschriebene Tage mit "bis" und "von"', () => {
  const p = parseHours('Montag bis Samstag: 07:00 bis 20:00 Uhr');
  eq(p.week[5], [[H(7), H(20)]]);
  eq(p.week[6], []);
});

test('Volle Stunden ohne Minuten', () => {
  const p = parseHours('Mo-Fr 8-18 Uhr; Sa 8-16 Uhr');
  eq(p.week[1], [[H(8), H(18)]]);
  eq(p.week[5], [[H(8), H(16)]]);
});

test('Zeilenumbruch und Doppelpunkt nach Tagen', () => {
  const p = parseHours('Mo - Fr: 10.00 - 15.00\nSa: 12.00 - 16.00');
  eq(p.week[4], [[H(10), H(15)]]);
  eq(p.week[5], [[H(12), H(16)]]);
});

test('Schrägstrich trennt Regeln, Ruhetag', () => {
  const p = parseHours('Di. - So. 10.00 - 17.30 Uhr / Mo. Ruhetag');
  eq(p.week[0], []);
  eq(p.week[6], [[H(10), H(17, 30)]]);
});

test('"und" zwischen Zeiten und Tagesliste', () => {
  const p = parseHours('Dienstag, Donnerstag und Freitag: 09:30 bis 12:30 und 14:30 bis 18:30, Samstag 9:30 bis 13:00');
  eq(p.week[1], [[H(9, 30), H(12, 30)], [H(14, 30), H(18, 30)]]);
  eq(p.week[2], []);
  eq(p.week[5], [[H(9, 30), H(13)]]);
});

test('täglich', () => {
  const p = parseHours('täglich von 09.00-18.00');
  for (let d = 0; d < 7; d++) eq(p.week[d], [[H(9), H(18)]]);
});

test('24/7 und Mo-Su 00:00-24:00', () => {
  eq(parseHours('24/7'), { always: true });
  eq(parseHours('Mo-Su 00:00-24:00'), { always: true });
});

test('Über Mitternacht', () => {
  const p = parseHours('Fr-Sa 18:00-02:00');
  eq(p.week[4], [[H(18), H(26)]]);
  eq(hoursStatus(p, at(5, 1, 30)).open, true, 'Samstag 01:30 noch offen (von Freitag)');
  eq(hoursStatus(p, at(0, 1, 30)).open, false, 'Montag 01:30 geschlossen');
});

test('Wochenbereich über das Wochenende (Fr-Mo)', () => {
  const p = parseHours('Fr-Mo 10:00-12:00');
  eq(p.week.map(d => d.length), [1, 0, 0, 0, 1, 1, 1]);
});

test('Unklare Texte ergeben null', () => {
  for (const s of [
    'wenn ich zu Hause bin',
    'nach Bedarf',
    'https://www.globetrotter.de/filialen/wiesbaden/',
    '6:30-22:00',
    '8:30 - 18:30 Uhr, Sa bis 13:30 Uhr',
    'Mo-Fr: 9:00 - 13:00 Uhr;  Mi zusätzlich 15:00 - 19:00 Uhr',
    'Dienstag bis Sonntag: 9 bis 17 Uhr; Montags geschlossen! 7. November bis 25. Dezember geschlossen',
    'Jun-Sep Mo-Fr 09:00-18:00',
    'Mo Di 10:00-12:00',
    'Mo-Fr',
    '',
    null,
  ]) {
    eq(parseHours(s), null, `"${s}"`);
  }
});

test('Status: geöffnet, schließt bald, geschlossen', () => {
  const p = parseHours('Mo-Fr 09:00-18:00; Sa 10:00-14:00');
  eq(hoursStatus(p, at(0, 10)), { open: true, soon: false, text: 'Geöffnet bis 18:00' });
  eq(hoursStatus(p, at(0, 17, 30)).soon, true);
  eq(hoursStatus(p, at(0, 8)).text, 'Geschlossen · öffnet heute 09:00');
  eq(hoursStatus(p, at(4, 19)).text, 'Geschlossen · öffnet morgen 10:00');
  eq(hoursStatus(p, at(5, 15)).text, 'Geschlossen · öffnet Mo 09:00');
});

test('Status: Mittagspause', () => {
  const p = parseHours('Mo-Fr 08:00-12:00,14:00-16:00');
  eq(hoursStatus(p, at(0, 13)).text, 'Geschlossen · öffnet heute 14:00');
});

test('Status: rund um die Uhr', () => {
  eq(hoursStatus(parseHours('24/7'), at(2, 3)).open, true);
});

test('Wochentabelle fasst gleiche Tage zusammen', () => {
  const rows = weekTable(parseHours('Mo-Fr 09:00-18:00; Sa 10:00-14:00'));
  eq(rows.map(r => [r.days, r.hours]), [
    ['Mo–Fr', '09:00–18:00'],
    ['Samstag', '10:00–14:00'],
    ['Sonntag', 'geschlossen'],
  ]);
});
