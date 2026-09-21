import * as vscode from 'vscode';
import { displayFileName, workspaceDisplayParts } from './utils/displayPath';
import { DiffTracker, FileDiff, OpaqueReviewToken, ReviewKind, ReviewToken, SubtreeCoverageDiagnostic } from './diffTracker';

interface DirNode {
    name: string;
    childrenDirs: Map<string, DirNode>;
    files: FileDiff[];
}

export class DiffTreeDataProvider implements vscode.TreeDataProvider<TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private diffTracker: DiffTracker) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): Thenable<TreeItem[]> {
        const items: TreeItem[] = [];

        // Root level - show files
        if (!element) {
            const changes = this.diffTracker.getTrackedChanges();
            const reviewTokens = this.diffTracker.getReviewTokens();
            const opaqueReviewTokens = this.diffTracker.getOpaqueReviewTokens();
            const subtreeCoverageGaps = this.diffTracker.getSubtreeCoverageGaps();
            items.push(this.createRecordingItem());
            if (subtreeCoverageGaps.length > 0) {
                items.push(this.createCoverageDiagnosticItem(subtreeCoverageGaps));
            }

            if (changes.length === 0) {
                const emptyItem = new TreeItem('No changes tracked', vscode.TreeItemCollapsibleState.None);
                emptyItem.description = this.diffTracker.getIsRecording() ? 'Make some edits...' : 'Start recording to track changes';
                return Promise.resolve([...items, emptyItem]);
            }

            const counts = this.countReviewKinds(changes);
            const summary = new TreeItem('Pending Review', vscode.TreeItemCollapsibleState.None);
            summary.iconPath = new vscode.ThemeIcon('list-tree');
            summary.description = `${counts.text} text · ${counts.opaque} read-only · ${counts.unknown} unknown`;
            summary.tooltip = `${changes.length} pending file(s): ${counts.text} text-reviewable, ${counts.opaque} read-only opaque, ${counts.unknown} unknown`;
            items.push(summary);

            if (reviewTokens.length > 0) {
                const revertButton = new TreeItem('Revert Text Changes', vscode.TreeItemCollapsibleState.None);
                revertButton.command = {
                    command: 'diffTracker.revertAllChanges',
                    title: 'Revert Text Changes',
                };
                revertButton.iconPath = new vscode.ThemeIcon('discard');
                revertButton.tooltip = `Restore ${reviewTokens.length} text-reviewable file(s); read-only and unknown entries remain pending`;
                revertButton.description = `${reviewTokens.length} text file(s)`;
                items.push(revertButton);

            }
            if (reviewTokens.length > 0 || opaqueReviewTokens.length > 0) {
                const keepButton = new TreeItem('Accept / Acknowledge Changes', vscode.TreeItemCollapsibleState.None);
                keepButton.command = {
                    command: 'diffTracker.keepAllChanges',
                    title: 'Accept / Acknowledge Changes'
                };
                keepButton.iconPath = new vscode.ThemeIcon('check');
                keepButton.tooltip = `Accept ${reviewTokens.length} text file(s), acknowledge ${opaqueReviewTokens.length} read-only file(s); unknown entries remain pending`;
                keepButton.description = `${reviewTokens.length} text · ${opaqueReviewTokens.length} read-only`;
                items.push(keepButton);
            }

            const rootNode: DirNode = {
                name: '',
                childrenDirs: new Map<string, DirNode>(),
                files: []
            };

            for (const change of changes) {
                const relativePath = this.toWorkspaceRelative(change.filePath);
                this.insertFileIntoTree(rootNode, relativePath, change);
            }

            items.push(...this.buildTreeItemsFromNode(rootNode, true));
        } else if (element.children) {
            return Promise.resolve(element.children);
        }

