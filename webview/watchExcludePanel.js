(() => {
  const vscode = acquireVsCodeApi();
  const mode = document.getElementById('mode');
  const includes = document.getElementById('includes');
  const excludes = document.getElementById('excludes');
  const status = document.getElementById('status');
  const testInput = document.getElementById('test-path');
  const testResult = document.getElementById('test-result');

  const parseArray = (value, label) => {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) throw new Error(label + ' must be a JSON array');
    return parsed;
  };

  document.getElementById('save').addEventListener('click', () => {
    try {
      vscode.postMessage({
        command: 'saveRequest',
        mode: mode.value,
        includes: parseArray(includes.value, 'Includes'),
        excludes: parseArray(excludes.value, 'Excludes')
      });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  document.getElementById('apply').addEventListener('click', () => vscode.postMessage({ command: 'apply' }));
  document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
  document.getElementById('migrate').addEventListener('click', () => vscode.postMessage({ command: 'migrateLegacy' }));
  document.getElementById('complete-migration').addEventListener('click', () => {
    try {
      vscode.postMessage({
        command: 'completeLegacyMigration',
        mode: mode.value,
        includes: parseArray(includes.value, 'Includes'),
        excludes: parseArray(excludes.value, 'Excludes')
      });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  document.getElementById('restore').addEventListener('click', () => vscode.postMessage({ command: 'restoreEffective' }));
  document.getElementById('dismiss').addEventListener('click', () => vscode.postMessage({ command: 'dismissConsent' }));
  document.getElementById('test-btn').addEventListener('click', () => {
    testResult.textContent = 'Testing…';
    vscode.postMessage({ command: 'testPath', testPath: testInput.value.trim() });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'scopeStatus') {
      mode.value = message.rawRequested?.mode || 'rules';
      includes.value = JSON.stringify(message.rawRequested?.includes || [], null, 2);
      excludes.value = JSON.stringify(message.rawRequested?.excludes || [], null, 2);
      status.textContent = JSON.stringify({
        requested: message.requested,
        effective: message.effective,
        consented: message.consented,
        dismissed: message.dismissed,
        legacyMigrationComplete: message.legacyMigrationComplete,
        legacyGlobalRules: message.legacyGlobalRules,
        legacyCommittedRules: message.legacyCommittedRules,
        expansionReasons: message.expansionReasons,
        explicitlyExcludedPendingReviews: message.explicitlyExcludedPendingReviews,
        retainedReviewPaths: message.retainedReviewPaths,
        coverageGaps: message.coverageGaps,
        coverageGeneration: message.coverageGeneration,
        policyFingerprint: message.policyFingerprint
      }, null, 2);
    }
    if (message.command === 'testResult') {
      testResult.textContent = message.reason || (message.ignored ? 'Ignored' : 'Monitored');
    }
  });

  vscode.postMessage({ command: 'reload' });
})();
