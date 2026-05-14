/**
 * taskProvider.ts
 *
 * Provides XScript build tasks to VS Code's task system.
 *
 * KEY DESIGN:
 * - resolveTask() MUST always return a Task (not undefined) for any xscript
 *   task definition found in tasks.json — returning undefined causes VS Code
 *   to log "didn't contribute a task" and ignore the entry entirely.
 * - We use CustomExecution so the task runs our TypeScript code directly,
 *   which means we can call compiler.compileActive() and get proper output
 *   in our dedicated channel, rather than spawning a shell process that
 *   doesn't know which file is currently active.
 */

import * as vscode from 'vscode';
import { XScriptCompiler, loadCompilerConfig } from './compiler';

export const TASK_TYPE = 'xscript';

interface XScriptTaskDefinition extends vscode.TaskDefinition {
    type:    'xscript';
    action:  'compile' | 'compileAll';
    file?:   string;
}

function makeCustomExecution(
    action: 'compile' | 'compileAll',
    workspaceRoot: string,
    compiler: XScriptCompiler
): vscode.CustomExecution {
    return new vscode.CustomExecution(async (): Promise<vscode.Pseudoterminal> => {
        return new XScriptPseudoterminal(action, workspaceRoot, compiler);
    });
}

// ── Pseudoterminal — bridges VS Code task output with our compiler ─────────────

class XScriptPseudoterminal implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    private closeEmitter = new vscode.EventEmitter<number>();

    onDidWrite  = this.writeEmitter.event;
    onDidClose  = this.closeEmitter.event;

    constructor(
        private action: 'compile' | 'compileAll',
        private workspaceRoot: string,
        private compiler: XScriptCompiler
    ) {}

    open(): void {
        this.run().catch(err => {
            this.writeLine(`Error: ${err}`);
            this.closeEmitter.fire(1);
        });
    }

    close(): void {}

    private writeLine(text: string): void {
        this.writeEmitter.fire(text.replace(/\n/g, '\r\n') + '\r\n');
    }

    private async run(): Promise<void> {
        const config = loadCompilerConfig(this.workspaceRoot);

        let success = false;
        if (this.action === 'compile') {
            success = await this.compiler.compileActive(config, (line) => {
                this.writeLine(line);
            });
        } else {
            success = await this.compiler.compileAllWithOutput(config, (line) => {
                this.writeLine(line);
            });
        }

        this.closeEmitter.fire(success ? 0 : 1);
    }
}

// ── Task provider ─────────────────────────────────────────────────────────────

export class XScriptTaskProvider implements vscode.TaskProvider {
    static readonly type = TASK_TYPE;

    constructor(
        private workspaceRoot: string,
        private compiler: XScriptCompiler
    ) {}

    provideTasks(): vscode.Task[] {
        return [
            this.makeTask({ type: TASK_TYPE, action: 'compile' },
                'Compile Current File', true),
            this.makeTask({ type: TASK_TYPE, action: 'compileAll' },
                'Compile All Files', false),
        ];
    }

    // resolveTask is called for every xscript entry found in tasks.json.
    // It MUST return a Task — never undefined — otherwise VS Code ignores the entry.
    resolveTask(task: vscode.Task): vscode.Task {
        const def = task.definition as XScriptTaskDefinition;
        return this.makeTask(def, task.name, def.action === 'compile');
    }

    private makeTask(
        def: XScriptTaskDefinition,
        label: string,
        isDefaultBuild: boolean
    ): vscode.Task {
        const t = new vscode.Task(
            def,
            vscode.TaskScope.Workspace,
            label,
            'XScript',
            makeCustomExecution(def.action, this.workspaceRoot, this.compiler),
            '$xscript'
        );
        t.group = isDefaultBuild
            ? vscode.TaskGroup.Build
            : vscode.TaskGroup.Build;
        t.presentationOptions = {
            reveal:           vscode.TaskRevealKind.Always,
            panel:            vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear:            true,
        };
        return t;
    }
}
