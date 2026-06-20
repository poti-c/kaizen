/* ESLint config — Vite + React + TypeScript (ESLint 8, legacy format) */
module.exports = {
  root: true,
  env: { browser: true, es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist',
    'node_modules',
    'public/sw.js',
    '.eslintrc.cjs',
    'postcss.config.js',
    'tailwind.config.ts',
    'vite.config.ts',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // ── Bangkok timezone guards ───────────────────────────────────────────────
    // Kaizen stores all dates in Asia/Bangkok time. These three patterns silently
    // produce the wrong calendar date for users in UTC+7 at midnight, or for
    // any admin machine not in UTC+7.
    //
    // Exceptions (add eslint-disable-next-line with a one-word reason):
    //   - T00:00:00Z  →  only OK for full timestamps already in UTC (e.g. Supabase created_at comparisons)
    //   - toLocaleDateString  →  OK if options already include timeZone: 'Asia/Bangkok'
    'no-restricted-syntax': [
      'error',
      {
        selector: "Literal[value=/T00:00:00Z/]",
        message: "T00:00:00Z is UTC midnight — use 'T00:00:00+07:00' or parseDateOnlyBkk() for Bangkok dates.",
      },
      {
        selector: "TemplateElement[value.raw=/T00:00:00Z/]",
        message: "T00:00:00Z is UTC midnight — use 'T00:00:00+07:00' or parseDateOnlyBkk() for Bangkok dates.",
      },
      // Bare T00:00:00 (no Z, no +07:00) — uses browser/server local time.
      {
        selector: "BinaryExpression[operator='+'] > Literal[value='T00:00:00']",
        message: "T00:00:00 without timezone uses browser/server local time — use 'T00:00:00+07:00' for Bangkok dates.",
      },
      // Only flag toLocaleDateString/toLocaleString when called directly on new Date(...)
      // so number formatting (.toLocaleString() for currency) is not affected.
      {
        selector: "CallExpression[callee.object.type='NewExpression'][callee.object.callee.name='Date'][callee.property.name='toLocaleDateString'][arguments.length<2]",
        message: "Pass { timeZone: 'Asia/Bangkok' } in options — bare toLocaleDateString() on new Date() uses browser local time.",
      },
      {
        selector: "CallExpression[callee.object.type='NewExpression'][callee.object.callee.name='Date'][callee.property.name='toLocaleString'][arguments.length<2]",
        message: "Pass { timeZone: 'Asia/Bangkok' } in options — bare toLocaleString() on new Date() uses browser local time.",
      },
    ],
    // ── End Bangkok timezone guards ───────────────────────────────────────────
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    // The codebase intentionally uses `any` / `as any` for Supabase row casts etc.
    '@typescript-eslint/no-explicit-any': 'off',
    // Allow intentionally-unused args/vars prefixed with underscore.
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unused-vars': 'off', // handled by the TS-aware rule above
    '@typescript-eslint/no-empty-function': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
  },
}
