/** Enforces ARCHITECTURE.md section 2 ("Dependency rule"). Test files are exempt where noted. */
const notTest = '(\\.test\\.tsx?$|/__fixtures__/)';
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      // core names better-sqlite3's Database type only, through @types/better-sqlite3
      to: { couldNotResolve: true, pathNot: '^better-sqlite3$' },
    },
    {
      name: 'protocol-is-a-leaf',
      severity: 'error',
      from: { path: '^packages/protocol/' },
      to: { path: '^(packages/(core|db|testkit|i18n|safe-net|ui)|apps|providers|channels|modules|plugins)/' },
    },
    {
      name: 'core-ports-only',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^(packages/(db|testkit|i18n|safe-net|ui)|apps|providers|channels|modules|plugins)/' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/(?!testkit/)' },
      to: { path: '^apps/' },
    },
    {
      name: 'server-loads-extensions-by-discovery-only',
      severity: 'error',
      from: { path: '^apps/server/src/', pathNot: notTest },
      to: { path: '^(providers|channels|modules|plugins)/' },
    },
    {
      name: 'extensions-use-ports-not-server',
      severity: 'error',
      from: { path: '^(providers|channels|modules|plugins)/' },
      to: { path: '^(apps|packages/db)/' },
    },
    {
      name: 'modules-do-not-import-other-modules',
      severity: 'error',
      from: { path: '^(modules|plugins)/([^/]+)/' },
      to: { path: '^(modules|plugins)/', pathNot: '^$1/$2/' },
    },
    {
      name: 'module-web-imports-ui-protocol-i18n-only',
      severity: 'error',
      from: { path: '^(modules|plugins|providers)/[^/]+/web/' },
      to: { path: '^(packages/(core|db|testkit|safe-net)|apps)/', dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|coverage)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['source', 'import', 'types', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.json'],
    },
  },
};
