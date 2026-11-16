/**
 * Date ranges in the forms people and models naturally write:
 *   "2026-10"                   a month
 *   "2026-Q3"                   a quarter
 *   "2026"                      a year
 *   "2026-10-01..2026-10-15"    an inclusive range of days
 *   "2026-10-15"                one day
 */

/** A period the user or model wrote in a form we can't read. */
export class PeriodError extends Error {}

export interface Period {
  label: string;
  from: string; // YYYY-MM-DD, inclusive
  to: string; // YYYY-MM-DD, inclusive
}

export const PERIOD_HELP = 'A month ("2026-10"), quarter ("2026-Q3"), year ("2026"), day ("2026-10-15") or inclusive range ("2026-10-01..2026-10-15").';

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function validDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= lastDay(y, mo);
}

export function parsePeriod(input: string): Period {
  const s = input.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(s))) return { label: s, from: `${s}-01-01`, to: `${s}-12-31` };
  if ((m = /^(\d{4})-Q([1-4])$/i.exec(s))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const endMonth = q * 3;
    return { label: `${y}-Q${q}`, from: `${y}-${pad(endMonth - 2)}-01`, to: `${y}-${pad(endMonth)}-${pad(lastDay(y, endMonth))}` };
  }
  if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) throw new PeriodError(`Not a valid month: "${input}".`);
    return { label: s, from: `${s}-01`, to: `${s}-${pad(lastDay(y, mo))}` };
  }
  if (validDate(s)) return { label: s, from: s, to: s };
  if ((m = /^(\S+)\s*\.\.\s*(\S+)$/.exec(s)) && validDate(m[1]) && validDate(m[2])) {
    if (m[1] > m[2]) throw new PeriodError(`The range "${input}" ends before it starts.`);
    return { label: `${m[1]}..${m[2]}`, from: m[1], to: m[2] };
  }
  throw new PeriodError(`Can't read the period "${input}". ${PERIOD_HELP}`);
}

/** The day after `date`, so a filter can use `< next day` and include the whole last day. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * $filter clauses for EntryDate within the period.
 * ASSUMED: the datetime'…' literal, compared on the server's wall-clock time (open question A5).
 */
export function dateFilter(p: Period): string {
  return `EntryDate GE datetime'${p.from}T00:00:00' AND EntryDate LT datetime'${nextDay(p.to)}T00:00:00'`;
}
