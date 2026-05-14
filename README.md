# XScript — X3 Farnham's Legacy VS Code Extension

Full IntelliSense, syntax highlighting, and diagnostics for XScript — the scripting language for X3 Farnham's Legacy.

---

## Features

| Feature | Description |
|---------|-------------|
| **Syntax highlighting** | Keywords, variables (`$var`), method calls (`$obj->method`), constants, strings, comments |
| **Autocomplete** | All 2,482 functions with argument snippets and tab stops |
| **Method completions** | Typing `$ship->` shows only ship methods; `$station->` shows station methods |
| **Signature help** | Full parameter names and descriptions as you type inside `(` |
| **Hover docs** | Hover any function name to see description, parameters, return type, and example |
| **Diagnostics** | Warns on obvious argument count mismatches |
| **Auto-reload** | Automatically reloads when `x3fl.xml` changes in your workspace |

---

## Installation

### From VSIX (manual install)

1. Download or build `xscript-x3fl-1.0.0.vsix`
2. In VS Code: `Extensions` → `…` → `Install from VSIX…`
3. Select the `.vsix` file

### Building from source

```bash
npm install
npm run compile
npx vsce package
# produces xscript-x3fl-1.0.0.vsix
```

---

## Setup

### 1 — Place your definition file in your workspace

The extension supports two definition file formats:

| File | Source | Contents |
|------|--------|---------|
| `x3fl.dat` | Compiled by XScript compiler | Functions + ware types + object commands + races + custom types — **recommended** |
| `x3fl.xml` | Edited manually | Functions and properties only — fallback |

Copy either `x3fl.dat` or `x3fl.xml` into the root of your script project folder. **If both are present, `.dat` takes priority.**

Alternatively, set paths explicitly in VS Code settings:

```json
"xscript.dataPath": "C:/path/to/x3fl.dat",
"xscript.xmlPath":  "C:/path/to/x3fl.xml"
```

### 2 — Open your script folder

`File → Open Folder` — open the folder containing your `.xs` files.

### 3 — That's it

`.xs` files are automatically recognised as XScript. IntelliSense activates immediately.

---

## File format priority

```
1. xscript.dataPath setting  →  explicit .dat path
2. xscript.xmlPath setting   →  explicit .xml path
3. x3fl.dat in workspace root
4. x3fl.xml in workspace root
5. x3fl.dat bundled in extension
6. x3fl.xml bundled in extension
```

---

## Usage

### Global function completions

Start typing any function name:

```
createS  →  createShip, createStation, createSun ...
```

Press `Tab` to insert the full snippet with placeholders for each argument.

### Method completions on objects

Type `$myShip->` and VS Code shows only ship methods.

For the best experience, add a JSDoc type annotation on your variables:

```javascript
/** @type {Ship} */
var myShip = getPlayerShip();

myShip->  // ← shows ship methods only, sorted alphabetically
```

Supported types: `Ship`, `Station`, `Sector`, `XObject`, `RaceObject`

### Signature help

Inside a function call, `Ctrl+Shift+Space` shows the full signature:

```
createShip(shipType: ShipType, ownerRace: Race, env: any, x: number, y: number, z: number)
           ^^^^^^^^^^^
           Current parameter highlighted
```

### Hover documentation

Hover over any function name to see:
- Description
- All parameter names, types, and descriptions  
- Return type
- Usage example (where available)

---

## Compiler integration

The extension can call the XScript compiler directly, showing errors as squiggles in the editor.

### Compiler command format

```
XScriptCompiler.exe --load_data x3fl.dat compile "input.xs" --out "output.xml"
```

### Configure (VS Code settings)

Open Settings (`Ctrl+,`) and search for `xscript.compiler`:

```json
{
    // Required: path to the compiler executable
    "xscript.compiler.exePath": "C:\\XScript\\XScriptCompiler.exe",

    // Optional: path to x3fl.dat  (auto-detected in workspace root if blank)
    "xscript.compiler.dataFile": "C:\\XScript\\x3fl.dat",

    // Optional: where to write compiled .xml files
    // Leave blank to write them alongside the .xs source file
    "xscript.compiler.outputDir": "C:\\XScript\\output",

    // Optional: compile automatically whenever a .xs file is saved
    "xscript.compiler.compileOnSave": false
}
```

### Compile commands

| Action | How |
|--------|-----|
| Compile current file | **`Ctrl+Shift+B`** or the `▶` button in the editor title bar |
| Compile all `.xs` files | Command Palette → **XScript: Compile All Files** |
| Auto-compile on save | Set `xscript.compiler.compileOnSave: true` |
| View full output | **Output** panel → **XScript Compiler** channel |

Errors and warnings from the compiler appear as red/yellow squiggles directly in the source file, and in the **Problems** panel (`Ctrl+Shift+M`).

### Alternative: tasks.json

A `tasks.json.template` is included in the extension zip. Copy it to `.vscode/tasks.json` in your project and edit the three paths marked `CONFIGURE` if you prefer to drive compilation through VS Code's built-in Tasks system instead of the extension commands.

---

## Status bar

The status bar item in the bottom-right shows the current state:

- `⟳ XScript: Loading…` — parsing the XML
- `✓ XScript: 2,482 functions loaded` — ready
- `◈ XScript` — idle (click to reload)
- `⚠ XScript: Parse error` — check the Output panel

Click the status bar item at any time to reload the definition database.

---

## File associations

`.xs` files are treated as XScript automatically. If VS Code doesn't pick them up, add this to your workspace settings:

```json
"files.associations": {
    "*.xs": "xscript"
}
```

---

## Method context detection

The extension determines which method completions to show by:

1. **JSDoc annotation** — `/** @type {Ship} */ var $s = ...` → ship methods only
2. **Variable name heuristics** — `$shipVar`, `$fighter`, `$hauler` → ship methods
3. **Fallback** — shows all methods from all object types

---

## Building the VSIX

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package as VSIX
npx vsce package

# Install into VS Code
code --install-extension xscript-x3fl-1.0.0.vsix
```

---

## Project structure

```
xscript-x3fl/
├── src/
│   ├── extension.ts      # Entry point — activation, provider registration
│   ├── xmlParser.ts      # Parses x3fl.xml into the function database
│   ├── providers.ts      # Completion, SignatureHelp, Hover providers
│   └── diagnostics.ts    # Argument count checking
├── syntaxes/
│   └── xscript.tmLanguage.json   # TextMate grammar for syntax highlighting
├── icons/
│   └── icon.png          # Extension marketplace icon
├── language-configuration.json   # Brackets, comments, auto-close
├── package.json          # Extension manifest
├── tsconfig.json
└── README.md
```
