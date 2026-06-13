import * as vscode from 'vscode';
import { XDatabase, XFunction, XProperty } from './xmlParser';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fnLabel(fn: XFunction): string {
    const args = fn.args.map(a => `${a.paramName}: ${a.tsType}`).join(', ');
    return `${fn.name}(${args}): ${fn.returnTs}`;
}

function fnDetail(fn: XFunction): string {
    const scope = fn.scope === 'global' ? 'global function' : `${fn.scope} method`;
    return `[${scope}]  → ${fn.returnTs}`;
}

function fnDocumentation(fn: XFunction): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**${fn.name}**\n\n${fn.description}`);
    if (fn.args.length > 0) {
        md.appendMarkdown('\n\n**Parameters:**\n');
        for (const a of fn.args) {
            md.appendMarkdown(`\n- \`${a.paramName}: ${a.tsType}\` — ${a.description}`);
        }
    }
    if (fn.returnTs !== 'void') {
        md.appendMarkdown(`\n\n**Returns:** \`${fn.returnTs}\``);
    }
    if (fn.example) {
        md.appendMarkdown('\n\n**Example:**\n```xscript\n' + fn.example + '\n```');
    }
    return md;
}

function propDocumentation(p: XProperty): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**${p.name}**\n\n${p.description}`);
    md.appendMarkdown(`\n\nType: \`${p.tsType}\``);
    if (p.readonly) { md.appendMarkdown('\n\n_Read-only_'); }
    return md;
}

function makeMethodItem(fn: XFunction): vscode.CompletionItem {
    const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Method);
    item.detail = fnDetail(fn);
    item.documentation = fnDocumentation(fn);
    item.filterText = fn.name;
    item.sortText = '1' + fn.name.toLowerCase();
    if (fn.args.length === 0) {
        item.insertText = new vscode.SnippetString(`${fn.name}()`);
    } else {
        const snippetArgs = fn.args
            .map((a, i) => `\${${i + 1}:${a.paramName}}`)
            .join(', ');
        item.insertText = new vscode.SnippetString(`${fn.name}(${snippetArgs})`);
    }
    return item;
}

function makeGlobalFnItem(fn: XFunction): vscode.CompletionItem {
    const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
    item.detail = fnDetail(fn);
    item.documentation = fnDocumentation(fn);
    item.filterText = fn.name;
    item.sortText = '2' + fn.name.toLowerCase();
    if (fn.args.length === 0) {
        item.insertText = new vscode.SnippetString(`${fn.name}()`);
    } else {
        const snippetArgs = fn.args
            .map((a, i) => `\${${i + 1}:${a.paramName}}`)
            .join(', ');
        item.insertText = new vscode.SnippetString(`${fn.name}(${snippetArgs})`);
    }
    return item;
}

function makePropItem(p: XProperty): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
        p.name,
        p.readonly ? vscode.CompletionItemKind.Constant : vscode.CompletionItemKind.Property
    );
    item.detail = `${p.readonly ? 'readonly ' : ''}${p.tsType}`;
    item.documentation = propDocumentation(p);
    item.insertText = p.name;
    item.filterText = p.name;
    item.sortText = '0' + p.name.toLowerCase();
    return item;
}

// ── Context detection ─────────────────────────────────────────────────────────

function linePrefix(document: vscode.TextDocument, position: vscode.Position): string {
    return document.lineAt(position).text.slice(0, position.character);
}

/**
 * Returns the namespace name if the cursor is after 'NamespaceName::' ready to
 * complete a namespace function. e.g. 'Utils::ran|' → returns 'Utils'
 */
function detectNamespace(prefix: string): string | null {
    const m = /\b([A-Za-z_][A-Za-z0-9_]*)::[ \t]*[a-zA-Z_]*$/.exec(prefix);
    return m ? m[1] : null;
}

/**
 * Returns true when the cursor is at a bare identifier position where a
 * namespace name could be typed — i.e. not after -> or inside a string.
 */
