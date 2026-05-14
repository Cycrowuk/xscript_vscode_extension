import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { parseXml, XDatabase }                    from './xmlParser';
import { parseBinaryDatabase }                    from './binaryParser';
import { XScriptCompiler, loadCompilerConfig }    from './compiler';
import { XScriptTaskProvider }                    from './taskProvider';
import {
    XScriptCompletionProvider,
    XScriptSignatureHelpProvider,
    XScriptHoverProvider,
} from './providers';
import { XScriptDiagnosticsProvider } from './diagnostics';

// ── Globals ────────────────────────────────────────────────────────────────────

let db: XDatabase | null = null;
let statusBarItem: vscode.StatusBarItem;
let compiler: XScriptCompiler | null = null;

// ── Database loader ────────────────────────────────────────────────────────────

interface ResolvedFile { filePath: string; isBinary: boolean; }

function resolveDataFile(context: vscode.ExtensionContext): ResolvedFile | null {
    const config = vscode.workspace.getConfiguration('xscript');

    // 1. Explicit settings take priority
    const datPath: string = config.get('dataPath') ?? '';
    if (datPath && fs.existsSync(datPath)) { return { filePath: datPath, isBinary: true }; }

    const xmlPath: string = config.get('xmlPath') ?? '';
    if (xmlPath && fs.existsSync(xmlPath)) { return { filePath: xmlPath, isBinary: false }; }

    // 2. Probe workspace folders — x3fl.dat, then default_data.dat, then x3fl.xml
    const DAT_NAMES  = ['x3fl.dat', 'default_data.dat'];
    const XML_NAMES  = ['x3fl.xml'];
    const folders    = vscode.workspace.workspaceFolders ?? [];

    for (const name of DAT_NAMES) {
        for (const folder of folders) {
            const p = path.join(folder.uri.fsPath, name);
            if (fs.existsSync(p)) { return { filePath: p, isBinary: true }; }
        }
    }
    for (const name of XML_NAMES) {
        for (const folder of folders) {
            const p = path.join(folder.uri.fsPath, name);
            if (fs.existsSync(p)) { return { filePath: p, isBinary: false }; }
        }
    }

    // 3. Bundled fallback inside the extension install directory
    for (const name of DAT_NAMES) {
        const p = path.join(context.extensionPath, name);
        if (fs.existsSync(p)) { return { filePath: p, isBinary: true }; }
    }
    for (const name of XML_NAMES) {
        const p = path.join(context.extensionPath, name);
        if (fs.existsSync(p)) { return { filePath: p, isBinary: false }; }
    }

    return null;
}

async function loadDatabase(context: vscode.ExtensionContext): Promise<XDatabase | null> {
    const resolved = resolveDataFile(context);
    if (!resolved) {
        vscode.window.showWarningMessage(
            'XScript: Could not find a definition file. ' +
            'Place x3fl.dat, default_data.dat, or x3fl.xml in your workspace root, ' +
            'or set "xscript.dataPath" / "xscript.xmlPath" in settings.'
        );
        return null;
    }

    const { filePath, isBinary } = resolved;
    const fileType = isBinary ? 'binary .dat' : 'XML';

    try {
        statusBarItem.text = '$(loading~spin) XScript: Loading…';
        statusBarItem.show();

        const loaded = isBinary ? parseBinaryDatabase(filePath) : parseXml(filePath);
        const fnCount = loaded.functions.size.toLocaleString();

        statusBarItem.text = `$(check) XScript: ${fnCount} functions loaded`;
        setTimeout(() => {
            statusBarItem.text    = '$(symbol-misc) XScript';
            statusBarItem.tooltip = `Loaded ${fnCount} functions from ${fileType}:\n${filePath}`;
        }, 3000);

        return loaded;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
            `XScript: Failed to parse ${fileType} (${path.basename(filePath)}) — ${msg}`
        );
        statusBarItem.text = '$(error) XScript: Parse error';
        return null;
    }
}

// ── Workspace root helper ──────────────────────────────────────────────────────

function workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

// ── Auto-create .vscode/tasks.json ────────────────────────────────────────────
//
// Ctrl+Shift+B (Run Build Task) requires a tasks.json entry to be the default
// build task. A TaskProvider alone only populates Terminal → Run Task.
// We write a minimal tasks.json on first activation if one doesn't exist.

function ensureTasksJson(root: string): void {
    if (!root) { return; }

    const vscodeDir  = path.join(root, '.vscode');
    const tasksFile  = path.join(vscodeDir, 'tasks.json');

    if (fs.existsSync(tasksFile)) { return; }  // already exists — don't touch it

    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    const tasksJson = {
        version: '2.0.0',
        tasks: [
            {
                type:   'xscript',
                action: 'compile',
                label:  'XScript: Compile Current File',
                group: { kind: 'build', isDefault: true },
                presentation: {
                    reveal:           'always',
                    panel:            'shared',
                    showReuseMessage: false,
                    clear:            true,
                },
            },
            {
                type:   'xscript',
                action: 'compileAll',
                label:  'XScript: Compile All Files',
                group:  'build',
                presentation: {
                    reveal: 'always',
                    panel:  'shared',
                    clear:  true,
                },
            },
        ],
    };

    try {
        fs.writeFileSync(tasksFile, JSON.stringify(tasksJson, null, 4));
        console.log('[XScript] Created .vscode/tasks.json');
    } catch (err) {
        // Non-fatal — user can create tasks.json manually
        console.warn('[XScript] Could not create .vscode/tasks.json:', err);
    }
}

