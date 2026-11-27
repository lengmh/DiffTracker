import * as vscode from 'vscode';
import type { DiffTracker } from './diffTracker';

/**
 * Tree item for a setting toggle
 */
class SettingItem extends vscode.TreeItem {
    constructor(
        public readonly settingKey: string,
        public readonly label: string,
        public readonly isEnabled: boolean,
        tooltip?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);

        // Use checkbox-style icons
        this.iconPath = new vscode.ThemeIcon(isEnabled ? 'check' : 'circle-large-outline');
        this.description = isEnabled ? 'On' : 'Off';
        this.contextValue = 'settingItem';
        this.command = {
            command: 'diffTracker.toggleSetting',
            title: 'Toggle Setting',
            arguments: [settingKey]
        };
        this.tooltip = tooltip ?? `Click to ${isEnabled ? 'disable' : 'enable'}`;
    }
}

/**
 * Tree item for a setting group
 */
class SettingGroupItem extends vscode.TreeItem {
    constructor(
        public readonly label: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('settings');
        this.contextValue = 'settingGroup';
    }
}

/**
 * Tree item for an action entry
 */
class SettingActionItem extends vscode.TreeItem {
    constructor(public readonly label: string, command: vscode.Command, iconId: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(iconId);
        this.command = command;
        this.contextValue = 'settingAction';
    }
}

type SettingGroup = {
    id: string;
    label: string;
    icon?: string;
    items: Array<{ key: string; label: string; defaultValue?: boolean; tooltip?: string }>;
};

/**
 * Provides the settings tree view in the sidebar
 */