function couldBeNamespace(prefix: string): boolean {
    return /(?:^|[\s=,(+\-*\/])[ \t]*[A-Za-z_][A-Za-z0-9_]*$/.test(prefix);
}

/**
 * Returns true when the cursor is sitting after '->' ready to complete a
 * method or property name.  Matches:
 *   $ship->|         $ship->get|       $my.ship->get|
 */
function isMethodContext(prefix: string): boolean {
    return /->[ \t]*[a-zA-Z_]*$/.test(prefix);
}

/**
 * Determine the object type from context so we can filter completions.
 * 1. Look back for a  @type {TypeName}  JSDoc annotation on this variable.
 * 2. Fall back to variable name heuristics.
 */
function detectObjectType(
    document: vscode.TextDocument,
    position: vscode.Position
): 'ship' | 'station' | 'sector' | 'object' | 'race' | null {
    const prefix = linePrefix(document, position);

    // Variable before -> (supports dotted names like $my.ship)
    const varMatch = /(\$[a-zA-Z_][a-zA-Z0-9_.]*)\s*->\s*[a-zA-Z_]*$/.exec(prefix);
    if (!varMatch) { return null; }

    const rawVarName = varMatch[1];
    const escapedVar = rawVarName.replace(/\$/g, '\\$').replace(/\./g, '\\.');

    const beforeCursor = document.getText().slice(0, document.offsetAt(position));
    const typeAnnotRe  = new RegExp(`@type\\s*\\{(\\w+)\\}[\\s\\S]*?${escapedVar}\\b`, 'gi');
    let lastType: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = typeAnnotRe.exec(beforeCursor)) !== null) { lastType = m[1]; }

    if (lastType) {
        const t = lastType.toLowerCase();
        if (t === 'ship')                        { return 'ship'; }
        if (t === 'station')                     { return 'station'; }
        if (t === 'sector')                      { return 'sector'; }
        if (t === 'xobject' || t === 'object')  { return 'object'; }
        if (t === 'race' || t === 'raceobject') { return 'race'; }
    }

    // Heuristic fallback
    const vn = rawVarName.toLowerCase();
    if (/ship|fighter|hauler|freighter|vessel|m[135678]|tl\b|ts\b|tp\b/.test(vn)) { return 'ship'; }
    if (/station|dock|factory|fac\b|base|hq\b|complex|hub/.test(vn))               { return 'station'; }
    if (/sector|zone|sys\b/.test(vn))                                                { return 'sector'; }

    return null;
}

// ── Completion provider ───────────────────────────────────────────────────────

export class XScriptCompletionProvider implements vscode.CompletionItemProvider {
    constructor(private db: XDatabase) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.CompletionItem[] | null {

        const prefix = linePrefix(document, position);

        // ── After ->  →  method / property completions ───────────────────────
        if (isMethodContext(prefix)) {
            return this._methodCompletions(document, position);
        }

        // ── Bare '.' trigger inside a variable name  →  suppress ─────────────
        if (context.triggerCharacter === '.') {
            return [];
        }

        // ── ':' trigger — only show completions when '::' is fully present.
        // A single ':' (e.g. a label definition) should not interfere.
        if (context.triggerCharacter === ':') {
            const ns = detectNamespace(prefix);
            if (ns) { return this._namespaceCompletions(ns); }
            return null; // not a namespace context — let VS Code show default list
        }

        // ── After Namespace:: (typed manually or via continuation) ────────────
        const ns = detectNamespace(prefix);
        if (ns) { return this._namespaceCompletions(ns); }

        // ── Everything else  →  global functions + constants + namespace names ─
        return this._globalCompletions();
    }

    // ── Method / property completions after -> ────────────────────────────────
    private _methodCompletions(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const ctx   = detectObjectType(document, position);
        const items: vscode.CompletionItem[] = [];

        // Properties first (sorted to top via sortText prefix '0')
        for (const p of this.db.properties) {
            if (ctx) {
                const gFn = this.db.functions.get(p.getterId);
                // If we know the type, only show properties whose getter belongs to it
                if (gFn && !gFn.refTypes.includes(`DATATYPE_${ctx.toUpperCase()}`)) {
                    continue;
                }
            }
            items.push(makePropItem(p));
        }

        // Methods
        let candidates: XFunction[];
        if (!ctx) {
            // Unknown type — show everything, deduplicated by name
            const seen = new Set<string>();
            candidates = [];
            for (const fn of [
                ...this.db.objectFunctions,
                ...this.db.shipFunctions,
                ...this.db.stationFunctions,
                ...this.db.sectorFunctions,
                ...this.db.raceFunctions,
            ]) {
                if (!seen.has(fn.name)) { seen.add(fn.name); candidates.push(fn); }
            }
        } else {
            // Known type — primary list + XObject base methods
            const primary = ctx === 'ship'    ? this.db.shipFunctions
                           : ctx === 'station' ? this.db.stationFunctions
                           : ctx === 'sector'  ? this.db.sectorFunctions
                           : ctx === 'race'    ? this.db.raceFunctions
                           :                    this.db.objectFunctions;

            if (ctx !== 'object' && ctx !== 'race') {
                const seen = new Set<string>(primary.map(f => f.name));
                candidates = [...primary];
                for (const fn of this.db.objectFunctions) {
                    if (!seen.has(fn.name)) { seen.add(fn.name); candidates.push(fn); }
                }
            } else {
                candidates = primary;
            }
        }

        const seenNames = new Set<string>();
        for (const fn of candidates) {
            if (seenNames.has(fn.name)) { continue; }
            seenNames.add(fn.name);
            items.push(makeMethodItem(fn));
        }

        return items;
    }

