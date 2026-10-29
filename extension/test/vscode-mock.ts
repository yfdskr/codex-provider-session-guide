export const commandsMap = new Map<string, (...args: any[]) => unknown>();
export const builtinCommands: string[] = [];
export const views = new Map<string, any>();
export const panels: any[] = [];
export const messages: string[] = [];
export const inputs: (string | undefined)[] = [];
export const picks: (string | undefined)[] = [];
export const confirmations: (string | undefined)[] = [];
export const settingsMap = new Map<string, unknown>();
export const workspace = { isTrusted: true, getConfiguration: () => ({ get: (key: string) => settingsMap.get(key) }), openTextDocument: async (value: any) => value };
export const commands = {
  getCommands: async () => ['workbench.action.closeWindow', 'workbench.action.reloadWindow', ...commandsMap.keys()],
  registerCommand: (id: string, fn: (...args: any[]) => unknown) => { commandsMap.set(id, fn); return { dispose: () => commandsMap.delete(id) }; },
  executeCommand: async (id: string, ...args: any[]) => { if (['workbench.action.closeWindow','workbench.action.reloadWindow'].includes(id)) builtinCommands.push(id); return commandsMap.get(id)?.(...args); }
};
export class TreeItem { constructor(public label: string, public collapsibleState: number) {} }
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class EventEmitter { event = () => undefined; fire() {} dispose() {} }
export class ThemeIcon { constructor(public id: string) {} }
export const StatusBarAlignment = { Left: 1 };
export const ProgressLocation = { Notification: 15 };
export const ViewColumn = { One: 1 };
export const Uri = { parse: (s: string) => s, file: (file: string) => ({ fsPath: file }) };
export const env = { openExternal: async (_uri: any) => true, remoteName: 'ssh-remote', clipboard: { writeText: async (_text: string) => undefined } };
export const extensionMap = new Map<string, any>();
export const extensions = { getExtension: (id: string) => extensionMap.get(id) };
export const window = {
  createWebviewPanel: (_id: string, _title: string, _column: any, options: any) => {
    const panel: any = { options, reveal() {}, dispose() { panel.disposed?.(); }, onDidDispose(fn: any) { panel.disposed = fn; }, webview: { html: '', cspSource: 'mock-resource:', messages: [] as any[], asWebviewUri: (uri: any) => ({ toString: () => 'mock-resource:' + uri.fsPath }), postMessage: async (m: any) => { panel.webview.messages.push(m); }, onDidReceiveMessage(fn: any) { panel.receive = fn; } } };
    panels.push(panel); return panel;
  },
  createOutputChannel: () => ({ appendLine: (s: string) => messages.push(s), show() {}, dispose() {} }),
  createStatusBarItem: () => ({ show() {}, dispose() {} }),
  createTreeView: (id: string, options: any) => { views.set(id, options.treeDataProvider); return { dispose: () => views.delete(id) }; },
  showWarningMessage: async (s: string) => { messages.push(s); return confirmations.shift(); },
  showInformationMessage: async (s: string) => { messages.push(s); return confirmations.shift(); },
  showErrorMessage: async (s: string) => { messages.push(s); return undefined; },
  showInputBox: async () => inputs.shift(),
  showQuickPick: async () => picks.shift(),
  showTextDocument: async () => undefined,
  withProgress: async (_options: any, fn: () => unknown) => fn()
};
