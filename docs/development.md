# Development guide

This guide is for contributors building Code Diff Tracker from source. For installation and everyday use, see the [English README](../README.md) or [中文说明](../README_CN.md).

## Local setup

1. Install Node.js and npm. CI uses Node.js 22.
2. Clone the repository and run `npm ci`.
3. Run `npm run compile`.
4. Open the repository in VS Code and press `F5` to launch the Extension Development Host.

## Common commands

- `npm run compile`: compile the extension and build the WebView.
- `npm run build:webview`: rebuild only the WebView.
- `npm run watch`: watch and compile the extension's TypeScript files.
- `npm run lint`: check source code with ESLint.
- `npm test`: compile and run the automated test suite.
- `npm run test:host`: run the VS Code Extension Host tests.
- `npm run test:performance`: run performance checks.
- `npm run package`: build a VSIX for local installation.

For focused tests, see the scripts in [`package.json`](../package.json). For publishing requirements, see [Releasing](releasing.md).
