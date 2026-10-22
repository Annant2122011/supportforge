# Slash-command and button parity

QueryFixr exposes two independent entry points for each major feature: slash commands and persistent/button-driven controls. A slash command must not merely display a button and require that button to complete the action. Multi-step flows may still use select menus or modals when the operation needs user input.

## Feature coverage

| Feature area | Slash-command entry point | Button entry point |
| --- | --- | --- |
| Initial setup and recovery | `/qf setup`, `/qf restore` | Settings → Repair System → Setup / Restore |
| Department management | `/qf category add/list (paginated)/remove`, `/qf settings department-edit` | Settings → Departments |
| Department tags | `/qf settings tag-add/tag-rename/tag-remove` | Settings → Departments → Manage Tags |
| Department presets | `/qf settings usecase-add` | Settings → Use Cases |
| Ticket forms and templates | `/qf form list/show/schema/guide/quick-create/create/update/activate/deactivate/template-save/template-list/template-show/template-apply/template-delete` | Settings → Ticket Forms (guided builder, advanced schema, form detail, schema JSON, field guide, templates, activation, and routing IDs) |
| Custom multi-panel builder | `/qf panel create/list/show/update/preview/publish/delete` | Settings → Ticket Panels (guided draft, button target editor, branding, order controls, role access, private preview, publish-channel picker, confirmed delete) |
| Ticket creation and lifecycle | `/qf ticket create` (department/tag IDs, then the same validated form modal), plus `claim/unclaim/pending/resume/close/reopen/archive` | Department ticket-creation buttons and ticket panel lifecycle controls |
| Ticket priority and notes | `/qf ticket priority/note` | Ticket panel Priority and Note controls |
| Ticket history and participants | `/qf ticket history/add-user/remove-user/reassign` | Ticket panel History, Add User, Remove User, and Reassign controls |
| Ticket routing | `/qf ticket department/tag` with explicit routing IDs | Ticket panel Department and Tag controls |
| Ticket voice | `/qf ticket voice` | Ticket panel voice controls |
| Ticket reports | `/qf ticket report` | Ticket panel Report workflow |
| Ticket panel position | `/qf ticket panel/move-panel` | Ticket panel move/restore controls |
| Settings and panel behavior | `/qf settings overview/theme/panel/defaults/team/retention/appearance` | Settings dashboard controls, including per-server Theme and the visual Settings Layout builder for title/description/footer, navigation order, labels and emojis |
| Ticket inactivity automation | `/qf settings inactivity action:show/enable/disable/configure` | Settings → Inactivity Automation → Enable/Disable / Edit Thresholds (automation is disabled by default) |
| Report intake and categories | `/qf settings reports/report-categories/report-rules/report-subcategory-add/report-subcategory-edit/report-subcategory-remove` | Settings → Reports controls |
| Retention review and action | `/qf settings retention-action` | Settings → Retention review/approval controls |
| Storage and infrastructure repair | `/qf settings storage action:status/claimed/pending/repair`, `/qf settings repair/refresh` | Settings → Repair System and Storage controls |
| Manual and factory reset | `/qf settings manual/reset` | Settings → Manual and multi-step Reset controls |
| Premium demo | `/qf premium status/toggle-demo` | Settings → Premium controls |
| Audit summaries and controls | `/qf audit summary/daily/accumulation/developer/panel` | Audit panel summary, accumulation, Developer View, and move/restore controls |

## Operation-level review

The table above groups the surface by feature area. This operation checklist is the review pass over the concrete command actions and the existing component routes. Navigation-only controls (Back, Cancel, Previous/Next, Restore to Settings) are not separate business operations; they must still acknowledge and safely navigate their own interaction.

