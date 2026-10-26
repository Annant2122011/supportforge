# Stage H: Translation and Localization Architecture

**Status:** H1 core and initial H2 coverage implemented on the consolidated feature branch; final Settings/report coverage and live acceptance remain open  
**Baseline:** Stage A–G and the Stage 1–4 consolidation are tracked in stacked review branches; final integration and external acceptance gates remain.  
**Persistence:** Existing Neon/PostgreSQL-backed advanced-settings JSON document; no SQL migration  
**Compatibility:** Existing /supportforge command root, IDs, event names, internal symbols and legacy persisted documents remain unchanged.

## Goals and non-goals

Stage H introduces a consistent translation layer for bot-generated copy without coupling business logic to dictionaries. Translation must be deterministic and type-safe; all supported catalogs are complete, and unknown persisted locale values are normalized safely. It must not translate user-provided ticket titles, custom labels, tags, message history, IDs, role names, channel names, code, URLs, error codes, or audit/event identifiers.

The canonical source language is English (United States). Part 1 provides the translation engine, a small high-value catalog, starter Hindi (India) and Bengali (India) catalogs, locale persistence primitives, interpolation and Intl formatting. Part 1 intentionally does not rewrite every existing string or add the administrator controls for changing the server locale; these are Part 2.

## Part split

### H1 — Translation core and safe rollout (this PR)

1. Create a registry of supported locale tags: en-US, hi-IN, and bn-IN; normalise legacy/malformed stored locale values to en-US.
2. Define the canonical typed TranslationKey vocabulary in the English catalog.
3. Maintain complete Hindi and Bengali dictionaries with the same typed keys as English. Missing keys fail TypeScript build rather than silently showing English or blank UI.
4. Implement translate(locale, key, params) with one-pass, non-recursive placeholder substitution. Missing parameters remain visible as {parameter} rather than silently deleting information.
5. Add locale-aware number/date formatting wrappers backed by JavaScript Intl, with deterministic fallback behavior and invalid-date checks.
6. Store a per-server locale preference in the existing versioned JSON settings document, defaulting to en-US, preserving all other server settings and avoiding a SQL migration.
7. Add regression tests for full catalog coverage in every supported locale, invalid-locale normalization, safe interpolation, date/number formatting, and settings normalization.
8. Keep the rollout opt-in: existing handlers remain in English until individually wired or H2 migrates the user-facing surfaces.

### H2 — Locale controls and end-to-end coverage (active increment)

1. Add Settings-dashboard and slash-command locale controls with identical capability, authorization, validation, audit and invalid-locale normalization behavior.
2. Localize high-traffic user surfaces incrementally: ticket intake/created, ticket lifecycle buttons and outcomes, common validation errors, forms, support-hours notices, settings dashboard, panel previews, and selected reports.
3. Pass locale explicitly at the use-case boundary rather than reading global locale inside low-level domain/repository code.
4. Define locale precedence as explicit user preference for a direct response (if supported) → per-guild setting → en-US. Avoid storing personal-language preferences until their lifecycle and privacy behavior are specified.
5. Keep stable IDs, command names, machine-readable status tokens, audit action codes and internal enum values untranslated.
6. Add interaction parity and language-specific regression tests; validate Discord message/button/select length limits after interpolation and ensure no partial localization changes component custom IDs.

## Module boundaries

- src/i18n/localeRegistry.ts: supported locales, type guard, safe resolver.
- src/i18n/locales/en-US.ts: canonical catalog and source of the TranslationKey type.
- src/i18n/locales/hi-IN.ts and bn-IN.ts: complete typed translations for every canonical key.
- src/i18n/translationService.ts: strict translation lookup, safe interpolation, date and number formatting.
- src/services/advancedSettingsService.ts: durable guild locale preference, loaded through the existing Neon-backed JSON document service.
- tests/translationService.test.ts: pure deterministic unit tests independent of Discord network access.

The translation layer may import the pure locale registry and dictionaries. It must not import Discord clients, repositories, settings services, or network APIs. The advanced-settings service may import the locale registry, but the registry must not import settings services. This avoids circular dependencies.

## Data and migration strategy

The guild setting is a simple supported-locale tag and defaults to en-US. Existing documents do not need a migration; normalization supplies the default when the property is absent or invalid. Saving a locale must update only the existing document through the JSON-document repository, preserving unrelated server settings. Do not introduce SQLite, a new table, or a separate translation database.

## Quality and safety requirements

- Every key in the English source catalog is present and non-empty.
- Every supported locale must define a non-empty translation for every English catalog key. Build-time types and catalog-coverage tests enforce this; translation lookup throws if a new missing key is somehow introduced at runtime.
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
- [x] English, Hindi and Bengali catalogs have complete key coverage; a missing translation fails verification instead of falling back to English.
- [x] Parameter values are substituted literally and only once.
- [x] Date/number output uses the requested supported locale.
- [x] New locale preference is defaulted and persisted through the existing JSON document without SQL changes.

### H2
- [x] Every locale can be selected through both Settings dashboard buttons and slash commands.
- [x] Ticket intake/creation, support-hours restriction, lifecycle outcomes/announcements, close confirmation, priority confirmation, and common expired/invalid form responses use the selected guild locale.
- [x] Equivalent button and slash-command lifecycle confirmations reuse the same localized status/priority vocabulary.
- [x] Automated tests cover catalog completeness for every supported locale, command/button capability parity, localized status/priority/form copy and safe interpolation.
- [x] Quick and detailed Staff Manual content is present in English, Hindi, and Bengali catalogs and is rendered through the selected locale.
- [x] The English, Hindi, and Bengali catalogs each contain the same 1049 unique keys, including the previously missing Bengali use-case labels and the additional Stage H form-settings, report-flow, report-rule, and custom-panel copy. The historical baseline at `f4515d6d69adb62f78d1f31ca7e73cd584c6fcef` passed [QueryFixr CI #40106837586](https://github.com/Annant2122011/supportforge/actions/runs/40106837586); that older run is not evidence for the latest candidate.
- [x] Localize custom-panel fallback/author/preview copy, ticket-form settings and modal/detail copy, report category/subcategory selection and review, plus report-rule/category slash-command output. Regression tests cover the localization adapter and localized panel fallbacks.
- [x] Consolidated implementation head `1afce9199e612736745f7264e92337c657b904b4` passed both CI verification jobs: TypeScript build passed, 228/228 tests passed, zero skipped, and the PostgreSQL verification suite passed ([run A](https://github.com/Annant2122011/supportforge/actions/runs/40122028940), [run B](https://github.com/Annant2122011/supportforge/actions/runs/40122025777)). Documentation-only follow-up changes do not alter that tested source.
- [ ] Complete non-production Discord guild acceptance for each supported locale. Custom server-authored labels, category names, role names, and panel-authored copy remain unchanged.