    // ── Namespace function + constant completions (after Namespace::) ─────────
    private _namespaceCompletions(ns: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const seen = new Set<string>();

        // Function members
        const fns = this.db.namespaceFunctions.get(ns);
        if (fns) {
            for (const fn of fns) {
                const displayName = fn.namespaceAlias ?? fn.name;
                if (seen.has(displayName)) { continue; }
                seen.add(displayName);

                const item = new vscode.CompletionItem(displayName, vscode.CompletionItemKind.Function);
                item.detail = `[${ns}]  → ${fn.returnTs}`;
                item.documentation = fnDocumentation({ ...fn, name: displayName });
                item.filterText = displayName;
                item.sortText   = '0' + displayName.toLowerCase();
                if (fn.args.length === 0) {
                    item.insertText = new vscode.SnippetString(`${displayName}()`);
                } else {
                    const snippetArgs = fn.args
                        .map((a, i) => `\${${i + 1}:${a.paramName}}`)
                        .join(', ');
                    item.insertText = new vscode.SnippetString(`${displayName}(${snippetArgs})`);
                }
                items.push(item);
            }
        }

        // Constant members (e.g. RaceFlag::NPC)
        const consts = this.db.constantNamespaces.get(ns);
        if (consts) {
            for (const c of consts) {
                if (seen.has(c.code)) { continue; }
                seen.add(c.code);

                const item = new vscode.CompletionItem(c.code, vscode.CompletionItemKind.EnumMember);
                item.detail = c.type || ns;
                if (c.description) {
                    item.documentation = new vscode.MarkdownString(c.description);
                }
                item.filterText = c.code;
                item.sortText   = '0' + c.code.toLowerCase();
                item.insertText = c.code;
                items.push(item);
            }
        }

        return items;
    }

    // ── Global function + constant completions ────────────────────────────────
    private _globalCompletions(): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        // Constants
        for (const c of this.db.constants) {
            const item = new vscode.CompletionItem(c.code, vscode.CompletionItemKind.Constant);
            item.detail = c.type || 'constant';
            if (c.description) {
                item.documentation = new vscode.MarkdownString(c.description);
            }
            item.filterText  = c.code;
            item.insertText  = c.code;
            item.sortText    = '0' + c.code.toLowerCase();
            items.push(item);
        }

        // Namespace names — typing 'Utils' shows it as a module completion
        for (const ns of this.db.namespaces) {
            const item = new vscode.CompletionItem(ns, vscode.CompletionItemKind.Module);
            item.detail = `namespace — use ${ns}:: to access functions`;
            item.filterText  = ns;
            item.sortText    = '1' + ns.toLowerCase();
            // Insert the namespace name with :: so the next trigger fires immediately
            item.insertText  = new vscode.SnippetString(`${ns}::\${0}`);
            item.command = { command: 'editor.action.triggerSuggest', title: 'Trigger Suggest' };
            items.push(item);
        }

        // Global functions — no artificial cap; VS Code handles virtual scrolling
        const seen = new Set<string>();
        for (const fn of this.db.globalFunctions) {
            if (seen.has(fn.name)) { continue; }
            seen.add(fn.name);
            items.push(makeGlobalFnItem(fn));
        }

