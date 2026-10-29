# Vendored: libsodium.js 0.8.4 (sumo, ESM)

Two files are vendored here so the private room keeps working on a plain
`http://` LAN address, where `window.crypto.subtle` is unavailable and WebCrypto
cannot be used:

| file                     | npm package                | original path                                  |
| ------------------------ | -------------------------- | ---------------------------------------------- |
| `libsodium.mjs`          | `libsodium-sumo@0.8.4`     | `dist/modules-sumo-esm/libsodium-sumo.mjs`     |
| `libsodium-wrappers.mjs` | `libsodium-wrappers-sumo@0.8.4` | `dist/modules-sumo-esm/libsodium-wrappers.mjs` |

The **sumo** build is required: the standard libsodium.js build ships without
`crypto_pwhash`, i.e. without Argon2.

## One local modification

`libsodium-wrappers.mjs` is byte for byte the published file except for its
first import, rewritten from the bare package specifier to a relative path so
the browser can load it without an import map:

```diff
-import e from"libsodium-sumo";
+import e from"./libsodium.mjs";
```

Nothing else was touched. Both files are the upstream published (minified)
artifacts, distributed under the ISC license — see `LICENSE`.

## Re-vendoring a newer version

```bash
npm pack libsodium-sumo@<version> libsodium-wrappers-sumo@<version>
tar xzf libsodium-sumo-<version>.tgz
cp package/dist/modules-sumo-esm/libsodium-sumo.mjs public/vendor/libsodium.mjs
tar xzf libsodium-wrappers-sumo-<version>.tgz
cp package/dist/modules-sumo-esm/libsodium-wrappers.mjs public/vendor/libsodium-wrappers.mjs
sed -i 's|import e from"libsodium-sumo";|import e from"./libsodium.mjs";|' public/vendor/libsodium-wrappers.mjs
cp package/LICENSE public/vendor/LICENSE
npm test          # tests/crypto.test.mjs pins the primitives we rely on
```

`tests/crypto.test.mjs` exists precisely so an upgrade cannot silently change
the KDF or the AEAD: it asserts Argon2id is present, that the memory limit is
at least 64 MiB, and that sealing/unsealing still round trips.
