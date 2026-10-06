# latex-editor

A local web editor for LaTeX: file tree, editor, and PDF preview in a single browser tab. Saving a `.tex` file compiles it using your local TeX installation and reloads the PDF.
Everything runs on `127.0.0.1` and the server needs nothing beyond Node.js and your TeX installation, so it works offline and no data leaves your machine.

日本語の説明は [README.ja.md](README.ja.md) にあります。The UI text is in Japanese.

## When to use

- When your `.tex` files live in a synced or version-controlled folder and you do not want PDFs, `.aux`, `.log`, or `.synctex.gz` written next to them. Build artifacts go to a separate build directory.
- When you want to click a spot in the PDF and land on the source line, or jump from the cursor to the PDF (bidirectional SyncTeX), without leaving the browser tab.
- When the same `.tex` files are also edited on another PC or in another editor, and you want a warning instead of a silent overwrite.

Not for you if your documents need `uplatex` or `platex` (they output DVI, not PDF), if you rely on BibTeX, biber, or makeindex, or if more than one person needs to reach the editor.

## What it looks like

Run `start.js` in the folder that holds your `.tex` files; the terminal prints `サーバーを起動しました。` and `http://127.0.0.1:8940` opens in your browser. Click a file in the tree and press `Cmd+S` / `Ctrl+S`: the status line goes from `⟳ コンパイル中` to `✓ 保存済み` and the PDF preview appears on the right, or shows `⚠️ コンパイル失敗` if the compile fails. When another program changes the open file, a banner reads `このファイルは外部（別の PC・エディタ等）で更新されました` with a `再読込してコンパイル` button.

## Requirements

- Node.js 18 or later.
- A TeX distribution with `lualatex` available on `PATH` (such as TeX Live). Other engines that output PDF directly (such as `pdflatex` or `xelatex`) can be selected via `--engine`.
- **`uplatex` and `platex` are not supported.** They output DVI files rather than PDFs, so every compile is reported as failed.

The editor has been used on macOS and Windows as part of the author's personal setup. This standalone version, featuring its own compile step (`compile.js`), has been tested on macOS only.

## Install

There is no install step. The server uses only Node.js built-in modules, and CodeMirror 5 and PDF.js are bundled in `vendor/`, so it works offline without running `npm install`. Go straight to the commands below.

## Run

Run the following from the directory containing your `.tex` files:

```sh
node /path/to/latex-editor/start.js
```

`start.js` starts the server as a detached background process if it is not already running, waits until it is ready, and opens `http://127.0.0.1:8940`. Stop it with:

```sh
node /path/to/latex-editor/stop.js
```

`stop.js` stops only this editor's server. If another process occupies the port, it leaves that process running and exits with code 1.

### Try the sample

`examples/` contains a minimal Japanese document (`sample.tex`, document class `ltjsarticle`) and an accompanying style file (`sample-style.sty`) that defines the commands used by the document. It requires `luatexja`, which is included in full TeX Live installations.

```sh
node start.js --root examples
```

Click `sample.tex` in the file tree and save it (`Cmd+S` / `Ctrl+S`); the PDF preview will appear on the right.

### Options

| Option | Meaning |
|---|---|
| `--port 8950` | Port number (default: 8940). Pass the same value to `stop.js`. |
| `--root <dir>` | Directory to edit (default: current working directory). |
| `--build <dir>` | Output directory for PDFs and build artifacts. Must be outside `--root`. Default: `~/.latex-editor/build/<folder name>-<hash>/`. |
| `--engine <command>` | TeX engine to run (default: `lualatex`). Invoked with `-interaction=nonstopmode -halt-on-error -file-line-error --synctex=1 -output-directory=<build>`. |
| `--no-open` | Do not automatically open the browser (`start.js` only). |

To run the server in the foreground and view logs: run `node server.js` with the same options (press `Ctrl+C` to stop).

## Editing

- The file tree shows `.tex`, `.sty`, `.cls`, `.md`, and `.txt` files under the root directory. Hidden directories and `node_modules` are ignored.
- Saving a `.tex` file compiles it. The engine runs up to three times if the log requests a rerun.
- The build folder mirrors the directory structure of the root. Before each compile, subdirectories of the `.tex` file's directory are mirrored in the build folder so that `\include{chapters/ch1}` can write its `.aux` file there.
- BibTeX, biber, and makeindex are not run.
- Certain autocompletion candidates (`\dfrac`, `\text`, `\therefore`, `\mathbb`, etc.) require `amsmath` or `amssymb`.

### Style files in another folder

The engine runs in the directory of the `.tex` file, so any `.sty` or `.cls` file located next to it is detected automatically. Files in other directories are not found because the editor adds no search paths. You can make them visible in two ways:

- Place the file in your personal TeX tree (`kpsewhich -var-value TEXMFHOME` prints the location: `~/Library/texmf` on MacTeX, usually `~/texmf` on other platforms; LaTeX files go in `tex/latex/` below it).
- Set `TEXINPUTS` before starting the editor; the engine inherits it. The trailing separator preserves standard search paths: `TEXINPUTS=/path/to/styles//: node start.js` (on Windows, the separator is `;`).

Saving a `.sty` or `.cls` file does not trigger compilation; save the `.tex` file that uses it instead.

| Keys (Mac / Windows) | Action |
|---|---|
| `Cmd+S` / `Ctrl+S` | Save and compile |
| `Cmd+/` / `Ctrl+/` | Toggle `%` comments on the current line or selection |
| `Ctrl+Space` | Autocomplete TeX commands |
| `Cmd+F` / `Ctrl+F` | Find |
| `Cmd+Option+F` / `Ctrl+Shift+F` | Replace |
| `Alt+G` | Go to line |
| `Cmd+Alt+J` / `Ctrl+Alt+J` | Jump from cursor position to the corresponding location in the PDF |
| Click on the PDF | Jump to the source line (opens the target file if needed) |

SyncTeX needs a compile after the file was last moved or opened for the first time; an old PDF has no map.

## Edits made elsewhere

- The editor tracks the modification timestamp of each opened file. If the file on disk is newer when you save, the save request is rejected with HTTP 409 and a notification is displayed. Reopen the file from the tree.
- The active file is polled every 3 seconds. When an external program modifies it, a banner prompts you to reload and compile.
- Because the check compares modification timestamps, two writes occurring within the same timestamp tick cannot be distinguished.

## Tests

```sh
node --test test/synctex.test.js test/start_stop.test.js
```

`start_stop.test.js` starts a real server on an available local port in a temporary folder and compiles test documents; the compilation tests are skipped when `lualatex` is not found on `PATH`. `synctex.test.js` builds its fixtures with `lualatex`, so all of its tests are skipped in that case.

## Limits

- Single-user, local use only: no authentication; binds exclusively to `127.0.0.1`.
- The server uses synchronous file I/O, so an exceptionally large file or deep directory tree may cause brief pauses.
- Compilations are queued sequentially (one at a time) with a 180-second timeout.

## Bundled libraries

- Editor: [CodeMirror 5](https://codemirror.net/5/) 5.65.16 ([source](https://github.com/codemirror/codemirror5); MIT License, © Marijn Haverbeke and others). License text: [`vendor/LICENSE`](vendor/LICENSE).
- PDF preview: [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38 ([source](https://github.com/mozilla/pdf.js); Apache License 2.0, Mozilla Foundation). License text: [`vendor/LICENSE_pdfjs`](vendor/LICENSE_pdfjs).

## Notes

- Developed with AI coding assistance.

## License

MIT License for code in this repository outside `vendor/`. See [LICENSE](LICENSE). The bundled libraries keep their own licenses, listed above.
