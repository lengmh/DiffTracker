// Focused stage-2 safety probes, also included in normal tracker regressions.
// Unknown document-event authorship uses the specified conservative policy.
// Historical stronger author inference remains in legacy-manual-policy.mjs.
process.env.DT_KNOWN_P0 = '1';
await import('./tracker-safety.mjs');