export class SettingsTreeDataProvider implements vscode.TreeDataProvider<SettingItem | SettingGroupItem | SettingActionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SettingItem | SettingGroupItem | SettingActionItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private configurationChangeDisposable: vscode.Disposable;

    private settings: SettingGroup[] = [
        {
            id: 'display',
            label: 'Display',
            items: [
                { key: 'openWebviewBeside', label: 'Beside View' },
                { key: 'webviewWordWrap', label: 'WebView default: Wrap', defaultValue: false,
                    tooltip: 'Wrap long lines in new WebView panels. Close and reopen the panel to apply.' },
                { key: 'webviewExpandUnchanged', label: 'WebView default: Expand', defaultValue: false,
                    tooltip: 'Show all unchanged context lines in new WebView panels. Close and reopen the panel to apply.' },
                { key: 'showDeletedLinesBadge', label: 'Deleted line badge' },
                { key: 'showCodeLens', label: 'CodeLens actions' }
            ]
        },
        {
            id: 'highlight',
            label: 'Highlight',
            items: [
                { key: 'highlightAddedLines', label: 'Added lines' },
                { key: 'highlightModifiedLines', label: 'Modified lines' },
                { key: 'highlightWordChanges', label: 'Word changes' }
            ]
        },
        {
            id: 'recording',
            label: 'Recording',
            items: [
                { key: 'onlyRecordReviewableText', label: 'Only record reviewable text', defaultValue: false },
                { key: 'autoOpenNextPendingFile', label: 'Auto-open next pending file', defaultValue: false },
                { key: 'onlyTrackAutomatedChanges', label: 'Vibe Coding Only' },
                { key: 'enableSourceTracking', label: 'Source hints (experimental)', defaultValue: false,
                    tooltip: 'Optional source hints for Vibe Coding Only. Baseline and observation warnings remain visible when this is off.' },
                { key: 'promptOnGitBranchChange', label: 'Prompt on Git branch change', defaultValue: false },
                { key: 'autoStartRecording', label: 'Auto-start new workspaces', defaultValue: false }
            ]
        },
        {
            id: 'tools',
            label: 'Tools',
            items: []
        }
    ];

    private changingTextFilter = false;

    constructor(private readonly tracker: DiffTracker) {
        // Refresh when settings change
        this.configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('diffTracker')) {
                this.refresh();
            }
        });
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: SettingItem | SettingGroupItem | SettingActionItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SettingGroupItem): Array<SettingGroupItem | SettingItem | SettingActionItem> {
        const config = vscode.workspace.getConfiguration('diffTracker');

        if (!element) {
            return this.settings.map(group => new SettingGroupItem(group.label));
        }

        const group = this.settings.find(g => g.label === element.label);
        if (!group) {
            return [];
        }

        if (group.id === 'tools') {
            return [
                new SettingActionItem(
                    'Manage Monitoring Scope',
                    {
                        command: 'diffTracker.manageMonitoringScope',
                        title: 'Manage Monitoring Scope'
                    },
                    'filter'
                ),
                new SettingActionItem(
                    'Check Observation Coverage',
                    { command: 'diffTracker.recheckObservationCoverage', title: 'Check Observation Coverage' },
                    'refresh'
                ),
                new SettingActionItem(
                    'Rebuild Observation Coverage',
                    { command: 'diffTracker.rebuildObservationCoverage', title: 'Rebuild Observation Coverage' },
                    'sync'
                )
            ];
        }

        if (group.id === 'display') {
            const defaultOpenMode = config.get<string>('defaultOpenMode', 'webview');
            const modeLabelMap: { [key: string]: string } = {
                webview: 'Webview',
                nativeReview: 'Native Review',
                inline: 'Inline (read-only)',
                sideBySide: 'Side-by-Side',
                original: 'Original',
                splitOriginalWebview: 'Split: Original | Webview'
            };
            const modeLabel = modeLabelMap[defaultOpenMode] ?? 'Webview';
            const diffStyleLabel = config.get<string>('webviewDiffStyle', 'split') === 'unified' ? 'Unified' : 'Split';

            return [
                new SettingActionItem(
                    `Default open mode: ${modeLabel}`,
                    {
                        command: 'diffTracker.selectDefaultOpenMode',
                        title: 'Select Default Open Mode'
                    },
                    'preview'
                ),
                new SettingActionItem(
                    `WebView default layout: ${diffStyleLabel}`,
                    { command: 'diffTracker.selectWebviewDiffStyle', title: 'Select Default WebView Diff Layout' },
                    'split-horizontal'
                ),
                ...group.items.map(setting => {
                    const value = config.get<boolean>(setting.key, setting.defaultValue ?? true);
                    return new SettingItem(setting.key, setting.label, value, setting.tooltip);
                })
            ];
        }

        return group.items.map(setting => {
            const value = config.get<boolean>(setting.key, setting.defaultValue ?? true);
            return new SettingItem(setting.key, setting.label, value, setting.tooltip);
        });
    }

    /**
     * Toggle a setting
     */
    public async toggleSetting(settingKey: string): Promise<void> {
        if (settingKey === 'onlyRecordReviewableText') {
            await this.toggleReviewableText();
            return;
        }
        const config = vscode.workspace.getConfiguration('diffTracker');
        const setting = this.settings.flatMap(group => group.items).find(item => item.key === settingKey);
        const currentValue = config.get<boolean>(settingKey, setting?.defaultValue ?? true);
        const isWindowPreference = settingKey === 'webviewWordWrap' || settingKey === 'webviewExpandUnchanged' || settingKey === 'enableSourceTracking';
        const target = isWindowPreference && config.inspect(settingKey)?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update(settingKey, !currentValue, target);
        this.refresh();
    }

    private async toggleReviewableText(): Promise<void> {
        if (this.changingTextFilter) { return; }
        this.changingTextFilter = true;
        try {
            const key = 'onlyRecordReviewableText';
            const config = () => vscode.workspace.getConfiguration('diffTracker');
            const initial = config();
            const enabled = initial.get<boolean>(key, false);
            const layers = (value: vscode.WorkspaceConfiguration) => {
                const inspected = value.inspect<boolean>(key);
                return JSON.stringify([inspected?.globalValue, inspected?.workspaceValue, inspected?.workspaceFolderValue]);
            };
            const initialLayers = layers(initial);
            const target = initial.inspect(key)?.workspaceValue !== undefined
                ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
            const preview = enabled ? undefined : await this.tracker.previewUnsupportedReviewCleanup();
            let retire = false;
            if (preview?.candidates.length) {
                const cleanup = 'Enable and Stop Tracking Listed Items';
                const keep = 'Enable and Keep Existing Reviews';
                const listed = preview.candidates
                    .map(({ filePath }) => vscode.workspace.asRelativePath(vscode.Uri.file(filePath), true))
                    .join('\n');
                const decision = await vscode.window.showWarningMessage(
                    `Reviewable text only: ${preview.candidates.length} existing item(s) can stop being tracked`,
                    { modal: true, detail: 'Stopping tracking discards the listed reviews and their Undo history, not workspace files. Other reviews stay pending.\n\n' + listed },
                    cleanup, keep
                );
                if (decision !== cleanup && decision !== keep) { return; }
                retire = decision === cleanup;
            }
            const current = config();
            if (current.get<boolean>(key, false) !== enabled || layers(current) !== initialLayers) {
                void vscode.window.showWarningMessage('The text-only setting changed while awaiting confirmation. No review was removed.');
                return;
            }
            await current.update(key, !enabled, target);
            if (enabled) { return; }
            if (!config().get<boolean>(key, false)) {
                void vscode.window.showWarningMessage('Text-only recording is not effective. No review was removed.');
                return;
            }
            if (retire && preview) {
                const result = await this.tracker.retireUnsupportedReviews(preview.candidates);
                const summary = `Text-only recording is on. Stopped tracking ${result.succeeded} item(s).`;
                if (result.failed || preview.unverified) {
                    const failed = result.results.filter(item => item.status !== 'success').slice(0, 5).map(item => {
                        const path = vscode.workspace.asRelativePath(vscode.Uri.file(item.filePath), true);
                        return item.reason ? `${path}: ${item.reason}` : path;
                    });
                    void vscode.window.showWarningMessage(
                        `${summary} Retained ${result.failed} approved item(s) and ${preview.unverified} unverified item(s).` +
                        (failed.length ? ` ${failed.join('; ')}` : '')
                    );
                } else {
                    void vscode.window.showInformationMessage(summary);
                }
            } else if (preview?.unverified && !preview.candidates.length) {
                void vscode.window.showInformationMessage(
                    `Text-only recording is on. Kept ${preview.unverified} existing item(s) that could not be verified.`
                );
            }
        } catch {
            void vscode.window.showErrorMessage('Could not complete the text-only recording change. Check the setting and pending reviews before retrying.');
        } finally {
            this.changingTextFilter = false;
            this.refresh();
        }
    }

    public dispose(): void {
        this.configurationChangeDisposable.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
