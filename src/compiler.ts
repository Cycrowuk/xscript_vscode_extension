/**
 * compiler.ts
 *
 * Runs the XScript compiler executable and surfaces errors as VS Code diagnostics.
 *
 * Command format:
 *   XScriptCompiler.exe --load_data x3fl.dat compile "input.xs" --out "output.xml"
 *
 * The output file is placed in the same directory as the input by default,
 * or in xscript.compiler.outputDir if set.
 */

import * as vscode from 'vscode';
import * as path   from 'path';
import * as cp     from 'child_process';
import * as fs     from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

export interface CompilerConfig {
    /** Full path to XScriptCompiler.exe */
    exePath:      string;
    /** Path to x3fl.dat passed via --load_data (empty = omit the flag) */
    dataFile:     string;
    /** Directory for compiled .xml output files (empty = same dir as .xs) */
    outputDir:    string;
    /** Working directory for the process */
    cwd:          string;
    /** Compile automatically on save */
    onSave:       boolean;
    /** Optional custom error-line regex */
    errorPattern: string;
}

// Candidate exe names to probe when exePath is not configured
const EXE_NAMES = [
    'XScriptCompiler.exe',
    'XScriptCompiler',
    'xscriptcompiler.exe',
    'xscriptcompiler',
];

/** Find the compiler exe by probing the workspace root and PATH directories.
 *  Returns the found path, or empty string if not found. */
function findCompilerExe(workspaceRoot: string): string {
    // 1. Workspace root
    for (const name of EXE_NAMES) {
        const p = path.join(workspaceRoot, name);
        if (fs.existsSync(p)) { return p; }
    }

    // 2. Each directory on PATH
    const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        for (const name of EXE_NAMES) {
            const p = path.join(dir, name);
            if (fs.existsSync(p)) { return p; }
        }
    }

    // 3. Just the bare name — let the OS resolve it (works if it's on PATH)
    //    We return the bare name so cp.spawn can find it via PATH at runtime.
    return 'XScriptCompiler.exe';
}

/** Find the data file by probing common locations.
 *  Priority: x3fl.dat → default_data.dat (same order as the database loader). */
function findDataFile(workspaceRoot: string, exePath: string): string {
    const names = ['x3fl.dat', 'default_data.dat'];
    const dirs  = [
        workspaceRoot,
        path.dirname(exePath),
        path.join(workspaceRoot, '..'),
    ];

    for (const name of names) {
        for (const dir of dirs) {
            try {
                const p = path.resolve(dir, name);
                if (fs.existsSync(p)) { return p; }
            } catch { /* skip unreadable paths */ }
        }
    }

    return ''; // not found — --load_data will be omitted
}

/**
 * Load compiler configuration from VS Code settings, filling in sensible
 * defaults for any values that are not explicitly set:
 *
 *   exePath   → probe workspace root and PATH for XScriptCompiler.exe
 *   dataFile  → probe next to the exe, workspace root, and parent directory
 *   outputDir → same directory as the .xs source file
 *   cwd       → workspace root
 *
 * Never returns null — always returns a config so tasks.json entries resolve.
 */
export function loadCompilerConfig(workspaceRoot: string): CompilerConfig {
    const cfg = vscode.workspace.getConfiguration('xscript.compiler');

    // exe — explicit setting, else auto-detect
    let exePath: string = cfg.get('exePath') ?? '';
    if (!exePath) {
        exePath = findCompilerExe(workspaceRoot);
    }

    // data file — explicit setting, else auto-detect relative to exe / workspace
    let dataFile: string = cfg.get('dataFile') ?? '';
    if (!dataFile) {
        dataFile = findDataFile(workspaceRoot, exePath);
    }

    return {
        exePath,
        dataFile,
        outputDir:    cfg.get<string>('outputDir')      ?? '',
        cwd:          cfg.get<string>('cwd')             || workspaceRoot,
        onSave:       cfg.get<boolean>('compileOnSave')  ?? false,
        errorPattern: cfg.get<string>('errorPattern')    ?? '',
    };
}

