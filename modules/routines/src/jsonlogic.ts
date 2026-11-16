/**
 * The small JsonLogic subset event triggers filter with: `var`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `and`,
 * `or`, `!`. Anything else is an error at save time, so a filter never silently matches everything.
 */
export type Logic = unknown;

const OPS = new Set(['var', '==', '!=', '<', '<=', '>', '>=', 'in', 'and', 'or', '!']);

export function checkLogic(l: Logic, depth = 0): void {
  if (depth > 16) throw new Error('filter is nested too deeply');
  if (l === null || typeof l !== 'object') return;
  if (Array.isArray(l)) {
    for (const x of l) checkLogic(x, depth + 1);
    return;
  }
  const keys = Object.keys(l);
  if (keys.length !== 1 || !OPS.has(keys[0]!)) throw new Error(`unsupported filter operator "${keys[0]}"`);
  checkLogic((l as Record<string, unknown>)[keys[0]!], depth + 1);
}

function getVar(data: unknown, path: unknown): unknown {
  if (typeof path !== 'string' || path === '') return data;
  let cur: unknown = data;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, k)) return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function evalLogic(l: Logic, data: unknown): unknown {
  if (l === null || typeof l !== 'object') return l;
  if (Array.isArray(l)) return l.map((x) => evalLogic(x, data));
  const [op, raw] = Object.entries(l)[0]!;
  const args = Array.isArray(raw) ? raw : [raw];
  const v = (i: number) => evalLogic(args[i], data);
  switch (op) {
    case 'var':
      return getVar(data, v(0));
    case '==':
      return v(0) === v(1);
    case '!=':
      return v(0) !== v(1);
    case '<':
      return (v(0) as number) < (v(1) as number);
    case '<=':
      return (v(0) as number) <= (v(1) as number);
    case '>':
      return (v(0) as number) > (v(1) as number);
    case '>=':
      return (v(0) as number) >= (v(1) as number);
    case 'in': {
      const hay = v(1);
      const needle = v(0);
      if (typeof hay === 'string') return typeof needle === 'string' && hay.includes(needle);
      return Array.isArray(hay) && hay.includes(needle);
    }
    case 'and':
      return args.every((_, i) => !!v(i));
    case 'or':
      return args.some((_, i) => !!v(i));
    case '!':
      return !v(0);
    default:
      return false;
  }
}
