/**
 * The datastore's SQL gate: a small hand-written tokenizer (no regular expressions, one linear pass) that splits
 * agent SQL into words, quoted names, strings and punctuation, refuses what the shared store never runs, and says
 * what one statement is and which table it touches. SQLite itself is the second gate: the worker prepares exactly
 * one statement and checks `readonly` for queries.
 *
 * Refused anywhere in the text (outside strings and quoted names): ATTACH, DETACH, PRAGMA, VACUUM, ANALYZE,
 * REINDEX, LOAD_EXTENSION, more than one statement, and any `sqlite_*` name. Accepted statement kinds:
 * - query:  SELECT / VALUES / WITH … (read only)
 * - write:  INSERT / REPLACE / UPDATE / DELETE on one plain table name (no WITH prefix)
 * - create: CREATE TABLE [IF NOT EXISTS] name … (no TEMP, no schema prefix)
 * - alter:  ALTER TABLE name RENAME TO / RENAME [COLUMN] / ADD [COLUMN] / DROP [COLUMN]
 * - drop:   DROP TABLE [IF EXISTS] name
 */

export type Token =
  | { t: 'word'; v: string; upper: string } // bare word: keyword or name
  | { t: 'name'; v: string } // "quoted", [bracketed] or `backticked` name
  | { t: 'string' }
  | { t: 'number' }
  | { t: 'param' }
  | { t: 'punct'; v: string };