// ── Argument builder ──────────────────────────────────────────────────────────

/**
 * Build the full argument list for one file in the exact required order:
 *   --load_data <dat>  --compile <input.xs>  --out <output.xml>
 */
function buildArgs(inputFile: string, config: CompilerConfig): string[] {
    const args: string[] = [];

    // --load_data must come first, before the compile subcommand
    if (config.dataFile) {
        args.push('--load_data', config.dataFile);
    }

    // --compile <input.xs>  — filename immediately follows the flag
    args.push('--compile', inputFile);

    // --out <output.xml>
    args.push('--out', resolveOutputFile(inputFile, config));

    return args;
}

/** Derive the output .xml path for a given .xs input file. */
function resolveOutputFile(inputFile: string, config: CompilerConfig): string {
    const baseName = path.basename(inputFile, path.extname(inputFile)) + '.xml';
    if (config.outputDir) {
        return path.join(config.outputDir, baseName);
    }
    return path.join(path.dirname(inputFile), baseName);
}

// ── Error line parser ─────────────────────────────────────────────────────────
//
// The XScript compiler outputs errors and warnings in this exact format:
//
//   Compile Error [#N]:   [file:line:col]  - message
//   	<source line>
//   	   ^
//
//   Compile Warning [#N]:   [file:line:col]  - message
//   	<source line>
//   	   ^
//
// Each diagnostic is three lines:
//   Line 1 — the parseable error/warning line
//   Line 2 — the source text (prefixed with a tab)  → skip
//   Line 3 — the caret indicator (tab + spaces + ^) → skip

interface ParsedError {
    file:     string;
    line:     number;  // 1-based
    col:      number;  // 1-based
    severity: vscode.DiagnosticSeverity;
    message:  string;
    code:     number;  // the [#N] error/warning code
}

