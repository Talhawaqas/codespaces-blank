// src/lib/integrations/health/dicomAdapter.js
//
// Healthcare & Legal Expansion SOW, Phase 10 (§10.15, §10.25) — DICOM/
// PACS reference adapter. SOW §10.15 is explicit: "Do not build a full
// PACS unless separately approved" — this adapter only ever references
// external imaging by study/series UID, it never stores or renders image
// data itself.

import { getConfiguredAdapter } from "../adapterStub.js";

export function getDicomAdapter() {
  return getConfiguredAdapter({
    name: "DICOM/PACS",
    methods: ["getStudyReference", "getSeriesReference", "getImagingReport"],
    checkEnv: ["PACS_BASE_URL", "PACS_AE_TITLE"],
  });
}
