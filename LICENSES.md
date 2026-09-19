# Licenses & Data Sources

NoteTrace's source code is licensed under [AGPL-3.0](LICENSE). This file lists anything bundled or connected to that carries its own license, so operators and contributors know what applies to what.

## Code

- **NoteTrace**: AGPL-3.0 (see [LICENSE](LICENSE)). Applies to the entire codebase in this repository including the Android app source.

## Bundled assets

| Asset | License | Where |
| ----- | ------- | ----- |
| **Inter** (UI typeface) | [SIL Open Font License 1.1][ofl] | `public/fonts/inter-*.woff2` |
| **Newsreader** (note title typeface) | [SIL Open Font License 1.1][ofl] | `public/fonts/newsreader-medium.woff2` |
| **Material Symbols Rounded** | [Apache License 2.0][apache] | `public/fonts/material-symbols-rounded.woff2` |

[ofl]: https://openfontlicense.org/
[apache]: https://www.apache.org/licenses/LICENSE-2.0

## Your data

Notes, checklists, and attachments are created by the user and owned by whoever runs the instance. NoteTrace does not bundle any third-party content database.

## Third-party code dependencies

Bundled Node.js dependencies (Express, better-sqlite3, Svelte, Capacitor plugins, etc.) each carry their own permissive licenses (MIT / Apache-2.0 / BSD variants). See `package.json` and `server/package.json` for the full dependency lists; run `npm ls --long` or `npx license-checker` in either directory for machine-readable output.

## Questions

If any of the above needs clarification or you spot something worth correcting, open an issue on the [GitHub repository][repo].

[repo]: https://github.com/TraceApps/notetrace/issues
