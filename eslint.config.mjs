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
  // The control-plane app hosts the Claude adapter's optional peer dependency
  // and verifies SDK availability through a dynamic import in its integration
  // suite. @nx/dependency-checks does not treat that dynamic import as usage.
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
          ],
          ignoredDependencies: ['@anthropic-ai/claude-agent-sdk']
        }
      ]
    }
  },
  // The OpenAI agent adapter declares @openai/agents, `openai`, and `zod` as
  // real dependencies and imports them statically, so @nx/dependency-checks
  // detects them without an override (the default rule above applies).
  // @anthropic-ai/claude-agent-sdk is an optional peer dep used only via
  // dynamic import() in the Claude adapter — the @nx/dependency-checks rule
  // cannot detect dynamic imports, so we suppress the false positive here.
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
          ignoredDependencies: ['@anthropic-ai/claude-agent-sdk']
        }
      ]
    }
  }
];
