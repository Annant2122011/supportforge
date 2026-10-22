# Stage H: Translation and Localization Architecture

**Status:** H1 core and H2 first implementation complete in this branch; CI and live-guild acceptance still required before production rollout.  
**Persistence:** Existing Neon/PostgreSQL-backed advanced-settings JSON document; no SQL migration.  
**Compatibility:** Existing `/supportforge` root, ticket IDs, component custom IDs, event codes and stored machine values remain unchanged.

## H2 scope

Stage H2 expands the canonical dictionary and adds locale selection paths while keeping user-authored content and durable identifiers literal. The server locale defaults to `en-US` and is stored in the existing versioned advanced-settings document. The change adds no table, migration, SQLite fallback, or separate translation service.

## Supported locales

| Locale | Language |
|---|---|
| `en-US` | English (United States), canonical source |
| `hi-IN` | Hindi (India) |
| `bn-IN` | Bengali (India) |
| `es-ES` | Spanish (Spain) |
| `fr-FR` | French |
| `de-DE` | German |
| `pt-BR` | Portuguese (Brazil) |
| `ar` | Arabic |
| `ja-JP` | Japanese |

Each catalogue is typed against the canonical English `TranslationKey` vocabulary. All nine catalogues currently include more than eighty non-empty keys for common controls, settings and locale feedback, ticket lifecycle outcomes, intake and support-hours messages, recovery notice, priorities, audit copy, and ticket-panel controls. Locale aliases are normalized safely; an unsupported persisted locale resolves to English.

## Operator controls

- **Settings dashboard:** the **Server Language** control opens a native select menu showing each language by its readable and native name.
- **Slash command:** `/supportforge settings language` displays the current locale; `/supportforge settings language locale:<locale>` saves a supported locale.
- Saving uses the existing advanced-settings document, refreshes the Settings panel, writes a `SERVER_LANGUAGE_CHANGED` audit entry and confirms the new selection in that language.
- The locale selection is server-wide, not a personal Discord preference. User-authored ticket subjects, descriptions, form answers, names, tags, IDs, URLs, timestamps in archived user content, audit action identifiers, and component custom IDs are not machine-translated.

## Localization boundaries

The translation engine uses one-pass placeholder substitution. Parameter values are literal and are not reparsed as template syntax. Date and number helpers use JavaScript `Intl` APIs. Translation is applied at interaction/message construction boundaries, not within repository code or lifecycle state machines.

The first H2 coverage includes:
- Ticket-panel lifecycle and management button labels, including claim, unclaim, pending, close, resume, reopen, archive, history, participants, priority, department/tag, voice controls, deletion and control positioning.
- Ticket-creation confirmation, duplicate/in-progress intake messages and support-hours blocking copy.
- Lifecycle outcome messages and selected announcements.
- Locale selector prompts, saved/current/unknown-language messages and audit-aware persistence.

This is not a claim that every legacy embed, validation error, form field, third-party Discord label or historical message is translated. Existing strings are migrated incrementally. English remains the safe fallback where a message has not yet been migrated.

## Discord command declaration limit

Discord limits the number of subcommands inside one subcommand group to 25. The existing Settings group exceeded that limit and failed at module initialization before the bot could start or register slash commands. H2 moves the four reporting taxonomy operations to a sibling `settings-reports` group and adds the language action to the Settings group, leaving exactly 25 subcommands in `settings`. The shared settings command handler and admin permission gate cover both groups.

A command-registration regression test imports the command module and verifies the builder initializes. This catches violations of Discord builder constraints during automated tests instead of only when an operator runs command deployment or starts the bot.

## Module boundaries

- `src/i18n/localeRegistry.ts`: supported locale tags, aliases and safe resolver.
- `src/i18n/locales/en-US.ts`: canonical typed key vocabulary.
- `src/i18n/locales/*.ts`: complete locale catalogues.
- `src/i18n/translationService.ts`: translation, interpolation, date and number formatting.
- `src/services/advancedSettingsService.ts`: durable server locale through the existing Neon-backed settings document.
- `src/services/settingsChannelService.ts` and `src/interactions/settingsInteractions.ts`: Settings dashboard language control.
- `src/interactions/settingsCommandTools.ts` and `src/commands/supportforge.ts`: slash command.
- `tests/translationService.test.ts`: alias, catalogue completeness, fallback, placeholder safety and formatting.
- `tests/commandRegistration.test.ts`: command declaration builds at import time.

The translation engine remains independent of Discord and database APIs. The locale registry must not import settings services, and translation calls never read a global guild or interaction context.

## Data and migration strategy

The locale tag is stored in the existing JSON settings document, with `en-US` as the default. Existing documents that predate locale selection remain valid; normalization supplies the default when the property is missing or invalid. Updating the locale preserves unrelated server settings. Do not introduce SQLite, a new table, or a separate translation database.

## Verification and rollout

Automated checks must confirm:
- Build and TypeScript validation pass.
- Every supported locale contains each canonical key and preserves placeholder names.
- Unknown locale tags fall back safely to English.
- Inserted parameter values are substituted literally and only once.
- The command definition initializes under Discord's subcommand limit.
- Unit tests and PostgreSQL verification pass in CI using disposable test resources.

Before production, test each selected locale in a non-production Discord guild: select language through both the Settings button and slash command, confirm it persists across restart, check rendered labels fit Discord limits, verify ticket lifecycle flows and role gates, and confirm audit records do not translate action codes. Production Neon data must not be used for destructive tests.