        // Function macros (e.g. foreach) — language-level constructs, not real
        // functions, so they get a Snippet kind and a block body when applicable
        for (const macro of this.db.macros) {
            if (seen.has(macro.name)) { continue; }
            seen.add(macro.name);

            const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Snippet);
            item.detail = macro.hasBlock
                ? `${macro.name}(${macro.argNames.join(', ')}) { ... }`
                : `${macro.name}(${macro.argNames.join(', ')})`;
            item.documentation = new vscode.MarkdownString(
                `Language macro \`${macro.name}\` — expands to native XScript at compile time.`
            );
            item.filterText = macro.name;
            item.sortText   = '0' + macro.name.toLowerCase();

            const argSnippets = macro.argNames
                .map((a, i) => `\${${i + 1}:${a || `arg${i}`}}`)
                .join(', ');

            if (macro.hasBlock) {
                item.insertText = new vscode.SnippetString(
                    `${macro.name}(${argSnippets})\n{\n\t$0\n}`
                );
            } else {
                item.insertText = new vscode.SnippetString(
                    `${macro.name}(${argSnippets})$0`
                );
            }
            items.push(item);
        }

        return items;
    }
}

// ── Signature help provider ───────────────────────────────────────────────────

export class XScriptSignatureHelpProvider implements vscode.SignatureHelpProvider {
    constructor(private db: XDatabase) {}

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.SignatureHelp | null {
        const prefix = linePrefix(document, position);

        // Walk backwards to find the innermost unclosed '('
        let depth = 0;
        let parenPos = -1;
        for (let i = prefix.length - 1; i >= 0; i--) {
            if (prefix[i] === ')')      { depth++; }
            else if (prefix[i] === '(') {
                if (depth === 0) { parenPos = i; break; }
                depth--;
            }
        }
        if (parenPos < 0) { return null; }

        // Extract function name — handles  funcName(  $obj->funcName(  and  Ns::funcName(
        const beforeParen = prefix.slice(0, parenPos);
        const nameMatch   = /->([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(beforeParen)
                         ?? /([a-zA-Z_][a-zA-Z0-9_]*)::([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(beforeParen)
                         ?? /\b([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(beforeParen);
        if (!nameMatch) { return null; }

        const lookupName = nameMatch[nameMatch.length - 1];

        // Function macro? (e.g. foreach)
        const macro = this.db.macros.find(m => m.name === lookupName);
        if (macro) {
            const argsText  = prefix.slice(parenPos + 1);
            let activeParam = 0;
            let d = 0;
            for (const ch of argsText) {
                if (ch === '(' || ch === '[')      { d++; }
                else if (ch === ')' || ch === ']') { d--; }
                else if (ch === ',' && d === 0)    { activeParam++; }
            }

            const help = new vscode.SignatureHelp();
            help.activeParameter = activeParam;
            help.activeSignature = 0;

            const sigLabel = macro.hasBlock
                ? `${macro.name}(${macro.argNames.join(', ')}) { ... }`
                : `${macro.name}(${macro.argNames.join(', ')})`;
            const sig = new vscode.SignatureInformation(
                sigLabel,
                new vscode.MarkdownString('Language macro — expands to native XScript at compile time.')
            );
            sig.parameters = macro.argNames.map(a => new vscode.ParameterInformation(a));
            help.signatures.push(sig);
            return help;
        }

        // For Namespace::func match, look up in namespace map first
        let candidates = this.db.byName.get(lookupName);
        if (!candidates || candidates.length === 0) {
            // Try namespace map: nameMatch[1]=ns, nameMatch[2]=alias
            if (nameMatch.length === 3) {
                const nsFns = this.db.namespaceFunctions.get(nameMatch[1]);
                if (nsFns) {
                    candidates = nsFns.filter(f => (f.namespaceAlias ?? f.name) === nameMatch[2]);
                }
            }
        }
        if (!candidates || candidates.length === 0) { return null; }

        // Count commas at depth 0 → active parameter index
        const argsText  = prefix.slice(parenPos + 1);
        let activeParam = 0;
        let d           = 0;
        for (const ch of argsText) {
            if (ch === '(' || ch === '[')      { d++; }
            else if (ch === ')' || ch === ']') { d--; }
            else if (ch === ',' && d === 0)    { activeParam++; }
        }

        const help = new vscode.SignatureHelp();
        help.activeParameter = activeParam;
        help.activeSignature = 0;

        for (const fn of candidates) {
            const sig = new vscode.SignatureInformation(fnLabel(fn), fnDocumentation(fn));
            sig.parameters = fn.args.map(a =>
                new vscode.ParameterInformation(
                    `${a.paramName}: ${a.tsType}`,
                    a.description
                )
            );
            help.signatures.push(sig);
        }

        return help;
    }
}

// ── Hover provider ────────────────────────────────────────────────────────────

export class XScriptHoverProvider implements vscode.HoverProvider {
    constructor(private db: XDatabase) {}

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.Hover | null {
        // Word range: include $, dot-paths, and Namespace:: prefix
        const range = document.getWordRangeAtPosition(
            position,
            /\$[a-zA-Z_][a-zA-Z0-9_.]*|[a-zA-Z_][a-zA-Z0-9_]*::[a-zA-Z_][a-zA-Z0-9_]*|[a-zA-Z_][a-zA-Z0-9_]*/
        );
        if (!range) { return null; }

        const word       = document.getText(range);
        const lookupWord = word.startsWith('$') ? word.slice(1) : word;

        // Namespace::member hover — check function namespaces then constant namespaces
        const nsParts = /^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(lookupWord);
        if (nsParts) {
            const [, nsName, memberName] = nsParts;
            // Function namespace
            const nsFns = this.db.namespaceFunctions.get(nsName);
            if (nsFns) {
                const fn = nsFns.find(f => (f.namespaceAlias ?? f.name) === memberName);
                if (fn) {
                    const displayName = `${nsName}::${memberName}`;
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    md.appendCodeblock(`${displayName}(${fn.args.map(a => `${a.paramName}: ${a.tsType}`).join(', ')}): ${fn.returnTs}`, 'typescript');
                    md.appendMarkdown('\n\n' + fn.description);
                    return new vscode.Hover(md, range);
                }
            }
            // Constant namespace
            const nsConsts = this.db.constantNamespaces.get(nsName);
            if (nsConsts) {
                const c = nsConsts.find(x => x.code === memberName);
                if (c) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(`**${nsName}::${memberName}** _(${c.type || nsName})_`);
                    if (c.description) { md.appendMarkdown(`\n\n${c.description}`); }
                    return new vscode.Hover(md, range);
                }
            }
        }

        // Function macro? (e.g. foreach)
        const macro = this.db.macros.find(m => m.name === lookupWord);
        if (macro) {
            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            const sig = macro.hasBlock
                ? `${macro.name}(${macro.argNames.join(', ')}) { ... }`
                : `${macro.name}(${macro.argNames.join(', ')})`;
            md.appendCodeblock(sig, 'typescript');
            md.appendMarkdown(`\n\nLanguage macro — expands to native XScript at compile time.`);
            if (macro.argNames.length > 0) {
                md.appendMarkdown('\n\n**Parameters:**');
                for (const a of macro.argNames) {
                    md.appendMarkdown(`\n- \`${a}\``);
                }
            }
            return new vscode.Hover(md, range);
        }

        // Function?
        const fns = this.db.byName.get(lookupWord);
        if (fns && fns.length > 0) {
            const fn = fns[0];
            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.appendCodeblock(fnLabel(fn), 'typescript');
            md.appendMarkdown('\n\n' + fn.description);
            if (fn.args.length > 0) {
                md.appendMarkdown('\n\n**Parameters:**');
                for (const a of fn.args) {
                    md.appendMarkdown(`\n- \`${a.paramName}: ${a.tsType}\` — ${a.description}`);
                }
            }
            if (fn.returnTs !== 'void') {
                md.appendMarkdown(`\n\n**Returns:** \`${fn.returnTs}\``);
            }
            if (fn.example) {
                md.appendMarkdown('\n\n**Example:**\n```xscript\n' + fn.example + '\n```');
            }
            return new vscode.Hover(md, range);
        }

        // Property?
        const prop = this.db.properties.find(p => p.name === lookupWord);
        if (prop) {
            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            md.appendCodeblock(
                `${prop.readonly ? 'readonly ' : ''}${prop.name}: ${prop.tsType}`,
                'typescript'
            );
            md.appendMarkdown('\n\n' + prop.description);
            return new vscode.Hover(md, range);
        }

        // Constant? (try both with and without $ prefix)
        const constant = this.db.constants.find(c => c.code === lookupWord || c.code === word);
        if (constant) {
            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**${constant.code}** _(${constant.type || 'constant'})_`);
            if (constant.description) { md.appendMarkdown(`\n\n${constant.description}`); }
            return new vscode.Hover(md, range);
        }

        return null;
    }
}