        return Promise.resolve(items);
    }

    private createCoverageDiagnosticItem(diagnostics: SubtreeCoverageDiagnostic[]): TreeItem {
        const item = new TreeItem('Monitoring Coverage Limited', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('warning');
        item.description = `${diagnostics.length} subtree(s)`;
        item.tooltip = 'Some monitored directories do not have complete observation coverage. Expand for details or open monitoring scope management.';

        item.children = diagnostics.map(diagnostic => {
            const relative = this.toWorkspaceRelative(diagnostic.targetPath).join('/');
            const child = new TreeItem(relative || displayFileName(diagnostic.targetPath), vscode.TreeItemCollapsibleState.None);
            child.iconPath = new vscode.ThemeIcon('warning');
            child.description = diagnostic.reasonCode;
            child.tooltip = `${diagnostic.targetPath}\n${diagnostic.reason}`;
            child.command = {
                command: 'diffTracker.manageMonitoringScope',
                title: 'Manage Monitoring Scope'
            };
            return child;
        });
        return item;
    }

    private createRecordingItem(): TreeItem {
        const state = this.diffTracker.getBaselineState();

        if (state === 'idle') {
            const item = new TreeItem('Start Recording', vscode.TreeItemCollapsibleState.None);
            item.command = {
                command: 'diffTracker.startRecording',
                title: 'Start Recording'
            };
            item.iconPath = new vscode.ThemeIcon('record');
            item.tooltip = 'Start tracking file changes';
            return item;
        }

        const item = new TreeItem('Recording', vscode.TreeItemCollapsibleState.None);
        item.command = {
            command: 'diffTracker.stopRecording',
            title: 'Stop Recording'
        };
        item.iconPath = state === 'building'
            ? new vscode.ThemeIcon('sync~spin')
            : new vscode.ThemeIcon('circle-filled');
        item.description = state === 'building' ? 'Starting...' : 'On';
        item.tooltip = state === 'building'
            ? 'Recording started. Baseline is initializing...'
            : 'Recording is active. Click to stop recording.';
        return item;
    }

    private createFileItem(fileDiff: FileDiff): TreeItem {
        const fileName = displayFileName(fileDiff.filePath);
        const displayName = fileDiff.isDeleted ? `${fileName} [Deleted]` : fileName;
        const item = new TreeItem(displayName, vscode.TreeItemCollapsibleState.None);
        const reviewKind = this.reviewKindOf(fileDiff);
        item.filePath = fileDiff.filePath;
        item.reviewToken = this.diffTracker.getReviewToken(fileDiff.filePath);
        item.opaqueReviewToken = this.diffTracker.getOpaqueReviewToken(fileDiff.filePath);
        item.isDeleted = fileDiff.isDeleted;
        item.resourceUri = vscode.Uri.file(fileDiff.filePath);
        item.tooltip = fileDiff.filePath;

        if (reviewKind === 'opaque') {
            const state = fileDiff.isDeleted ? 'Deleted' : fileDiff.baselineExists === false ? 'Added' : 'Changed';
            item.description = `Read-only · ${state}${fileDiff.currentSize !== undefined ? ` · ${this.formatBytes(fileDiff.currentSize)}` : ''}`;
            item.iconPath = new vscode.ThemeIcon('file-binary');
            item.contextValue = 'opaqueFile';
            item.tooltip += `\nRead-only file review\n${fileDiff.reviewReason ?? 'Content is not text-reviewable'}`;
            item.tooltip += this.identityTooltip(fileDiff);
            item.command = {
                command: 'diffTracker.showWebviewDiff',
                title: 'Inspect Read-only Change',
                arguments: [item]
            };
        } else if (reviewKind === 'unknown') {
            const reason = fileDiff.reviewReason ?? fileDiff.unavailableReason ?? 'Review evidence is incomplete';
            item.description = `Unknown · ${reason}`;
            item.iconPath = new vscode.ThemeIcon('warning');
            item.contextValue = 'unknownFile';
            item.tooltip += `\nReview status unknown\n${reason}`;
            item.command = {
                command: 'diffTracker.showWebviewDiff',
                title: 'Inspect Unknown Change',
                arguments: [item]
            };
        } else {
            item.description = fileDiff.sourceNote ? 'Source uncertain' : undefined;
            item.iconPath = vscode.ThemeIcon.File;
            item.contextValue = 'changedFile';
            item.tooltip += fileDiff.isDeleted ? '\nDeleted from disk' : '';
            if (fileDiff.sourceNote) { item.tooltip += `\n${fileDiff.sourceNote}`; }
            item.command = {
                command: 'diffTracker.openDiffDefault',
                title: 'Open Diff',
                arguments: [item]
            };
        }

        return item;
    }

    private reviewKindOf(fileDiff: FileDiff): ReviewKind {
        return fileDiff.reviewKind ?? (fileDiff.unavailableReason ? 'unknown' : 'text');
    }

    private countReviewKinds(changes: FileDiff[]): Record<ReviewKind, number> {
        const counts: Record<ReviewKind, number> = { text: 0, opaque: 0, unknown: 0 };
        for (const change of changes) { counts[this.reviewKindOf(change)]++; }
        return counts;
    }

    private formatBytes(value: number): string {
        if (value < 1024) { return `${value} B`; }
        if (value < 1024 * 1024) { return `${(value / 1024).toFixed(1)} KiB`; }
        return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }

    private identityTooltip(fileDiff: FileDiff): string {
        const lines: string[] = [];
        lines.push(`\nBaseline: ${fileDiff.baselineExists === false ? 'missing' : 'exists'}`);
        if (fileDiff.baselineSize !== undefined) { lines.push(` · ${this.formatBytes(fileDiff.baselineSize)}`); }
        if (fileDiff.baselineFingerprint) { lines.push(`\nBaseline SHA-256: ${fileDiff.baselineFingerprint}`); }
        lines.push(`\nCurrent: ${fileDiff.currentExists === false ? 'missing' : 'exists'}`);
        if (fileDiff.currentSize !== undefined) { lines.push(` · ${this.formatBytes(fileDiff.currentSize)}`); }
        if (fileDiff.currentFingerprint) { lines.push(`\nCurrent SHA-256: ${fileDiff.currentFingerprint}`); }
        return lines.join('');
    }

    private toWorkspaceRelative(filePath: string): string[] {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        return workspaceDisplayParts(
            filePath,
            workspaceFolder && { fsPath: workspaceFolder.uri.fsPath, name: workspaceFolder.name },
            (vscode.workspace.workspaceFolders?.length ?? 0) > 1
        );
    }

    private insertFileIntoTree(rootNode: DirNode, parts: string[], fileDiff: FileDiff): void {
        if (parts.length === 0) {
            rootNode.files.push(fileDiff);
            return;
        }

        let current = rootNode;
        for (let i = 0; i < parts.length - 1; i++) {
            const dirName = parts[i];
            let next = current.childrenDirs.get(dirName);
            if (!next) {
                next = {
                    name: dirName,
                    childrenDirs: new Map<string, DirNode>(),
                    files: []
                };
                current.childrenDirs.set(dirName, next);
            }
            current = next;
        }

        current.files.push(fileDiff);
    }

    private buildTreeItemsFromNode(node: DirNode, isRoot = false): TreeItem[] {
        const items: TreeItem[] = [];

        const sortedDirNames = [...node.childrenDirs.keys()].sort((a, b) => a.localeCompare(b));
        for (const dirName of sortedDirNames) {
            const childNode = node.childrenDirs.get(dirName);
            if (!childNode) {
                continue;
            }

            const dirItem = new TreeItem(childNode.name, vscode.TreeItemCollapsibleState.Expanded);
            dirItem.iconPath = new vscode.ThemeIcon('folder');
            dirItem.children = this.buildTreeItemsFromNode(childNode);
            dirItem.description = `${this.countFilesInNode(childNode)} file(s)`;
            items.push(dirItem);
        }

        const sortedFiles = [...node.files].sort((a, b) =>
            a.fileName.localeCompare(b.fileName) || a.filePath.localeCompare(b.filePath)
        );
        for (const file of sortedFiles) {
            items.push(this.createFileItem(file));
        }

        if (isRoot) {
            return items;
        }

        return items;
    }

    private countFilesInNode(node: DirNode): number {
        let count = node.files.length;
        for (const childNode of node.childrenDirs.values()) {
            count += this.countFilesInNode(childNode);
        }
        return count;
    }

    public dispose(): void {
        this._onDidChangeTreeData.dispose();
    }

}

class TreeItem extends vscode.TreeItem {
    public children?: TreeItem[];
    public filePath?: string;
    public isDeleted?: boolean;
    public reviewToken?: ReviewToken;
    public opaqueReviewToken?: OpaqueReviewToken;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}
