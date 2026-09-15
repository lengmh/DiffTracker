import * as path from 'path';

export type PathStyle = 'win32' | 'posix';

// fsPath belongs to the host platform. Foreign path samples must opt into their
// own style; guessing from backslashes corrupts valid POSIX filenames.
const hostStyle: PathStyle = process.platform === 'win32' ? 'win32' : 'posix';

export function displayFileName(filePath: string, style: PathStyle = hostStyle): string {
    return path[style].basename(filePath) || filePath;
}

export function workspaceDisplayParts(
    filePath: string,
    workspace?: { fsPath: string; name: string },
    multiRoot = false,
    style: PathStyle = hostStyle
): string[] {
    if (!workspace) {
        return [displayFileName(filePath, style)];
    }
    const paths = path[style];
    const relative = paths.relative(workspace.fsPath, filePath);
    const parts = relative.split(paths.sep).filter(Boolean);
    // Workspace names are labels, not paths, even if they contain separators.
    return multiRoot ? [workspace.name, ...parts] : parts;
}
