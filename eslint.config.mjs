import js from '@eslint/js';
import * as jsoncParser from 'jsonc-eslint-parser';
import nxPlugin from '@nx/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const executionInternalImportMessage =
  'Control-plane packages must import @autocatalyst/execution only through its public entry point.';

const baseUiWrapperOnlyMessage =
  'Import Base UI only through the client wrappers in apps/web/src/ui/ — screens use the wrappers, never @base-ui/react directly.';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.nx/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
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
            },
            {
              // The web client is a browser app: it may depend only on libraries
              // (the SDK and API contract), never on another app such as
              // apps/control-plane.
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: ['type:lib']
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
  },
  // The web client declares its browser runtime deps in `dependencies` and its
  // build/test tooling in `devDependencies`. The tooling is exercised only by
  // config, test-setup, spec, and e2e files, so those are ignored for the
  // production import scan, and the obsolete check is disabled (the tooling has no
  // production import site to point at).
  {
    files: ['apps/web/package.json'],
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
            '{projectRoot}/playwright.config.ts',
            '{projectRoot}/src/test-setup.ts',
            '{projectRoot}/vite/**/*.ts',
            '{projectRoot}/e2e/**',
            '{projectRoot}/**/*.spec.ts',
            '{projectRoot}/**/*.spec.tsx'
          ],
          checkObsoleteDependencies: false
        }
      ]
    }
  },
  // React hooks rules for the web client's components.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  // Only the client-owned wrappers in apps/web/src/ui/ may import Base UI
  // primitives directly; screens and other modules use the wrappers.
  {
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@base-ui/react', '@base-ui/react/*'],
              message: baseUiWrapperOnlyMessage
            }
          ]
        }
      ]
    }
  },
  {
    files: ['apps/web/src/ui/**/*.ts', 'apps/web/src/ui/**/*.tsx'],
    rules: {
      'no-restricted-imports': 'off'
    }
  }
];
