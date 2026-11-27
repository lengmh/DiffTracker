(() => {
  const vscode = acquireVsCodeApi();
  const mode = document.getElementById('mode');
  const includes = document.getElementById('includes');
  const excludes = document.getElementById('excludes');
  const presets = ['md', 'txt', 'json', 'log'].map(suffix => [suffix, document.getElementById('suffix-' + suffix)]);
  const suffixInput = document.getElementById('suffix-input');
  const suffixAdd = document.getElementById('suffix-add');
  const suffixCustom = document.getElementById('suffix-custom');
  const suffixRemove = document.getElementById('suffix-remove');
  const suffixStatus = document.getElementById('suffix-status');
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
  let lifecycle;
  const updateLifecycleControls = () => {
    const blocked=!!(lifecycle?.blocker || lifecycle?.settingsWritePending || lifecycle?.scopeActionPending || lifecycle?.controllerDisposed);
    for(const id of ['save-apply','apply'])document.getElementById(id).disabled=busy || blocked;
    document.getElementById('retry-recovery').disabled=!!(busy || !lifecycle?.recoveryBlocked || lifecycle?.disposed || lifecycle?.recoveryRequiresReload || lifecycle?.recoveryRetryActive || lifecycle?.baselineTransactionActive || lifecycle?.settingsWritePending);
    document.getElementById('discard-recovery').disabled=!!(busy || !lifecycle?.recoveryBlocked || lifecycle?.disposed || lifecycle?.recording || lifecycle?.recoveryRetryActive || lifecycle?.baselineTransactionActive || lifecycle?.settingsWritePending);
  };
  const controls = ['mode','includes','excludes','save-apply','save','apply','reload',
    'migrate','complete-migration','restore','dismiss','discard-draft','review-conflict'].map(id=>document.getElementById(id));
  const updateDraftNotice = () => {
    const conflict=dirty && currentVersion && baseVersion!==currentVersion;
    document.getElementById('review-conflict').disabled=busy || !conflict;
    document.getElementById('draft-state').textContent=busy?'Monitoring-scope action in progress…'
      : conflict?'Workspace settings changed. Your draft is preserved. Review Settings Conflict to keep it, or explicitly discard it and reload.'
        : dirty?'Unsaved draft. Save and Apply completes the scope change; Save Request Only leaves it pending.':'Editor matches the saved monitoring request.';
  };
  const setBusy = value => {busy=value;for(const control of controls)control.disabled=value;updateDraftNotice();updateLifecycleControls();syncSuffixControls();};
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
  const markDraftChanged = () => {dirty=true;draftRevision++;publishDraft();};

  const parseArray = (value, label) => {
    const parsed = JSON.parse(value || '[]');
    if (!Array.isArray(parsed)) throw new Error(label + ' must be a JSON array');
    return parsed;
  };

  // Only project the exact all-root rule shape we can round trip without
  // changing the meaning of hand-written patterns or root-specific exclusions.
  const isExtension = value => value.length <= 64 && /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(value);
  const patternFor = suffix => '**/*.' + suffix;
  const ruleExtension = rule => {
    if (rule?.scope !== 'all' || Object.keys(rule).length !== 2 || typeof rule.pattern !== 'string' ||
        !rule.pattern.startsWith('**/*.')) return undefined;
    const suffix = rule.pattern.slice(5);
    return isExtension(suffix) ? suffix : undefined;
  };

  const syncSuffixControls = () => {
    let extensions;
    try {
      extensions = new Set(parseArray(excludes.value,'Excludes').map(ruleExtension).filter(Boolean));
      suffixStatus.textContent = '';
    } catch {
      suffixStatus.textContent = 'Fix the Explicit excludes JSON to use these controls. Your draft is unchanged.';
    }
    const blocked = busy || !initialized || !extensions;
    for (const [suffix, field] of presets) {
      field.checked = extensions?.has(suffix) ?? false;
      field.disabled = blocked;
    }
    const previous = suffixCustom.value;
    suffixCustom.replaceChildren();
    const custom = [...(extensions ?? [])].filter(suffix => !presets.some(([preset]) => preset === suffix)).sort();
    for (const suffix of custom) {
      const option = document.createElement('option');
      option.value = suffix;
      option.textContent = '.' + suffix;
      suffixCustom.append(option);
    }
    suffixCustom.value = custom.includes(previous) ? previous : custom[0] ?? '';
    suffixInput.disabled = suffixAdd.disabled = blocked;
    suffixCustom.disabled = suffixRemove.disabled = blocked || custom.length === 0;
  };

  const editSuffix = (suffix, exclude) => {
    if (busy || !initialized) return false;
    if (!isExtension(suffix)) {
      suffixStatus.textContent = 'Enter one file extension, such as .csv or .tar.gz. Do not enter paths or wildcards.';
      return false;
    }
    try {
      const rules = parseArray(excludes.value,'Excludes');
      if (rules.some(rule => ruleExtension(rule) === suffix) !== exclude) {
        const updated = exclude ? [...rules, {scope:'all',pattern:patternFor(suffix)}]
          : rules.filter(rule => ruleExtension(rule) !== suffix);
        excludes.value = JSON.stringify(updated, null, 2);
        markDraftChanged();
      }
      syncSuffixControls();
      return true;
    } catch {
      syncSuffixControls();
      return false;
    }
  };

  const addCustomSuffix = () => {
    if (editSuffix(suffixInput.value.trim().replace(/^\./, ''),true)) suffixInput.value = '';
  };
  for (const [suffix, field] of presets) {
    field.addEventListener('change', () => editSuffix(suffix, field.checked));
  }
  suffixAdd.addEventListener('click', addCustomSuffix);
  suffixInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {event.preventDefault();addCustomSuffix();}
  });
  suffixRemove.addEventListener('click', () => editSuffix(suffixCustom.value,false));
  for (const field of [mode,includes,excludes]) {
    const changed = () => {
      markDraftChanged();
      if (field === excludes) syncSuffixControls();
    };
    field.addEventListener('input', changed);
    field.addEventListener('change', changed);
  }
  syncSuffixControls();

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
  document.getElementById('retry-recovery').addEventListener('click',()=>{if(!busy)vscode.postMessage({command:'retryRecovery'});});
  document.getElementById('discard-recovery').addEventListener('click',()=>{if(!busy)vscode.postMessage({command:'discardRecovery'});});
  document.getElementById('reload').addEventListener('click', () => vscode.postMessage({ command: 'reload' }));
  document.getElementById('migrate').addEventListener('click', () => vscode.postMessage({ command: 'migrateLegacy' }));
  document.getElementById('complete-migration').addEventListener('click',()=>submitDraft('completeLegacyMigration'));
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
      lifecycle=message.lifecycle;
      document.getElementById('lifecycle-status').textContent=lifecycle?.blocker?.reason ||
        (lifecycle?.settingsWritePending?'A scope settings write is still pending. Wait for it to finish.':lifecycle?.scopeActionPending?'A monitoring scope action is in progress. Wait for it to finish.':lifecycle?.controllerDisposed?'This Monitoring Scope controller is closed. Reopen it after reloading the window.':'No lifecycle blocker.');
      document.getElementById('migration-status').textContent=message.migration?.reason || '';
      updateLifecycleControls();
      if (!initialized || (!dirty && !busy)) {
        mode.value = message.rawRequested?.mode || 'rules';
        includes.value = JSON.stringify(message.rawRequested?.includes || [], null, 2);
        excludes.value = JSON.stringify(message.rawRequested?.excludes || [], null, 2);
        baseVersion = message.requestVersion;
        initialized = true;
      }
      syncSuffixControls();
      publishDraft();
      status.textContent = JSON.stringify({
        lifecycle: message.lifecycle,
        migration: message.migration,
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
