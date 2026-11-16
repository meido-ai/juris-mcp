/**
 * The subset of OData query options the Juris Web API documents ($filter, $orderby, $top), plus $skip.
 *
 * $filter grammar:  expr   := term ( OR term )*
 *                   term   := factor ( AND factor )*
 *                   factor := NOT factor | "(" expr ")" | Field op literal
 *                   op     := EQ | NE | GT | GE | LT | LE          (case-insensitive)
 *                   literal:= 'text' ('' escapes a quote) | number | datetime'YYYY-MM-DDTHH:MM:SS' | true | false | null
 */

export class ODataError extends Error {}

type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean;

type Token =
  | { kind: "ident"; value: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "datetime"; value: number }
  | { kind: "punct"; value: "(" | ")" };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "(" || ch === ")") {
      out.push({ kind: "punct", value: ch });
      i++;
    } else if (ch === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new ODataError("Unterminated string literal in $filter");
        if (src[i] === "'" && src[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (src[i] === "'") {
          i++;
          break;
        } else s += src[i++];
      }
      out.push({ kind: "string", value: s });
    } else if (/[-\d]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (!m) throw new ODataError(`Unexpected '${ch}' in $filter`);
      out.push({ kind: "number", value: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      i += m[0].length;
      if (m[0].toLowerCase() === "datetime" && src[i] === "'") {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ODataError("Unterminated datetime literal in $filter");
        const ms = Date.parse(`${src.slice(i + 1, end)}Z`);
        if (Number.isNaN(ms)) throw new ODataError(`Invalid datetime literal: ${src.slice(i + 1, end)}`);
        out.push({ kind: "datetime", value: ms });
        i = end + 1;
      } else out.push({ kind: "ident", value: m[0] });
    } else {
      throw new ODataError(`Unexpected '${ch}' in $filter`);
    }
  }
  return out;
}

const OPS: Record<string, (a: number | string, b: number | string) => boolean> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  ge: (a, b) => a >= b,
  lt: (a, b) => a < b,
  le: (a, b) => a <= b,
};

function fieldOf(row: Row, name: string): unknown {
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) throw new ODataError(`Could not find a property named '${name}'.`);
  return row[key];
}

export function parseFilter(src: string): Pred {
  const tokens = tokenize(src);
  let pos = 0;
  const peekWord = () => (tokens[pos]?.kind === "ident" ? (tokens[pos].value as string).toLowerCase() : undefined);

  const expr = (): Pred => {
    let left = term();
    while (peekWord() === "or") {
      pos++;
      const l = left, r = term();
      left = (row) => l(row) || r(row);
    }
    return left;
  };
  const term = (): Pred => {
    let left = factor();
    while (peekWord() === "and") {
      pos++;
      const l = left, r = factor();
      left = (row) => l(row) && r(row);
    }
    return left;
  };
  const factor = (): Pred => {
    if (peekWord() === "not") {
      pos++;
      const f = factor();
      return (row) => !f(row);
    }
    const t = tokens[pos];
    if (t?.kind === "punct" && t.value === "(") {
      pos++;
      const e = expr();
      const close = tokens[pos++];
      if (close?.kind !== "punct" || close.value !== ")") throw new ODataError("Missing ')' in $filter");
      return e;
    }
    if (t?.kind !== "ident") throw new ODataError("Expected a field name in $filter");
    const field = t.value;
    pos++;
    const opTok = tokens[pos++];
    const op = opTok?.kind === "ident" ? OPS[opTok.value.toLowerCase()] : undefined;
    if (!op) throw new ODataError(`Expected a comparison operator after '${field}'`);
    const lit = tokens[pos++];
    if (!lit || lit.kind === "punct") throw new ODataError(`Expected a value after '${field} ${(opTok as { value: string }).value}'`);

    if (lit.kind === "ident") {
      const word = lit.value.toLowerCase();
      if (word === "null") return (row) => (op === OPS.eq ? fieldOf(row, field) == null : op === OPS.ne ? fieldOf(row, field) != null : false);
      if (word !== "true" && word !== "false") throw new ODataError(`Unknown value '${lit.value}' in $filter`);
      const b = word === "true";
      return (row) => (op === OPS.eq ? fieldOf(row, field) === b : op === OPS.ne ? fieldOf(row, field) !== b : false);
    }
    return (row) => {
      const v = fieldOf(row, field);
      if (v == null) return op === OPS.ne;
      // Compare the recorded wall-clock date-time; the offset is ignored (ASSUMED server behavior).
      if (lit.kind === "datetime") return op(Date.parse(`${String(v).slice(0, 19)}Z`), lit.value);
      if (lit.kind === "number") return op(Number(v), lit.value);
      return op(String(v), lit.value);
    };
  };

  const pred = expr();
  if (pos !== tokens.length) throw new ODataError("Unexpected text at the end of $filter");
  return pred;
}

function parseOrderBy(src: string): (a: Row, b: Row) => number {
  const keys = src.split(",").map((part) => {
    const [field, dir = "asc"] = part.trim().split(/\s+/);
    if (!/^(asc|desc)$/i.test(dir)) throw new ODataError(`Invalid $orderby direction '${dir}'`);
    return { field, sign: dir.toLowerCase() === "desc" ? -1 : 1 };
  });
  return (a, b) => {
    for (const { field, sign } of keys) {
      const x = fieldOf(a, field) as string | number | null;
      const y = fieldOf(b, field) as string | number | null;
      if (x === y) continue;
      if (x == null) return -sign;
      if (y == null) return sign;
      return (x < y ? -1 : 1) * sign;
    }
    return 0;
  };
}

export interface QueryOptions {
  /** Inserted when the request has no $top, as the API does for collections that can be large. */
  defaultTop?: number;
}

/** Apply $filter, $orderby, $skip and $top (in that order) from a request's query string. */
export function applyQuery<T extends object>(rows: T[], query: Record<string, unknown>, opts: QueryOptions = {}): T[] {
  const q = (name: string) => {
    const v = query[name];
    return typeof v === "string" ? v : undefined;
  };
  let out = rows as unknown as Row[];
  const filter = q("$filter");
  if (filter) {
    const pred = parseFilter(filter);
    out = out.filter(pred);
  }
  const orderBy = q("$orderby");
  if (orderBy) out = [...out].sort(parseOrderBy(orderBy));

  const int = (name: string) => {
    const v = q(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new ODataError(`${name} must be a non-negative integer`);
    return Number(v);
  };
  const skip = int("$skip") ?? 0;
  const top = int("$top") ?? opts.defaultTop;
  out = out.slice(skip, top === undefined ? undefined : skip + top);
  return out as unknown as T[];
}
