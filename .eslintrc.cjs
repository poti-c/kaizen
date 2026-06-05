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
