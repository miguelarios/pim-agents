# Test Fixture Origin

The `.ics` files in this directory are sourced from the ical.js project at
https://github.com/kewisch/ical.js/tree/main/samples and are licensed under
the Mozilla Public License 2.0 (https://www.mozilla.org/en-US/MPL/2.0/).

These files are used as test inputs only; pim-core itself remains MIT-licensed.
The MPL is file-scoped: modifying one of these fixture files would keep that
file under MPL 2.0, but does not affect the license of any pim-core source code.

The hand-written `*.oracle.json` files paired with each fixture are pim-core
originals (MIT-licensed) describing the expected parser output for the
adjacent `.ics` input.

The synthesized fixtures `dst_transition.ics`, `vtodo_basic.ics`,
`vtodo_with_due_completed.ics`, `vjournal_basic.ics`, `server_expanded.ics` and
`server_expanded_all_day.ics` are pim-core originals (MIT-licensed). The two
`server_expanded*` fixtures reproduce the shape SabreDAV (Nextcloud) returns for a
calendar-query with `<expand>`: one VEVENT per instance, each with a RECURRENCE-ID,
no RRULE, no master, and no VTIMEZONE.
