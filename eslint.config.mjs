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
          ignoredFiles: [
            '{projectRoot}/vite.config.ts',
            '{projectRoot}/vitest.config.ts',
            '{projectRoot}/drizzle.config.ts'
          ]
        }
      ]
    }
  },
  // The control-plane app owns only app-level dependencies. Provider SDKs live
  // with their adapter packages and are verified by the runtime spec.
  {
    files: ['apps/control-plane/package.json'],
    languageOptions: {
      parser: jsoncParser
    },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/vite.config.ts',
            '{projectRoot}/vitest.config.ts',
            '{projectRoot}/drizzle.config.ts'
          ]
        }
      ]
    }
  },
  // The OpenAI agent adapter declares @openai/agents, `openai`, and `zod` as
  // real dependencies and imports them statically, so @nx/dependency-checks
  // detects them without an override (the default rule above applies).
  // The Claude adapter dynamically imports the Claude SDK, which the Nx rule
  // cannot detect, so the adapter declares and ignores only its owned SDK deps.
  {
    files: ['packages/claude-agent-adapter/package.json'],
    languageOptions: {
      parser: jsoncParser
    },
    plugins: { '@nx': nxPlugin },
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredFiles: [
            '{projectRoot}/vite.config.ts',
            '{projectRoot}/vitest.config.ts',
            '{projectRoot}/drizzle.config.ts'
          ],
          ignoredDependencies: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk', 'zod']
        }
      ]
    }
  }
];
