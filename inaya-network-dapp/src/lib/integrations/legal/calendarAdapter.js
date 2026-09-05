// src/lib/integrations/legal/calendarAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§11.17, §12) — external
// court/case calendar sync adapter. legal-calendar.js's own deadline
// records already carry a `confidence`/manual-confirmation flag exactly
// so that a synced-but-unconfirmed deadline is never presented as
// authoritative — this adapter is the (currently stubbed) source that
// would populate those records from an external court calendar feed.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getCalendarAdapter() {
  return getConfiguredAdapter({
    name: "Court Calendar Sync",
    methods: ["syncDeadlinesForMatter", "getHearingSchedule"],
    checkEnv: ["COURT_CALENDAR_PROVIDER_URL", "COURT_CALENDAR_API_KEY"],
  });
}