// Primary pattern — matches the XScriptCompiler output exactly:
//   Compile Error [#N]:   [file:line:col]  - message
//   Compile Warning [#N]: [file:line:col]  - message
//
// The location block is right-padded with spaces to setw(12) so there may be
// leading spaces before the '['.  We allow for that with \s*.
const XSCRIPT_PATTERN = /^Compile\s+(Error|Warning)\s+\[#(\d+)\]:\s*\[([^\]]+):(\d+):(\d+)\]\s*-\s*(.+)$/;

// Fallback patterns for any other format (kept for robustness)
const FALLBACK_PATTERNS: RegExp[] = [
    /^(?<file>[^\s:][^:]*):(?<line>\d+):(?<col>\d+):\s*(?<severity>error|warning|note|info):\s*(?<message>.+)$/i,
    /^(?<file>[^\s:][^:]*):(?<line>\d+):\s*(?<severity>error|warning|note|info):\s*(?<message>.+)$/i,
    /^(?<file>[^\s(]+)\((?<line>\d+)\):\s*(?<severity>error|warning|note|info)[^:]*:\s*(?<message>.+)$/i,
];

function buildFallbackRegexList(customPattern: string): RegExp[] {
    const extras = customPattern
        ? [new RegExp(customPattern, 'i')]
        : [];
    return [...extras, ...FALLBACK_PATTERNS];
}

function parseSeverity(s: string): vscode.DiagnosticSeverity {
    const lc = s.toLowerCase();
    if (lc === 'warning')               { return vscode.DiagnosticSeverity.Warning; }
    if (lc === 'note' || lc === 'info') { return vscode.DiagnosticSeverity.Information; }
    return vscode.DiagnosticSeverity.Error;
}

function parseCompilerOutput(
    output: string,
    customPattern: string,
    cwd: string
): Map<vscode.Uri, vscode.Diagnostic[]> {

    const fallbackRegexes = buildFallbackRegexList(customPattern);
    const byFile          = new Map<string, vscode.Diagnostic[]>();

    const lines = output.split('\n');
    let i = 0;

    while (i < lines.length) {
        const rawLine = lines[i].trimEnd();
        i++;

        if (!rawLine) { continue; }

        let parsed: ParsedError | null = null;

        // ── Try the primary XScript pattern first ─────────────────────────────
        const m = XSCRIPT_PATTERN.exec(rawLine);
        if (m) {
            const [, severityStr, codeStr, filePart, lineStr, colStr, message] = m;

            // The file part may have leading spaces from setw(12) padding — trim it
            let resolvedFile = filePart.trim();
            if (!path.isAbsolute(resolvedFile)) {
                resolvedFile = path.resolve(cwd, resolvedFile);
            }

            parsed = {
                file:     resolvedFile,
                line:     parseInt(lineStr, 10),
                col:      parseInt(colStr, 10),
                severity: parseSeverity(severityStr),
                message:  message.trim(),
                code:     parseInt(codeStr, 10),
            };

            // Skip the next two lines (source text + caret indicator)
            // They start with a tab character
            if (i < lines.length && lines[i].startsWith('\t')) { i++; }
            if (i < lines.length && lines[i].startsWith('\t')) { i++; }
        }

        // ── Fallback to generic patterns ──────────────────────────────────────
        if (!parsed) {
            for (const re of fallbackRegexes) {
                const fm = re.exec(rawLine);
                if (!fm?.groups) { continue; }
                const { file, line: ls, col: cs, severity, message } = fm.groups;
                if (!file || !ls) { continue; }
                let resolvedFile = file.trim();
                if (!path.isAbsolute(resolvedFile)) {
                    resolvedFile = path.resolve(cwd, resolvedFile);
                }
                parsed = {
                    file:     resolvedFile,
                    line:     parseInt(ls, 10),
                    col:      cs ? parseInt(cs, 10) : 1,
                    severity: severity ? parseSeverity(severity) : vscode.DiagnosticSeverity.Error,
                    message:  (message ?? rawLine).trim(),
                    code:     0,
                };
                break;
            }
        }

        if (!parsed) { continue; }

        // Build VS Code diagnostic (convert 1-based to 0-based)
        const vsLine = Math.max(0, parsed.line - 1);
        const vsCol  = Math.max(0, parsed.col  - 1);
        const range  = new vscode.Range(vsLine, vsCol, vsLine, vsCol + 120);
        const diag   = new vscode.Diagnostic(range, parsed.message, parsed.severity);
        diag.source  = 'xscript';
        if (parsed.code > 0) {
            diag.code = parsed.code;
        }

        if (!byFile.has(parsed.file)) { byFile.set(parsed.file, []); }
        byFile.get(parsed.file)!.push(diag);
    }

    const result = new Map<vscode.Uri, vscode.Diagnostic[]>();
    for (const [filePath, diags] of byFile) {
        result.set(vscode.Uri.file(filePath), diags);
    }
    return result;
}

// ── Compiler runner ───────────────────────────────────────────────────────────

export class XScriptCompiler {
    private collection:    vscode.DiagnosticCollection;
    private outputChannel: vscode.OutputChannel;

    constructor(context: vscode.ExtensionContext) {
        this.collection    = vscode.languages.createDiagnosticCollection('xscript-compiler');
        this.outputChannel = vscode.window.createOutputChannel('XScript Compiler');
        context.subscriptions.push(this.collection, this.outputChannel);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Compile the file currently open in the editor.
     *  onLine callback receives each output line (used by the task pseudoterminal).
     *  Returns true if compilation succeeded. */
    async compileActive(
        config: CompilerConfig,
        onLine?: (line: string) => void
    ): Promise<boolean> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            const msg = 'XScript: No active file to compile.';
            onLine ? onLine(msg) : vscode.window.showWarningMessage(msg);
            return false;
        }
        const doc = editor.document;
        if (!doc.fileName.match(/\.xs(cript)?$/i)) {
            const msg = `XScript: "${path.basename(doc.fileName)}" is not an XScript file.`;
            onLine ? onLine(msg) : vscode.window.showWarningMessage(msg);
            return false;
        }
        if (doc.isDirty) { await doc.save(); }
        return this._runCompiler(doc.fileName, config, onLine);
    }

    /** Compile all .xs files in the workspace.
     *  onLine callback receives each output line (used by the task pseudoterminal). */
    async compileAllWithOutput(
        config: CompilerConfig,
        onLine?: (line: string) => void
    ): Promise<boolean> {
        const files = await vscode.workspace.findFiles('**/*.xs', '**/node_modules/**');
        if (files.length === 0) {
            const msg = 'XScript: No .xs files found in workspace.';
            onLine ? onLine(msg) : vscode.window.showInformationMessage(msg);
            return true;
        }
        this.collection.clear();
        let allOk = true;
        for (const fileUri of files) {
            const ok = await this._runCompiler(fileUri.fsPath, config, onLine);
            if (!ok) { allOk = false; }
        }
        return allOk;
    }

    /** Compile all .xs files — used by the command palette (no line callback). */
    async compileAll(config: CompilerConfig): Promise<void> {
        const files = await vscode.workspace.findFiles('**/*.xs', '**/node_modules/**');
        if (files.length === 0) {
            vscode.window.showInformationMessage('XScript: No .xs files found in workspace.');
            return;
        }
        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.collection.clear();

        let errors = 0, warnings = 0;
        for (const fileUri of files) {
            await this._runCompiler(fileUri.fsPath, config);
            this.collection.forEach((_uri: vscode.Uri, diags: readonly vscode.Diagnostic[]) => {
                errors   += diags.filter((d: vscode.Diagnostic) => d.severity === vscode.DiagnosticSeverity.Error).length;
                warnings += diags.filter((d: vscode.Diagnostic) => d.severity === vscode.DiagnosticSeverity.Warning).length;
            });
        }

        const n = files.length;
        vscode.window.showInformationMessage(
            `XScript: Compiled ${n} file${n !== 1 ? 's' : ''} — ` +
            `${errors} error${errors !== 1 ? 's' : ''}, ` +
            `${warnings} warning${warnings !== 1 ? 's' : ''}.`
        );
    }

    /** Compile a single file — used by on-save and command palette. */
    async compileFile(filePath: string, config: CompilerConfig): Promise<boolean> {
        this.collection.clear();
        return this._runCompiler(filePath, config);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private async _runCompiler(
        inputFile: string,
        config: CompilerConfig,
        onLine?: (line: string) => void
    ): Promise<boolean> {
        const args      = buildArgs(inputFile, config);
        const outputXml = resolveOutputFile(inputFile, config);

        // Clear existing diagnostics for this file before starting a new compile
        // so stale errors disappear even if the new run produces no output yet
        this.collection.delete(vscode.Uri.file(inputFile));

        // Ensure output directory exists
        const outDir = path.dirname(outputXml);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Show what we're running
        const header = [
            '─'.repeat(72),
            `Compiling: ${path.basename(inputFile)}`,
            `Exe:       ${config.exePath}`,
            `Data:      ${config.dataFile || '(none — --load_data omitted)'}`,
            `Command:   ${config.exePath} ${args.join(' ')}`,
            `Output:    ${outputXml}`,
            '',
        ];
        for (const line of header) {
            this.outputChannel.appendLine(line);
            onLine?.(line);
        }

        // Status bar spinner
        const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
        bar.text    = `$(loading~spin) Compiling ${path.basename(inputFile)}…`;
        bar.tooltip = inputFile;
        bar.show();

        return new Promise(resolve => {
            let output = '';

            // shell: false — pass args directly to the exe without going through
            // cmd.exe. When shell:true on Windows, the args get joined into a
            // quoted string that cmd.exe misparsed, causing "missing command type".
            const proc = cp.spawn(config.exePath, args, {
                cwd:   config.cwd,
                shell: false,
            });

            const onData = (d: Buffer) => {
                const chunk = d.toString();
                output += chunk;
                this.outputChannel.append(chunk);
                // Forward each line to the pseudoterminal
                if (onLine) {
                    for (const line of chunk.split('\n')) {
                        if (line) { onLine(line); }
                    }
                }
            };

            proc.stdout?.on('data', onData);
            proc.stderr?.on('data', onData);

            proc.on('error', (err: Error) => {
                bar.dispose();
                const msg = `Failed to start compiler "${config.exePath}": ${err.message}`;
                this.outputChannel.appendLine('');
                this.outputChannel.appendLine(msg);
                onLine?.(msg);
                const hint = fs.existsSync(config.exePath)
                    ? `Check that "${config.exePath}" is executable.`
                    : `"${config.exePath}" was not found. ` +
                      `Place XScriptCompiler.exe in your workspace folder or set ` +
                      `"xscript.compiler.exePath" in Settings.`;
                vscode.window.showErrorMessage(`XScript: ${hint}`, 'Open Settings')
                    .then((choice: string | undefined) => {
                        if (choice === 'Open Settings') {
                            vscode.commands.executeCommand(
                                'workbench.action.openSettings', 'xscript.compiler.exePath'
                            );
                        }
                    });
                resolve(false);
            });

            proc.on('close', (exitCode: number | null) => {
                bar.dispose();
                this.outputChannel.appendLine('');
                this.outputChannel.appendLine(
                    exitCode === 0
                        ? `✓ Compiled successfully → ${outputXml}`
                        : `✗ Compiler exited with code ${exitCode}`
                );

                // Parse output and build diagnostics
                const diagMap = parseCompilerOutput(output, config.errorPattern, config.cwd);

                let errorCount   = 0;
                let warningCount = 0;

                for (const [uri, diags] of diagMap) {
                    this.collection.set(uri, diags);
                    errorCount   += diags.filter((d: vscode.Diagnostic) => d.severity === vscode.DiagnosticSeverity.Error).length;
                    warningCount += diags.filter((d: vscode.Diagnostic) => d.severity === vscode.DiagnosticSeverity.Warning).length;
                }

                // If compilation succeeded and no diagnostics were produced for this
                // specific file, clear any stale diagnostics from a previous run.
                // Compare by file path string (not Uri object reference, which would
                // never match since each vscode.Uri.file() creates a new object).
                const inputFileNorm = vscode.Uri.file(inputFile).toString();
                const diagMapHasInputFile = [...diagMap.keys()]
                    .some(u => u.toString() === inputFileNorm);

                if (exitCode === 0 && !diagMapHasInputFile) {
                    this.collection.delete(vscode.Uri.file(inputFile));
                }

                // If the compiler failed but we couldn't parse any errors, add a
                // fallback diagnostic on the input file itself
                if (exitCode !== 0 && diagMap.size === 0) {
                    const diag = new vscode.Diagnostic(
                        new vscode.Range(0, 0, 0, 0),
                        `Compiler failed (exit code ${exitCode}). See XScript Compiler output panel for details.`,
                        vscode.DiagnosticSeverity.Error
                    );
                    diag.source = 'xscript';
                    this.collection.set(vscode.Uri.file(inputFile), [diag]);
                    errorCount = 1;
                }

                // Status bar summary
                if (errorCount === 0 && warningCount === 0) {
                    vscode.window.setStatusBarMessage(`$(check) XScript: Compiled OK`, 5000);
                } else {
                    const parts: string[] = [];
                    if (errorCount)   { parts.push(`${errorCount} error${errorCount   !== 1 ? 's' : ''}`); }
                    if (warningCount) { parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`); }
                    vscode.window.setStatusBarMessage(`$(error) XScript: ${parts.join(', ')}`, 8000);
                }

                resolve(exitCode === 0);
            });
        });
    }

    dispose(): void {
        this.collection.dispose();
        this.outputChannel.dispose();
    }
}
