(() => {
  const vscode = acquireVsCodeApi();
  const mode = document.getElementById('mode');
  const includes = document.getElementById('includes');
  const excludes = document.getElementById('excludes');
  const status = document.getElementById('status');
  const testInput = document.getElementById('test-path');
  const testResult = document.getElementById('test-result');
  const saved = vscode.getState?.();
  let dirty = saved?.dirty === true;
  let initialized = dirty;
  let draftRevision = saved?.draftRevision || 0;
  let baseVersion = saved?.baseVersion;
  let currentVersion;
  let actionId = saved?.actionId || 0;
  let activeAction;
  let busy = false;
  let leaseId;
  const controls = ['mode','includes','excludes','save-apply','save','apply','reload',
    'migrate','complete-migration','restore','dismiss','discard-draft','review-conflict'].map(id=>document.getElementById(id));
  const updateDraftNotice = () => {
    const conflict=dirty && currentVersion && baseVersion!==currentVersion;
    document.getElementById('review-conflict').disabled=busy || !conflict;
    document.getElementById('draft-state').textContent=busy?'Monitoring-scope action in progress…'
      : conflict?'Workspace settings changed. Your draft is preserved. Review Settings Conflict to keep it, or explicitly discard it and reload.'
        : dirty?'Unsaved draft. Save and Apply completes the scope change; Save Request Only leaves it pending.':'Editor matches the saved monitoring request.';
  };
  const setBusy = value => {busy=value;for(const control of controls)control.disabled=value;updateDraftNotice();};
  if (dirty) {
    mode.value = saved.mode;
    includes.value = saved.includes;
    excludes.value = saved.excludes;
  }
  const persist = () => vscode.setState?.({dirty,draftRevision,baseVersion,actionId,
    mode:mode.value,includes:includes.value,excludes:excludes.value});
  const publishDraft = () => {
    persist();
    updateDraftNotice();
    vscode.postMessage({command:'draftChanged',dirty,draftRevision,baseVersion});
  };
  for (const field of [mode,includes,excludes]) {
    field.addEventListener('input', () => {dirty=true;draftRevision++;publishDraft();});
    field.addEventListener('change', () => {dirty=true;draftRevision++;publishDraft();});
  }

  const parseArray = (value, label) => {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) throw new Error(label + ' must be a JSON array');
    return parsed;
  };

  const submitDraft = command => {
    if (busy) return;
    try {
      const request = {command,mode:mode.value,
        includes:parseArray(includes.value,'Includes'),excludes:parseArray(excludes.value,'Excludes'),
        baseVersion,draftRevision,actionId:++actionId};
      activeAction = request.actionId;
      setBusy(true);
      persist();
      vscode.postMessage(request);
    } catch (error) {activeAction=undefined;setBusy(false);status.textContent=error instanceof Error?error.message:String(error);}
  };
  document.getElementById('save-apply').addEventListener('click',()=>submitDraft('saveAndApply'));
  const submitAction = command => {
    if(busy)return;
    activeAction=++actionId;setBusy(true);persist();
    vscode.postMessage({command,actionId:activeAction,draftRevision,baseVersion});
  };

  document.getElementById('save').addEventListener('click', () => {
    try {
      submitDraft('saveRequest');
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  document.getElementById('apply').addEventListener('click', () => submitAction('apply'));
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
  document.getElementById('restore').addEventListener('click', () => submitAction('restoreEffective'));
  document.getElementById('discard-draft').addEventListener('click', () => submitAction('discardDraft'));
  document.getElementById('review-conflict').addEventListener('click', () => submitAction('reviewConflict'));
  document.getElementById('dismiss').addEventListener('click', () => vscode.postMessage({ command: 'dismissConsent' }));
  document.getElementById('test-btn').addEventListener('click', () => {
    testResult.textContent = 'Testing…';
    vscode.postMessage({ command: 'testPath', testPath: testInput.value.trim() });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'lockDraft') {
      const clean = !busy && !dirty;
      if (clean) {leaseId=message.leaseId;setBusy(true);}
      vscode.postMessage({command:'draftLockAck',leaseId:message.leaseId,dirty:!clean,draftRevision,baseVersion});
    }
    if (message.command === 'unlockDraft' && leaseId === message.leaseId) {
      leaseId=undefined;setBusy(false);
    }
    if (message.command === 'scopeStatus') {
      currentVersion=message.requestVersion;
      if (!initialized || (!dirty && !busy)) {
        mode.value = message.rawRequested?.mode || 'rules';
        includes.value = JSON.stringify(message.rawRequested?.includes || [], null, 2);
        excludes.value = JSON.stringify(message.rawRequested?.excludes || [], null, 2);
        baseVersion = message.requestVersion;
        initialized = true;
      }
      publishDraft();
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
        policyFingerprint: message.policyFingerprint,
        operationOutcome: message.operationOutcome
      }, null, 2);
    }
    if (message.command === 'draftBaseAccepted' && activeAction===message.actionId && draftRevision===message.draftRevision) {
      baseVersion=message.baseVersion;draftRevision++;publishDraft();
    }
    if (message.command === 'scopeOperation' && activeAction !== undefined && message.actionId === activeAction) {
      if (message.acceptDraft && message.draftRevision === draftRevision) {dirty=false;}
      activeAction = undefined;
      setBusy(false);
      publishDraft();
      status.textContent = JSON.stringify(message.outcome,null,2);
    }
    if (message.command === 'testResult') {
      testResult.textContent = message.reason || (message.ignored ? 'Ignored' : 'Monitored');
    }
  });

  vscode.postMessage({ command: 'reload' });
})();
