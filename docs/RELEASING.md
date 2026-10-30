# Releasing

Farshelf follows [Semantic Versioning](https://semver.org/). While it is 0.x, minor
versions may change the CLI or settings. **The encryption format version only changes
together with a migration and a major note in the changelog.**

1. Update `version` in `package.json` and `VERSION` in `src/server/app.ts`.
2. Add a section to `CHANGELOG.md`.
3. Run `npm run check && npm run test:e2e`.
4. Commit, tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
5. The **Release** workflow builds, tests and packs (`npm pack`). It then creates a
   GitHub release with the tarball and its SHA-256 checksum. Users install it with
   `npm install -g farshelf-0.1.0.tgz`.

## macOS app

`npm run package:mac` builds `dist/macos/Farshelf.app`. It bundles the Node.js runtime
of the build machine (thinned to its CPU architecture), the production dependencies
and the icon from `assets/`, and is ad-hoc signed. To distribute it:

1. Sign it with a Developer ID Application certificate:
   `codesign --force --deep --options runtime --sign "Developer ID Application: …" Farshelf.app`.
2. Zip it and notarize it: `xcrun notarytool submit Farshelf.zip --wait …`.
3. Staple the ticket: `xcrun stapler staple Farshelf.app`.

Don't include `google-oauth.json` in builds you share unless you accept publishing that
OAuth client secret (see docs/AI_AND_PROVIDERS.md).

Publishing to the npm registry is optional, done manually with `npm publish`, and not
automated.
