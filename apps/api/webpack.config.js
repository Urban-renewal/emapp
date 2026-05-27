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
      // V11 B.S10 — playwright-core (and the bundled chromium binary
      // discovery code inside it) MUST stay external. nodeExternals
      // misses it under pnpm's symlinked node_modules layout — it
      // ends up inlined into dist/main.js and then crashes at runtime
      // because playwright internals do `require('./package.json')`
      // resolved against the bundle path. Caught by the B.S10 smoke
      // (HTTP /export?format=pdf → 500 with `Cannot find module 'C:\
      // emapp-bs2\apps\api\package.json'` in the stack). Defence in
      // depth — also pin exceljs in case the same pnpm quirk hits.
      ({ request }, callback) => {
        if (request === 'playwright-core' || /^playwright-core\//.test(request ?? '')) {
          return callback(undefined, `commonjs ${request}`);
        }
        if (request === 'exceljs' || /^exceljs\//.test(request ?? '')) {
          return callback(undefined, `commonjs ${request}`);
        }
        return callback();
      },
    ],
  };
};
