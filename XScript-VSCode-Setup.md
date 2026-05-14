# XScript Extension for VS Code — Setup Guide

IntelliSense, syntax highlighting and compiler integration for X3 Farnham's Legacy scripting.

---

## Installation

1. Open **Visual Studio Code**
2. Press `Ctrl+Shift+X` to open the Extensions panel
3. Click the `…` menu (top-right of the panel) and choose **Install from VSIX…**
4. Select the `xscript-x3fl-1.1.0.vsix` file
5. Reload VS Code when prompted

---

## Setup

### Step 1 — Open your scripts folder

Use **File → Open Folder** and open the folder containing your `.xs` script files.

VS Code needs an open folder (not just individual files) for the extension to work correctly.

---

### Step 2 — Place a definition file in the folder

The extension needs a definition file to provide IntelliSense (autocomplete, hover docs, etc.).
Copy one of the following into your scripts folder root:

| File | Notes |
|------|-------|
| `x3fl.dat` | Preferred — binary format, loads fastest |
| `default_data.dat` | Used if `x3fl.dat` is not present |
| `x3fl.xml` | Fallback — used if neither `.dat` file is found |

The extension will detect the file automatically. No configuration needed for this step.

---

### Step 3 — Configure the compiler *(optional)*

This step is only needed if you want to compile scripts directly from VS Code using `Ctrl+Shift+B`.

Open VS Code Settings:
- **File → Preferences → Settings**, or press `Ctrl+,`
- Search for **xscript**

Configure the following:

#### `xscript.compiler.exePath`
Full path to `XScriptCompiler.exe`.

```
C:\XScript\XScriptCompiler.exe
```

Leave blank if `XScriptCompiler.exe` is in your scripts folder or on your system PATH — the extension will find it automatically.

#### `xscript.compiler.dataFile`
Path to the data file passed to the compiler (`--load_data`).

```
C:\XScript\default_data.dat
```

Leave blank to auto-detect. The extension looks for `x3fl.dat` then `default_data.dat` in your scripts folder and next to the compiler exe.

#### `xscript.compiler.outputDir`
Folder where compiled `.xml` files are written.

```
C:\XScript\output
```

Leave blank to write the `.xml` file alongside the `.xs` source file.

#### `xscript.compiler.compileOnSave`
Set to `true` to automatically compile every time you save a `.xs` file.

Default: `false`

---

## Using the extension

### IntelliSense

The extension activates automatically when you open a `.xs` file.

| Feature | How to use |
|---------|-----------|
| **Autocomplete** | Start typing a function name, or press `Ctrl+Space` |
| **Method completions** | Type `$myVar->` to see methods for that object |
| **Signature help** | Type `(` after a function name to see parameters |
| **Hover docs** | Hover your mouse over any function name |

### Compiling

| Action | How |
|--------|-----|
| Compile current file | `Ctrl+Shift+B` |
| Compile all `.xs` files | Command Palette (`Ctrl+Shift+P`) → **XScript: Compile All Files** |
| View compiler output | **View → Output** → select **XScript Compiler** from the dropdown |
| View errors and warnings | **View → Problems** (`Ctrl+Shift+M`) |

Errors and warnings from the compiler appear as coloured underlines directly in the script editor and are listed in the Problems panel.

### Reloading the definition database

If you update `x3fl.dat` or `x3fl.xml`, the extension detects the change and reloads automatically. You can also reload manually:

- Click the **◈ XScript** item in the status bar (bottom-right), or
- Command Palette → **XScript: Reload Definition Database**

---

## File associations

`.xs` files are recognised as XScript automatically. If VS Code shows them as plain text, add this to your workspace settings (`.vscode/settings.json`):

```json
{
    "files.associations": {
        "*.xs": "xscript"
    }
}
```

---

## Settings reference

All settings are under **File → Preferences → Settings** (search `xscript`).

| Setting | Default | Description |
|---------|---------|-------------|
| `xscript.dataPath` | *(blank)* | Explicit path to a `.dat` definition file |
| `xscript.xmlPath` | *(blank)* | Explicit path to `x3fl.xml` |
| `xscript.compiler.exePath` | *(blank)* | Path to `XScriptCompiler.exe` |
| `xscript.compiler.dataFile` | *(blank)* | Path to the compiler data file (`--load_data`) |
| `xscript.compiler.outputDir` | *(blank)* | Output folder for compiled `.xml` files |
| `xscript.compiler.compileOnSave` | `false` | Compile automatically on save |

All path settings can be left blank — the extension will search for files in standard locations automatically.