export class SqlError extends Error {
  constructor(
    message: string,
    readonly code: 'syntax' | 'forbidden' | 'multi_statement' | 'unsupported' | 'empty' = 'forbidden',
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

export const MAX_SQL_CHARS = 20_000;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isDigit = (c: number) => c >= 48 && c <= 57;
// letters, `_`, and every non-ASCII code unit (SQLite treats those as identifier characters)
const isWordStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
const isWordPart = (c: number) => isWordStart(c) || isDigit(c) || c === 36; // `$` inside a word

/** ASCII upper case only (SQLite keywords are ASCII); never touches other characters. */
function asciiUpper(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
/** Case-folds a table name the way SQLite compares names (ASCII only). */
export function foldName(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** Reads a quoted run that ends at `close`; a doubled `close` is an escaped one (except for `]`). */
function readQuoted(
  sql: string,
  start: number,
  close: number,
  doubling: boolean,
): { end: number; v: string } {
  let v = '';
  let i = start + 1;
  for (;;) {
    if (i >= sql.length) throw new SqlError('unterminated quote', 'syntax');
    const c = sql.charCodeAt(i);
    if (c === close) {
      if (doubling && sql.charCodeAt(i + 1) === close) {
        v += sql[i];
        i += 2;
        continue;
      }
      return { end: i + 1, v };
    }
    v += sql[i];
    i++;
  }
}

/** Splits SQL into tokens. Comments and whitespace are dropped; a `;` stays as punctuation. */
export function tokenize(sql: string): Token[] {
  if (sql.length > MAX_SQL_CHARS) throw new SqlError(`SQL longer than ${MAX_SQL_CHARS} characters`, 'syntax');
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql.charCodeAt(i);
    if (isSpace(c)) {
      i++;
    } else if (c === 45 && sql.charCodeAt(i + 1) === 45) {
      // -- comment to end of line
      i += 2;
      while (i < sql.length && sql.charCodeAt(i) !== 10) i++;
    } else if (c === 47 && sql.charCodeAt(i + 1) === 42) {
      // /* comment */ (SQLite accepts an unterminated one at the very end; we do not)
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new SqlError('unterminated comment', 'syntax');
      i = end + 2;
    } else if (c === 39) {
      i = readQuoted(sql, i, 39, true).end;
      out.push({ t: 'string' });
    } else if (c === 34 || c === 96) {
      const q = readQuoted(sql, i, c, true);
      i = q.end;
      out.push({ t: 'name', v: q.v });
    } else if (c === 91) {
      const q = readQuoted(sql, i, 93, false);
      i = q.end;
      out.push({ t: 'name', v: q.v });
    } else if ((c === 88 || c === 120) && sql.charCodeAt(i + 1) === 39) {
      // X'ABCD' blob literal
      i = readQuoted(sql, i + 1, 39, false).end;
      out.push({ t: 'string' });
    } else if (isWordStart(c)) {
      const s = i;
      while (i < sql.length && isWordPart(sql.charCodeAt(i))) i++;
      const v = sql.slice(s, i);
      out.push({ t: 'word', v, upper: asciiUpper(v) });
    } else if (isDigit(c) || (c === 46 && isDigit(sql.charCodeAt(i + 1)))) {
      i++;
      while (i < sql.length) {
        const d = sql.charCodeAt(i);
        if (isDigit(d) || d === 46 || isWordStart(d)) i++;
        else if ((d === 43 || d === 45) && (sql.charCodeAt(i - 1) | 32) === 101)
          i++; // 1e+5
        else break;
      }
      out.push({ t: 'number' });
    } else if (c === 63 || c === 58 || c === 64 || c === 36) {
      // ?, ?NNN, :name, @name, $name
      i++;
      while (i < sql.length && isWordPart(sql.charCodeAt(i))) i++;
      out.push({ t: 'param' });
    } else {
      // two-character operators are irrelevant to the gate; one punctuation token per character is enough
      out.push({ t: 'punct', v: sql[i]! });
      i++;
    }
  }
  return out;
}

/** Words the shared store never runs, wherever they appear (a column with such a name must be quoted). */
const FORBIDDEN = new Set(['ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'ANALYZE', 'REINDEX', 'LOAD_EXTENSION']);

export type Statement =
  | { kind: 'query' }
  | {
      kind: 'write';
      verb: 'insert' | 'update' | 'delete';
      table: string;
      /**
       * `replace`: REPLACE INTO / INSERT OR REPLACE / UPDATE OR REPLACE, whose conflict resolution deletes the rows
       * it collides with; `upsert`: INSERT … ON CONFLICT … DO UPDATE (changes existing rows, deletes none).
       */
      conflict?: 'replace' | 'upsert';
    }
  | { kind: 'create'; table: string; ifNotExists: boolean }
  | {
      kind: 'alter';
      table: string;
      action: 'rename_table' | 'rename_column' | 'add_column' | 'drop_column';
      newName?: string;
    }
  | { kind: 'drop'; table: string; ifExists: boolean };

const startsWithSqlite = (name: string) => foldName(name.slice(0, 7)) === 'sqlite_';

/** One statement, gated and classified; throws SqlError for anything the shared store does not run. */
export function classify(sql: string): Statement {
  const all = tokenize(sql);
  // exactly one statement: everything after the first `;` must be more `;`
  const semi = all.findIndex((t) => t.t === 'punct' && t.v === ';');
  const toks = semi < 0 ? all : all.slice(0, semi);
  if (semi >= 0 && all.slice(semi).some((t) => !(t.t === 'punct' && t.v === ';')))
    throw new SqlError('only one SQL statement per call', 'multi_statement');
  if (toks.length === 0) throw new SqlError('no SQL statement', 'empty');
  for (const t of toks) {
    if (t.t === 'word' && FORBIDDEN.has(t.upper)) throw new SqlError(`${t.upper} is not allowed here`);
    if ((t.t === 'word' || t.t === 'name') && startsWithSqlite(t.v))
      throw new SqlError('sqlite_* names are reserved for SQLite itself');
  }

  let p = 0;
  const peek = (o = 0) => toks[p + o];
  const isWord = (t: Token | undefined, ...ws: string[]) => t?.t === 'word' && ws.includes(t.upper);
  const take = (...ws: string[]) => {
    if (isWord(peek(), ...ws)) {
      p++;
      return true;
    }
    return false;
  };
  const expect = (...ws: string[]) => {
    if (!take(...ws)) throw new SqlError(`expected ${ws.join(' or ')}`, 'syntax');
  };
  /** A plain table name: no `schema.` prefix (one store, one schema). */
  const tableName = (): string => {
    const t = peek();
    if (!t || (t.t !== 'word' && t.t !== 'name')) throw new SqlError('expected a table name', 'syntax');
    p++;
    if (peek()?.t === 'punct' && (peek() as { v: string }).v === '.')
      throw new SqlError('schema-qualified names are not allowed; the datastore has one schema');
    const name = t.v;
    if (name.length === 0 || name.length > 64)
      throw new SqlError('table names are 1–64 characters', 'syntax');
    return name;
  };

  /** `OR <resolution>` after INSERT/UPDATE; true when it is OR REPLACE. */
  const orClause = (): boolean => {
    if (!take('OR')) return false;
    const replace = isWord(peek(), 'REPLACE');
    expect('ROLLBACK', 'ABORT', 'REPLACE', 'FAIL', 'IGNORE');
    return replace;
  };
  /** REPLACE resolution wins; otherwise an `ON CONFLICT … DO UPDATE` anywhere after the table is an upsert. */
  const conflictOf = (replace: boolean): { conflict?: 'replace' | 'upsert' } => {
    if (replace) return { conflict: 'replace' };
    // one linear pass: first ON CONFLICT, then a DO UPDATE after it
    let onConflict = false;
    for (let k = p; k + 1 < toks.length; k++) {
      if (!onConflict) onConflict = isWord(toks[k], 'ON') && isWord(toks[k + 1], 'CONFLICT');
      else if (isWord(toks[k], 'DO') && isWord(toks[k + 1], 'UPDATE')) return { conflict: 'upsert' };
    }
    return {};
  };

  const first = peek();
  if (first?.t !== 'word') throw new SqlError('a statement starts with a keyword', 'syntax');
  switch (first.upper) {
    case 'SELECT':
    case 'VALUES':
    case 'WITH':
      return { kind: 'query' };
    case 'INSERT':
    case 'REPLACE': {
      p++;
      let replace = first.upper === 'REPLACE';
      if (first.upper === 'INSERT') replace = orClause();
      expect('INTO');
      const table = tableName();
      return { kind: 'write', verb: 'insert', table, ...conflictOf(replace) };
    }
    case 'UPDATE': {
      p++;
      const replace = orClause();
      return { kind: 'write', verb: 'update', table: tableName(), ...conflictOf(replace) };
    }
    case 'DELETE': {
      p++;
      expect('FROM');
      return { kind: 'write', verb: 'delete', table: tableName() };
    }
    case 'CREATE': {
      p++;
      if (isWord(peek(), 'TEMP', 'TEMPORARY'))
        throw new SqlError('temporary tables are not kept; create a normal table', 'unsupported');
      if (!take('TABLE'))
        throw new SqlError('only CREATE TABLE is supported (no views, triggers or indexes)', 'unsupported');
      let ifNotExists = false;
      if (take('IF')) {
        expect('NOT');
        expect('EXISTS');
        ifNotExists = true;
      }
      return { kind: 'create', table: tableName(), ifNotExists };
    }
    case 'ALTER': {
      p++;
      expect('TABLE');
      const table = tableName();
      if (take('RENAME')) {
        if (take('TO')) return { kind: 'alter', table, action: 'rename_table', newName: tableName() };
        return { kind: 'alter', table, action: 'rename_column' };
      }
      if (take('ADD')) return { kind: 'alter', table, action: 'add_column' };
      if (take('DROP')) return { kind: 'alter', table, action: 'drop_column' };
      throw new SqlError('expected RENAME, ADD or DROP', 'syntax');
    }
    case 'DROP': {
      p++;
      if (!take('TABLE')) throw new SqlError('only DROP TABLE is supported', 'unsupported');
      let ifExists = false;
      if (take('IF')) {
        expect('EXISTS');
        ifExists = true;
      }
      const table = tableName();
      if (peek()) throw new SqlError('unexpected text after the table name', 'syntax');
      return { kind: 'drop', table, ifExists };
    }
    default:
      throw new SqlError(`${first.upper} statements are not supported here`, 'unsupported');
  }
}

/** A name as a quoted SQL identifier (doubles any `"`). Only for names read from the store's own schema. */
export function quoteName(name: string): string {
  let out = '"';
  for (const ch of name) out += ch === '"' ? '""' : ch;
  return `${out}"`;
}
