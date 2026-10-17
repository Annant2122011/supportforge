# Slash-command and button parity

SupportForge exposes two independent entry points for each major feature: slash commands and persistent/button-driven controls. A slash command must not merely display a button and require that button to complete the action. Multi-step flows may still use select menus or modals when the operation needs user input.

## Feature coverage

| Feature area | Slash-command entry point | Button entry point |
| --- | --- | --- |
| Initial setup and recovery | `/supportforge setup`, `/supportforge restore` | Settings → Repair System → Setup / Restore |
| Department management | `/supportforge category add/list/remove`, `/supportforge settings department-edit` | Settings → Departments |
| Department tags | `/supportforge settings tag-add/tag-rename/tag-remove` | Settings → Departments → Manage Tags |
| Department presets | `/supportforge settings usecase-add` | Settings → Use Cases |
| Ticket forms and templates | `/supportforge form list/create/update/activate/deactivate/template-save/template-list/template-apply/template-delete` | Settings → Ticket Forms |
| Ticket creation and lifecycle | `/supportforge ticket create` (department/tag IDs, then the same validated form modal), plus `claim/unclaim/pending/resume/close/reopen/archive` | Department ticket-creation buttons and ticket panel lifecycle controls |
| Ticket priority and notes | `/supportforge ticket priority/note` | Ticket panel Priority and Note controls |
| Ticket history and participants | `/supportforge ticket history/add-user/remove-user/reassign` | Ticket panel History, Add User, Remove User, and Reassign controls |
| Ticket routing | `/supportforge ticket department/tag` with explicit routing IDs | Ticket panel Department and Tag controls |
| Ticket voice | `/supportforge ticket voice` | Ticket panel voice controls |
| Ticket reports | `/supportforge ticket report` | Ticket panel Report workflow |
| Ticket panel position | `/supportforge ticket panel/move-panel` | Ticket panel move/restore controls |
| Settings and panel behavior | `/supportforge settings overview/panel/defaults/team/retention/appearance` | Settings dashboard controls |
| Report intake and categories | `/supportforge settings reports/report-rules/report-subcategory-add/report-subcategory-edit/report-subcategory-remove` | Settings → Reports controls |
| Retention review and action | `/supportforge settings retention-action` | Settings → Retention review/approval controls |
| Storage and infrastructure repair | `/supportforge settings storage/repair/refresh` | Settings → Repair System and Storage controls |
| Manual and factory reset | `/supportforge settings manual/reset` | Settings → Manual and multi-step Reset controls |
| Premium demo | `/supportforge premium status/toggle-demo` | Settings → Premium controls |
| Audit summaries and controls | `/supportforge audit summary/daily/accumulation/developer/panel` | Audit panel summary, accumulation, Developer View, and move/restore controls |

## Independent-path rules

- Slash commands that change ticket state, routing, voice state, or submit a report execute the operation directly after revalidating permissions and persisted state.
- Button handlers continue to use the same domain services and validations; they do not depend on a slash command having been run first.
- Destructive operations retain explicit confirmation. In particular, clearing raw audit events requires `confirm-delete: true` through the slash command or the existing confirmation button flow.
- Complex forms can use modals and select menus to collect the required inputs. The slash command itself must not require a follow-up button merely to execute an action it already identifies.
- Neon PostgreSQL remains the persistence provider. Interaction parity must not introduce a separate SQLite persistence path.

## Verification

The automated TypeScript build, tests, and database verification are required before declaring a change complete. Live Discord interaction testing is a separate verification step and must be reported separately from CI results.
