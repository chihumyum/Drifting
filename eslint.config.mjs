import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist', '.vite', 'out', 'build', 'node_modules', 'src-tauri/target', '**/*.d.ts'],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // React Hooks 7 added this compiler-oriented diagnostic to the regular
      // recommended preset. The app does not enable React Compiler yet, and
      // several existing effects intentionally reset UI state when their
      // entity or modal lifecycle changes. Keep the diagnostic visible while
      // making lint a usable CI gate; each lifecycle can then be refactored
      // without turning a dependency upgrade into a release-wide blocker.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  {
    files: ['src/renderer/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/shells/desktop/**',
                '**/hooks/useProjectNavigation',
                '**/store/ui-store',
              ],
              message:
                'Shared features must use shell-neutral contracts such as WorkspaceNavigator.',
            },
          ],
        },
      ],
    },
  },
);
