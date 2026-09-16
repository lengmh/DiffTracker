import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const commonRules = {
    'eqeqeq': ['error', 'always'],
    'no-constant-condition': 'error',
    'no-debugger': 'error',
    'no-throw-literal': 'error'
};

export default [
    {
        ignores: ['out/**', 'webview/**', '.vscode-test/**']
    },
    {
        files: ['src/**/*.ts'],
        ignores: ['src/webview/**'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.json',
                sourceType: 'module'
            }
        },
        plugins: {
            '@typescript-eslint': tseslint
        },
        rules: {
            ...commonRules,
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error'
        }
    },
    {
        files: ['src/webview/**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: 'module'
            }
        },
        rules: commonRules
    }
];
