const nodeExternals = require('webpack-node-externals');

module.exports = function (options) {
  return {
    ...options,
    resolve: {
      ...options.resolve,
      // TypeScript ESM uses .js extensions in source imports (e.g. './connection.js')
      // but the actual files are .ts — this tells webpack to look for .ts when it sees .js
      extensionAlias: {
        '.js': ['.ts', '.js'],
        '.mjs': ['.mts', '.mjs'],
      },
    },
    externals: [
      nodeExternals({
        // Bundle @emapp/* workspace packages — without this Node tries to load
        // them at runtime as .ts files (via package.json exports) and crashes.
        allowlist: [/^@emapp\//],
      }),
    ],
  };
};