// ── Activate ───────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    console.log('[XScript] Extension activating…');

    // Status bar — click to reload database
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'xscript.reloadDatabase';
    statusBarItem.text    = '$(loading~spin) XScript';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Load definition database
    db = await loadDatabase(context);
    if (!db) { return; }

    // Compiler instance
    compiler = new XScriptCompiler(context);

    // Task provider — makes XScript tasks appear in Terminal → Run Task
    const root = workspaceRoot();
    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(
            XScriptTaskProvider.type,
            new XScriptTaskProvider(root, compiler)
        )
    );

    // Auto-create .vscode/tasks.json if it doesn't exist.
    // Ctrl+Shift+B (Run Build Task) only picks up tasks defined in tasks.json —
    // a TaskProvider alone is not enough to become the default build task.
    ensureTasksJson(root);

    // ── Language providers ──────────────────────────────────────────────────

    const selector: vscode.DocumentSelector = [
        { language: 'xscript' },
        { language: 'javascript', pattern: '**/*.xs' },
    ];

    // Completion — trigger on '>' (second char of '->') only.
    // Do NOT trigger on '.' — that char appears inside $my.variable names.
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            selector,
            new XScriptCompletionProvider(db),
            '>'
        )
    );

    // Signature help
    context.subscriptions.push(
        vscode.languages.registerSignatureHelpProvider(
            selector,
            new XScriptSignatureHelpProvider(db),
            '(', ','
        )
    );

    // Hover
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(selector, new XScriptHoverProvider(db))
    );

    // Static diagnostics (arg-count checking)
    const staticDiag = new XScriptDiagnosticsProvider(db, context);
    const runStatic  = (doc: vscode.TextDocument) => {
        if (doc.languageId === 'xscript' ||
            (doc.languageId === 'javascript' && doc.fileName.endsWith('.xs'))) {
            staticDiag.update(doc);
        }
    };
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(runStatic),
        vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => runStatic(e.document)),
        vscode.workspace.onDidSaveTextDocument(runStatic),
        vscode.workspace.onDidCloseTextDocument((d: vscode.TextDocument) => staticDiag.clear(d))
    );
    for (const doc of vscode.workspace.textDocuments) { runStatic(doc); }

    // ── Compile-on-save ─────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc: vscode.TextDocument) => {
            if (!compiler) { return; }
            const isXScript = doc.languageId === 'xscript' ||
                              doc.fileName.endsWith('.xs') ||
                              doc.fileName.endsWith('.xscript');
            if (!isXScript) { return; }

            const cfg = loadCompilerConfig(workspaceRoot());
            if (cfg.onSave) {
                await compiler.compileFile(doc.fileName, cfg);
            }
        })
    );

    // ── Commands ────────────────────────────────────────────────────────────

    // Compile current file  (Ctrl+Shift+B default build)
    context.subscriptions.push(
        vscode.commands.registerCommand('xscript.compile', async () => {
            if (!compiler) { return; }
            await compiler.compileActive(loadCompilerConfig(workspaceRoot()));
        })
    );

    // Compile all .xs files in workspace
    context.subscriptions.push(
        vscode.commands.registerCommand('xscript.compileAll', async () => {
            if (!compiler) { return; }
            await compiler.compileAll(loadCompilerConfig(workspaceRoot()));
        })
    );

    // Reload definition database
    context.subscriptions.push(
        vscode.commands.registerCommand('xscript.reloadDatabase', async () => {
            db = await loadDatabase(context);
            if (db) {
                vscode.window.showInformationMessage(
                    `XScript: Reloaded — ${db.functions.size.toLocaleString()} functions.`
                );
            }
        })
    );

    // Show function stats
    context.subscriptions.push(
        vscode.commands.registerCommand('xscript.showFunctionCount', () => {
            if (!db) { vscode.window.showWarningMessage('XScript: Database not loaded.'); return; }
            vscode.window.showInformationMessage(
                `XScript: ${db.globalFunctions.length.toLocaleString()} global functions, ` +
                `${db.shipFunctions.length.toLocaleString()} ship, ` +
                `${db.stationFunctions.length.toLocaleString()} station, ` +
                `${db.sectorFunctions.length.toLocaleString()} sector, ` +
                `${db.properties.length.toLocaleString()} properties.`
            );
        })
    );

    // ── File watchers ───────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e: vscode.ConfigurationChangeEvent) => {
            if (e.affectsConfiguration('xscript.xmlPath') ||
                e.affectsConfiguration('xscript.dataPath')) {
                db = await loadDatabase(context);
            }
        })
    );

    const datWatcher = vscode.workspace.createFileSystemWatcher('**/x3fl.dat');
    const xmlWatcher = vscode.workspace.createFileSystemWatcher('**/x3fl.xml');
    const reload     = async () => {
        db = await loadDatabase(context);
        vscode.window.showInformationMessage('XScript: Definition file changed — reloaded.');
    };
    context.subscriptions.push(
        datWatcher, xmlWatcher,
        datWatcher.onDidChange(reload), datWatcher.onDidCreate(reload),
        xmlWatcher.onDidChange(reload),
    );

    console.log(`[XScript] Activated. ${db.functions.size} functions loaded.`);
}

// ── Deactivate ─────────────────────────────────────────────────────────────────

export function deactivate(): void {
    compiler?.dispose();
    console.log('[XScript] Deactivated.');
}
