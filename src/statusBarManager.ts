import * as vscode from 'vscode';
import { DiffTracker } from './diffTracker';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private baselineReadyTimer: NodeJS.Timeout | undefined;

    constructor(private diffTracker: DiffTracker) {
        // Create status bar item on the right side
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );

        this.statusBarItem.command = 'diffTracker.toggleRecording';
        this.statusBarItem.tooltip = 'Toggle Diff Recording';

        // Listen to recording state changes
        this.diffTracker.onDidChangeRecordingState(isRecording => {
            this.updateStatusBar(isRecording);
        });

        this.diffTracker.onDidChangeBaselineState(state => {
            this.updateBaselineStatus(state);
        });

        this.diffTracker.onDidTrackChanges(() => {
            if (this.diffTracker.getBaselineState() !== 'building') {
                this.updateStatusBar(this.diffTracker.getIsRecording());
            }
        });

        // Initialize
        this.updateStatusBar(this.diffTracker.getIsRecording());
        this.statusBarItem.show();
    }

    private updateBaselineStatus(state: 'idle' | 'building' | 'ready') {
        if (this.baselineReadyTimer) {
            clearTimeout(this.baselineReadyTimer);
            this.baselineReadyTimer = undefined;
        }

        if (state === 'building') {
            this.statusBarItem.text = '$(sync~spin) Building baseline…';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            return;
        }

        if (state === 'ready') {
            if (this.diffTracker.getSubtreeCoverageGaps().length > 0) {
                this.updateStatusBar(this.diffTracker.getIsRecording());
                return;
            }
            this.statusBarItem.text = '$(check) Baseline ready';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.baselineReadyTimer = setTimeout(() => {
                this.baselineReadyTimer = undefined;
                this.updateStatusBar(this.diffTracker.getIsRecording());
            }, 3000);
            return;
        }

        this.updateStatusBar(this.diffTracker.getIsRecording());
    }

    private updateStatusBar(isRecording: boolean) {
        const subtreeGaps = this.diffTracker.getSubtreeCoverageGaps();
        if (subtreeGaps.length > 0) {
            this.statusBarItem.text = '$(warning) Coverage Limited';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            this.statusBarItem.command = 'diffTracker.manageMonitoringScope';
            this.statusBarItem.tooltip =
                `Monitoring coverage is limited for ${subtreeGaps.length} subtree(s). Click to review diagnostics and recovery options.`;
            return;
        }

        this.statusBarItem.command = 'diffTracker.toggleRecording';
        this.statusBarItem.tooltip = 'Toggle Diff Recording';
        if (isRecording) {
            this.statusBarItem.text = '$(circle-filled) Recording';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            this.statusBarItem.text = '$(circle-outline) Not Recording';
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    public dispose() {
        if (this.baselineReadyTimer) {
            clearTimeout(this.baselineReadyTimer);
            this.baselineReadyTimer = undefined;
        }
        this.statusBarItem.dispose();
    }
}
