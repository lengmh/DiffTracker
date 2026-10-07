import * as vscode from 'vscode';

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
                { key: 'onlyTrackAutomatedChanges', label: 'Vibe Coding Only' }
            ]
        },
        {
            id: 'tools',
            label: 'Tools',
            items: []
        }
    ];

    constructor() {
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
                    'Recheck Observation Coverage',
                    { command: 'diffTracker.recheckObservationCoverage', title: 'Recheck Observation Coverage' },
                    'refresh'
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
        const config = vscode.workspace.getConfiguration('diffTracker');
        const setting = this.settings.flatMap(group => group.items).find(item => item.key === settingKey);
        const currentValue = config.get<boolean>(settingKey, setting?.defaultValue ?? true);
        const isWebviewDefault = settingKey === 'webviewWordWrap' || settingKey === 'webviewExpandUnchanged';
        const target = isWebviewDefault && config.inspect(settingKey)?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await config.update(settingKey, !currentValue, target);
        this.refresh();
    }

    public dispose(): void {
        this.configurationChangeDisposable.dispose();
        this._onDidChangeTreeData.dispose();
    }
}
