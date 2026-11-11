import tseslint from 'typescript-eslint';
export const scope = ['src/', 'bridge/'];
export const structuralScope = ['src/runner/process*.ts', 'src/adapters/quarto/capabilities.ts', 'src/json.ts', 'src/protocol/types.ts', 'bridge/**/*.ts'];
export default [{
  files: scope.map(prefix => prefix + '**/*.ts'),
  ignores: ['**/vendor/**', '**/node_modules/**', '**/generated/**', '**/_generated/**'],
  languageOptions: { parser: tseslint.parser },
  plugins: { '@typescript-eslint': tseslint.plugin },
  linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }],
    '@typescript-eslint/no-unsafe-type-assertion': 'error',
    '@typescript-eslint/switch-exhaustiveness-check': 'error',
  },
}, { files: structuralScope, rules: { complexity: ['error', 30], 'max-depth': ['error', 5], 'max-params': ['error', 5] } }];
