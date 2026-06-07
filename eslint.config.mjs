import js from '@eslint/js';
import * as jsoncParser from 'jsonc-eslint-parser';
import nxPlugin from '@nx/eslint-plugin';
import tseslint from 'typescript-eslint';

const executionInternalImportMessage =
  'Control-plane packages must import @autocatalyst/execution only through its public entry point.';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.nx/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      '@nx': nxPlugin
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib']
            },
            {
              sourceTag: 'plane:control',
              onlyDependOnLibsWithTags: ['type:lib', 'plane:execution']
            },
            {
              sourceTag: 'scope:sdk',
              onlyDependOnLibsWithTags: ['scope:contract', 'type:lib']
            }
          ]
        }
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // alias form - catches @autocatalyst/execution/src/...
              group: [
                '@autocatalyst/execution/src/*',
                '@autocatalyst/execution/src/**'
              ],
              message: executionInternalImportMessage
            },
            {
              // relative form - catches any depth of ../...execution/src/...
              regex: '(\\.\\./)+.*execution/src',
              message: executionInternalImportMessage
            }
          ]
        }
      ]
    }
  },
  {
    files: ['**/project.json', '**/package.json'],
    languageOptions: {
      parser: jsoncParser
    },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: ['{projectRoot}/vite.config.ts', '{projectRoot}/vitest.config.ts']
        }
      ]
    }
  }
];
