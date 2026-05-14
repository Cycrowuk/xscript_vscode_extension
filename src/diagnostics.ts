import * as vscode from 'vscode';
import { XDatabase } from './xmlParser';

// ── Diagnostics (basic error checking) ───────────────────────────────────────

export class XScriptDiagnosticsProvider {
    private collection: vscode.DiagnosticCollection;

    constructor(
        private db: XDatabase,
        context: vscode.ExtensionContext
    ) {
        this.collection = vscode.languages.createDiagnosticCollection('xscript');
        context.subscriptions.push(this.collection);
    }

    /** Run diagnostics on a document */
    update(document: vscode.TextDocument): void {
        if (document.languageId !== 'xscript') { return; }
        const diagnostics: vscode.Diagnostic[] = [];
        const text = document.getText();
        const lines = text.split('\n');

        // Pattern: funcName(arg, arg, ...) or $obj->funcName(arg, arg)
        const callRe = /(?:->)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^)]*)\)/g;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];

            // Skip comment lines
            if (/^\s*\/\//.test(line)) { continue; }
            // Strip inline comments
            const stripped = line.replace(/\/\/.*$/, '');

            let m: RegExpExecArray | null;
            const re = new RegExp(callRe.source, 'g');
            while ((m = re.exec(stripped)) !== null) {
                const funcName = m[1];
                const argsStr = m[2].trim();

                const fns = this.db.byName.get(funcName);
                if (!fns || fns.length === 0) { continue; }

                // Count arguments passed
                let passedCount = 0;
                if (argsStr !== '') {
                    // Count commas at depth 0
                    let depth = 0;
                    passedCount = 1;
                    for (const ch of argsStr) {
                        if (ch === '(' || ch === '[') { depth++; }
                        else if (ch === ')' || ch === ']') { depth--; }
                        else if (ch === ',' && depth === 0) { passedCount++; }
                    }
                }

                // Check against each candidate overload
                const fn = fns[0]; // use first match
                const expectedCount = fn.args.length;

                if (expectedCount > 0 && passedCount === 0 && argsStr === '') {
                    // Called with no args but needs args
                    const range = new vscode.Range(
                        lineIdx, m.index,
                        lineIdx, m.index + m[0].length
                    );
                    diagnostics.push(new vscode.Diagnostic(
                        range,
                        `'${funcName}' expects ${expectedCount} argument${expectedCount !== 1 ? 's' : ''}, but got 0.`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                } else if (argsStr !== '' && passedCount !== expectedCount) {
                    // Wrong argument count (only warn, don't error — XScript is loose)
                    const range = new vscode.Range(
                        lineIdx, m.index,
                        lineIdx, m.index + m[0].length
                    );
                    // Allow ±1 tolerance for optional trailing args
                    if (Math.abs(passedCount - expectedCount) > 1) {
                        diagnostics.push(new vscode.Diagnostic(
                            range,
                            `'${funcName}' expects ${expectedCount} argument${expectedCount !== 1 ? 's' : ''}, but got ${passedCount}.`,
                            vscode.DiagnosticSeverity.Hint
                        ));
                    }
                }
            }

            // Check for unknown variables ($ that haven't been declared in current scope)
            // This is a simple heuristic — just flag $0+ style unresolved references
            // Full scope analysis would require a proper AST
        }

        this.collection.set(document.uri, diagnostics);
    }

    clear(document: vscode.TextDocument): void {
        this.collection.delete(document.uri);
    }

    dispose(): void {
        this.collection.dispose();
    }
}