| Operation family | Slash-command route | Existing button/component route | Parity expectation |
| --- | --- | --- | --- |
| Setup and restore | `/qf setup`, `/qf restore` | Settings → Setup / Restore | Each route independently runs setup/restore. |
| Infrastructure recovery | `/qf settings repair`, `storage`, `refresh` | Settings → Normal Repair, Storage Repair, Refresh | Each route runs the repair/refresh directly. |
| Departments | `/qf category add/list/remove`, `/qf settings department-edit` | Departments → Add, Manage, Edit, Remove | Both routes validate active tickets and preserve category safety. |
| Tags | `/qf settings tag-add/tag-rename/tag-remove` | Departments → Manage Tags → Add/Edit/Remove | Both routes preserve at least one tag per department. |
| Department presets | `/qf settings usecase-add` | Settings → Use Cases | Both routes add the preset and starter tags. |
| Ticket creation | `/qf ticket create` | Department create buttons → tag selector → form modal | Both routes enter the same validated creation pipeline. |
| Ticket lifecycle | `/qf ticket claim/unclaim/pending/resume/close/reopen/archive` | Ticket panel lifecycle buttons | Each route performs the lifecycle transition directly. |
| Ticket assignment and participants | `/qf ticket reassign/add-user/remove-user` | Ticket panel Reassign/Add User/Remove User | Both routes validate staff and owner restrictions. |
| Ticket priority and notes | `/qf ticket priority/note` | Ticket panel Priority/Note | Both routes directly update priority or record a staff-only note. |
| Ticket history | `/qf ticket history` | Ticket panel History | Both routes independently read recent audit events. |
| Ticket department/tag routing | `/qf ticket department/tag` | Ticket panel Department/Tag selectors | Both routes validate destination IDs and update persisted routing. |
| Ticket voice | `/qf ticket voice` with start/end/join | Ticket panel Voice Start/End/Join | Both routes independently execute the selected voice action. |
| Ticket reports | `/qf ticket report` | Ticket panel Report → participant/category/subcategory → Flag/Record Only | Both routes submit the report with equivalent flag-versus-record-only intent. |
| Ticket panel positioning | `/qf ticket move-panel` | Move Panel / Restore-Move Panel | Both routes move the panel to the bottom and re-arm activity tracking. |
| Form list and form detail | `/qf form list/show` | Ticket Forms list and form detail selector | Both routes display the same saved form metadata and field summary. |
| Form schema and guide | `/qf form schema/guide` | View Schema JSON / Field Schema Guide | Both routes expose paginated JSON and the supported schema rules. |
| Form lifecycle | `/qf form create/update/activate/deactivate` | Create Form / Update Schema / Activate / Deactivate | Both routes use the same versioned form service. |
| Form templates | `/qf form template-save/template-list/template-show/template-apply/template-delete` | Templates → Save/List/Detail/Apply/Delete | Both routes preserve template/form independence. |
| Form routing IDs | Included in `/qf form list` | Ticket Forms → Routing IDs | Both routes display the department and tag IDs used by form mappings. |
| Panel automation | `/qf settings panel` | Settings → Panel → Toggle/Edit Thresholds | Both routes update the same automatic movement settings. |
| Inactivity automation | `/qf settings inactivity action:show/enable/disable/configure idle-hours:72 grace-hours:24` | Settings → Inactivity Automation | Show, enable, disable, and threshold configuration execute independently; warning cancellation, transcript-before-close, and protected exemptions are shared behavior. |
| Ticket defaults and team capacity | `/qf settings defaults/team` | Settings → Defaults / Team & Voice | Both routes update the default priority and moderator/voice capacity. |
| Retention | `/qf settings retention/retention-action` | Settings → Retention / Review / Approval | Both routes review eligibility and require explicit approval before deletion. |
| Appearance | `/qf settings appearance` | Settings → Appearance → Edit | Both routes update and resync the public support panel. |
| Report intake and safety rules | `/qf settings reports/report-rules` | Settings → Reports → Toggle/Flag Rules | Both routes change report intake and thresholds. |
| Report subcategories | `/qf settings report-categories/report-subcategory-add/report-subcategory-edit/report-subcategory-remove` | Settings → Reports → Category → Add/Edit/Remove | Both routes mutate the same category/subcategory records. |
| Storage categories | `/qf settings storage action:status/claimed/pending/repair` | Settings → Storage → View/Add Claimed/Add Pending/Storage Repair | Both routes provision or repair the same storage categories. |
| Priority roles | `/qf settings priority-role` (status/create/delete) | Settings → Priority Rules & Roles → Create/Delete | Both routes enforce Administrator and Manage Roles requirements. |
| Manuals | `/qf settings manual` | Settings → Quick/Detailed Manual | Both routes display the same help content. |
| Factory reset | `/qf settings reset` | Settings → Reset confirmation flow | Both routes require explicit confirmation and preserve the audit-retention choice. |
| Audit summaries | `/qf audit summary/daily` | Audit panel → Quick/Overall/Daily Summary | Both routes apply the same internal-event visibility rules. |
| Audit accumulation | `/qf audit accumulation` | Audit panel → Accumulation → Enable/Revert/Confirm | Both routes expose status and protect raw-event clearing with confirmation. |
| Developer audit view | `/qf audit developer` | Audit panel → Developer View → Enable/Disable/Page | Both routes apply per-user access and private-channel permissions. |
| Audit panel management | `/qf audit panel` | Audit panel → Move/Restore/Refresh | Both routes operate directly on the audit panel. |

## Independent-path rules

- Slash commands that change ticket state, routing, voice state, or submit a report execute the operation directly after revalidating permissions and persisted state.
- Button handlers continue to use the same domain services and validations; they do not depend on a slash command having been run first.
- Settings slash commands enforce the same Manage Server/Administrator gate as the Settings controls; the Staff Manual remains available to configured department staff.
- Department staff-role migration, priority-role hierarchy, and missing durable ticket-record recovery use shared services so the button and slash routes apply the same side effects.
- Destructive operations retain explicit confirmation. In particular, clearing raw audit events requires `confirm-delete: true` through the slash command or the existing confirmation button flow.
- Complex forms can use modals and select menus to collect the required inputs. The slash command itself must not require a follow-up button merely to execute an action it already identifies.
- Neon PostgreSQL remains the persistence provider. Interaction parity must not introduce a separate SQLite persistence path.

## Verification

The automated TypeScript build, tests, and database verification are required before declaring a change complete. Live Discord interaction testing is a separate verification step and must be reported separately from CI results.
