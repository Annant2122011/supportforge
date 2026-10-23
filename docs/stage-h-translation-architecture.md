# Stage H: Translation and Localization Architecture

**Status:** H1 translation core implemented on `main`; H2 language controls and initial surface integration in progress  
**Baseline:** Stages A–G integrated into main at e1988a1a0cc5efc698a870215ba7c902c7ddeeba  
**Persistence:** Existing Neon/PostgreSQL-backed advanced-settings JSON document; no SQL migration  
**Compatibility:** Existing /supportforge command root, IDs, event names, internal symbols and legacy persisted documents remain unchanged.

## Goals and non-goals

Stage H introduces a consistent translation layer for bot-generated copy without coupling business logic to dictionaries. Translation must be deterministic, type-safe, and safe when a locale catalog is incomplete or persisted data contains an unknown locale. It must not translate user-provided ticket titles, custom labels, tags, message history, IDs, role names, channel names, code, URLs, error codes, or audit/event identifiers.

The canonical source language is English (United States). Part 1 provides the translation engine, a small high-value catalog, starter Hindi (India) and Bengali (India) catalogs, locale persistence primitives, interpolation and Intl formatting. Part 1 intentionally does not rewrite every existing string or add the administrator controls for changing the server locale; these are Part 2.

## Part split

### H1 — Translation core and safe rollout (this PR)

1. Create a registry of supported locale tags: en-US, hi-IN, and bn-IN; normalise legacy/malformed stored locale values to en-US.
2. Define the canonical typed TranslationKey vocabulary in the English catalog.
3. Add partial Hindi and Bengali dictionaries. Each key falls back individually to English, so a partial translation cannot produce a blank label.
4. Implement translate(locale, key, params) with one-pass, non-recursive placeholder substitution. Missing parameters remain visible as {parameter} rather than silently deleting information.
5. Add locale-aware number/date formatting wrappers backed by JavaScript Intl, with deterministic fallback behavior and invalid-date checks.
6. Store a per-server locale preference in the existing versioned JSON settings document, defaulting to en-US, preserving all other server settings and avoiding a SQL migration.
7. Add regression tests for key typing/catalog completeness, locale fallback, partial dictionary fallback, safe interpolation, date/number formatting, and settings normalization.
8. Keep the rollout opt-in: existing handlers remain in English until individually wired or H2 migrates the user-facing surfaces.

### H2 — Locale controls and end-to-end coverage (active increment)

1. Add Settings-dashboard and slash-command locale controls with identical capability, authorization, validation, audit and fallback behavior.
2. Localize high-traffic user surfaces incrementally: ticket intake/created, ticket lifecycle buttons and outcomes, common validation errors, forms, support-hours notices, settings dashboard, panel previews, and selected reports.
3. Pass locale explicitly at the use-case boundary rather than reading global locale inside low-level domain/repository code.
4. Define locale precedence as explicit user preference for a direct response (if supported) → per-guild setting → en-US. Avoid storing personal-language preferences until their lifecycle and privacy behavior are specified.
5. Keep stable IDs, command names, machine-readable status tokens, audit action codes and internal enum values untranslated.
6. Add interaction parity and language-specific regression tests; validate Discord message/button/select length limits after interpolation and ensure no partial localization changes component custom IDs.

## Module boundaries

- src/i18n/localeRegistry.ts: supported locales, type guard, safe resolver.
- src/i18n/locales/en-US.ts: canonical catalog and source of the TranslationKey type.
- src/i18n/locales/hi-IN.ts and bn-IN.ts: partial, typed overlays.
- src/i18n/translationService.ts: translation, per-key fallback, safe interpolation, date and number formatting.
- src/services/advancedSettingsService.ts: durable guild locale preference, loaded through the existing Neon-backed JSON document service.
- tests/translationService.test.ts: pure deterministic unit tests independent of Discord network access.

The translation layer may import the pure locale registry and dictionaries. It must not import Discord clients, repositories, settings services, or network APIs. The advanced-settings service may import the locale registry, but the registry must not import settings services. This avoids circular dependencies.

## Data and migration strategy

The guild setting is a simple supported-locale tag and defaults to en-US. Existing documents do not need a migration; normalization supplies the default when the property is absent or invalid. Saving a locale must update only the existing document through the JSON-document repository, preserving unrelated server settings. Do not introduce SQLite, a new table, or a separate translation database.

## Quality and safety requirements

- Every key in the English source catalog is present and non-empty.
- Partial dictionaries deliberately fall back key-by-key to English.
- Interpolation replaces placeholders once only, so parameter content containing braces is not interpreted as a second template.
- Missing parameters remain visible for debugging and are tested.
- Unknown locale values resolve safely to en-US.
- Never concatenate locale-specific business logic into handlers; use the translation service at message construction boundaries.
- Keep user-generated content and machine identifiers untouched.
- Automated CI must pass TypeScript build, the full test suite, and PostgreSQL verification before H1 is merged.
- Real-guild Discord acceptance remains necessary before broad H2 localization because unit tests cannot prove interaction or rendering behavior.

## Acceptance checklist

### H1
- [x] Build, unit tests and PostgreSQL verification pass in CI before the H1 merge.
- [x] Unknown/legacy locale values render English and do not stop startup.
- [x] Partial catalogs never return missing text when an English key exists.
- [x] Parameter values are substituted literally and only once.
- [x] Date/number output uses the requested supported locale.
- [x] New locale preference is defaulted and persisted through the existing JSON document without SQL changes.

### H2
- [x] Every locale can be selected through both Settings dashboard buttons and slash commands.
- [x] Ticket intake/creation, support-hours restriction, lifecycle outcomes/announcements, close confirmation, priority confirmation, and common expired/invalid form responses use the selected guild locale.
- [x] Equivalent button and slash-command lifecycle confirmations reuse the same localized status/priority vocabulary.
- [x] Automated tests cover command/button capability parity, localized status/priority/form copy, interpolation and fallback.
- [ ] Finish localization of the remaining Settings pages, panel previews and selected report surfaces; then complete non-production Discord guild acceptance for each supported locale.
