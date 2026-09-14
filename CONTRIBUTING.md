# Contributing to NoteTrace

Thanks for your interest in NoteTrace.

## Reporting bugs

- Open an issue at [github.com/traceapps/notetrace/issues](https://github.com/traceapps/notetrace/issues).
- Include your version (Settings → About), what you expected, and what you saw.
- For sync issues, include whether you're on PWA or native Android, and your server version.
- Don't paste server logs publicly without redacting; `LOG_LEVEL=debug` includes auth tokens that happened to be in flight and (on Android) device identifiers used for native sync.

## Suggesting features

- Open an issue describing the use case before writing code; it helps avoid building something that won't get merged.
- Check [ROADMAP.md](ROADMAP.md) first; the feature may already be planned or intentionally deferred.

## Pull requests

- **Target the `dev` branch, not `main`.** All work lands on `dev` first, gets tested there, and is bundled into `main` at release time. PRs opened against `main` will be asked to retarget.
- Keep changes focused, one concern per PR.
- Match the existing code style (Svelte 5 in compat mode, no runes, no TypeScript).
- For server changes, ensure all SQL is parameterized and every new route has appropriate `requireAuth` / `requireAdmin` middleware.
- Update `CHANGELOG.md` under the unreleased section if your change is user-visible.
- The Android shell lives in `android/`; if you change web assets the maintainer will run `npx cap sync android` and rebuild the APK.
- No DCO or CLA required.

## Language

NoteTrace is English only; there are no translations, and none are planned. UI text still lives in `src/i18n/en.json` and renders through `svelte-i18n`'s `$_()` helper, so copy is written in one place:

```svelte
<script>
  import { _ } from 'svelte-i18n';
</script>

<h1>{$_('routes.notes.title')}</h1>
```

- Add new strings to `en.json` in the same commit as the UI that uses them, grouped by area (`settings.notifications.section`).
- Use interpolation (`{$_('key', { values: { name } })}` with `{name}` in the value) rather than string concatenation.
- Run `npm run i18n:check` before opening a PR. It catches duplicate keys and keys the code uses that `en.json` doesn't have.

## Screenshots

README screenshots live in `docs/screenshots/` (numbered prefix for sort order). If your PR meaningfully changes the UI shown in any of them, please replace the affected screenshot at the same dimensions and theme (dark) so the README stays accurate.

## License

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE), the same license as the rest of the server and PWA code.
