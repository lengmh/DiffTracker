// Deliberately outside npm test: desired safety assertions currently expose
// deferred stage-2 P0s. Exit 1 is evidence of release blockers, not a green gate.
// Reuses the exact production loader and VS Code boundary from tracker-safety.
process.env.DT_KNOWN_P0 = '1';
await import('./tracker-safety.mjs');
