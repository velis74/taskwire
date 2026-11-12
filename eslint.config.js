import velis from 'eslint-config-velis';

export default [
  ...velis,
  {
    rules: {
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'error',
    },
    ignores: ['.venv/*', 'dist/*', 'coverage/*', 'node_modules/*', 'docs/*', 'vite.config.ts'],
  },
];
