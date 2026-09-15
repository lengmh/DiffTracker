// Historical desired authorship inference retained verbatim as a diagnostic.
// This boundary supplies no trustworthy author signal. Stage 2 deliberately
// keeps these edits pending rather than silently accepting unknown content.
// Expected: two failures for the legacy A=manual baseline assumption.
process.env.DT_LEGACY_MANUAL='1';
await import('./tracker-safety.mjs');
