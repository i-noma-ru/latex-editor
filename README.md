# latex-editor

A local web editor for LaTeX: file tree, editor, and PDF preview in one browser page. Saving a `.tex` file compiles it with the TeX installation on your machine and reloads the PDF. Everything runs on `127.0.0.1`; nothing is sent anywhere.

日本語の説明は [README.ja.md](README.ja.md) にあります。The on-screen text is in Japanese.

- Node.js built-in modules only on the server. CodeMirror 5 and PDF.js are bundled in `vendor/`, so it works offline with no `npm install`.
- PDFs and by-products (`.aux`, `.log`, `.synctex.gz`) go to a separate build folder, never next to your `.tex` files. This keeps a synced or version-controlled folder clean.
- SyncTeX in both directions: click the PDF to jump to the source line, or press a key to jump from the cursor to the PDF.
- Detects when a file was changed elsewhere and refuses to overwrite it.

## Requirements

- Node.js 18 or later.
- A TeX distribution with `lualatex` on `PATH` (for example TeX Live). Another engine that writes a PDF directly (such as `pdflatex` or `xelatex`) can be chosen with `--engine`.
- **`uplatex` and `platex` are not supported.** They write a DVI file, not a PDF, so every compile is reported as failed.

The editor has been used on macOS and Windows as part of the author's own setup. This standalone version, with its own compile step (`compile.js`), was tested on macOS only.

## Run

From the folder that holds your `.tex` files:

```sh
node /path/to/latex-editor/start.js
```

`start.js` starts the server detached if it is not running, waits until it is up, and opens `http://127.0.0.1:8940`. Stop it with:

```sh
node /path/to/latex-editor/stop.js
```

`stop.js` stops only this editor's server. If another process holds the port, it leaves it alone and exits with 1.

### Try the sample

`examples/` holds a small Japanese document (`sample.tex`, class `ltjsarticle`) and a style file next to it (`sample-style.sty`) that defines the commands the document uses. It needs `luatexja`, which a full TeX Live install includes.

```sh
node start.js --root examples
```

Click `sample.tex` in the tree and save it (`Cmd+S` / `Ctrl+S`); the PDF appears on the right.

### Options

| Option | Meaning |
|---|---|
| `--port 8950` | Port (default 8940). Pass the same value to `stop.js`. |
| `--root <dir>` | Folder to edit. Default: the current directory. |
| `--build <dir>` | Where PDFs and by-products go. Must be outside `--root`. Default: `~/.latex-editor/build/<folder name>-<hash>/`. |
| `--engine <command>` | TeX engine to run (default `lualatex`). It is called with `-interaction=nonstopmode -halt-on-error -file-line-error --synctex=1 -output-directory=<build>`. |
| `--no-open` | Do not open the browser (`start.js` only). |

To run the server in the foreground and see its log: `node server.js` with the same options (Ctrl+C to stop).

## Editing

- The tree shows `.tex`, `.sty`, `.cls`, `.md`, and `.txt` files under the root. Hidden folders and `node_modules` are skipped.
- Saving a `.tex` file compiles it. The engine runs up to three times when the log asks for a rerun.
- The build folder mirrors the folder layout of the root. Before each compile, the subfolders of the `.tex` file's folder are created in the build folder too, so that `\include{chapters/ch1}` can write its `.aux` file there.
- BibTeX, biber, and makeindex are not run.
- Some completion candidates (`\dfrac`, `\text`, `\therefore`, `\mathbb`, and others) need `amsmath` or `amssymb`.

### Style files in another folder

The engine runs in the folder of the `.tex` file, so a `.sty` or `.cls` next to it is found. One kept in a different folder is not; the editor adds no search path. Two ways to make it visible:

- Put it under your personal TeX tree (`kpsewhich -var-value TEXMFHOME` prints the location: `~/Library/texmf` on MacTeX, usually `~/texmf` elsewhere; LaTeX files go in `tex/latex/` below it).
- Set `TEXINPUTS` before starting the editor; the engine inherits it. The trailing separator keeps the standard paths: `TEXINPUTS=/path/to/styles//: node start.js` (on Windows the separator is `;`).

Saving a `.sty` or `.cls` file does not compile anything; save the `.tex` file that uses it.

| Keys (Mac / Windows) | Action |
|---|---|
| `Cmd+S` / `Ctrl+S` | Save and compile |
| `Cmd+/` / `Ctrl+/` | Toggle `%` comments on the line or selection |
| `Ctrl+Space` | Completion candidates for TeX commands |
| `Cmd+F` / `Ctrl+F` | Find |
| `Cmd+Option+F` / `Ctrl+Shift+F` | Replace |
| `Alt+G` | Go to line |
| `Cmd+Alt+J` / `Ctrl+Alt+J` | Jump from the cursor line to the matching place in the PDF |
| Click on the PDF | Jump to the source line (opens the file if it is a different one) |

SyncTeX needs a compile after the file was last moved or opened for the first time; an old PDF has no map.

## Edits made elsewhere

- The editor remembers the modification time of the file it opened. If the file on disk is newer when you save, the save is rejected with HTTP 409 and the page says so. Reopen the file from the tree.
- The open file is polled every 3 seconds. When another program changes it, a banner offers to reload and compile.
- The check compares modification times, so two writes within the same timestamp tick are not told apart.

## Tests

```sh
node --test test/synctex.test.js test/start_stop.test.js
```

`start_stop.test.js` starts a real server on a free local port in a temporary folder and compiles small documents; the compile tests are skipped when `lualatex` is not found on `PATH`. `synctex.test.js` builds its fixture with `lualatex`, so all of its tests are skipped in that case.

## Limits

- One user, local use only: no authentication, binds to `127.0.0.1`.
- The server uses synchronous file I/O, so a very large file or a very deep tree can make it pause briefly.
- Compiles are queued one at a time, with a 180-second timeout.

## Bundled libraries

- Editor: CodeMirror 5 (MIT License, © Marijn Haverbeke and others). License text: `vendor/LICENSE`.
- PDF preview: PDF.js 4.10.38 (Apache License 2.0, Mozilla Foundation). License text: `vendor/LICENSE_pdfjs`.

## Notes

- Written with AI coding assistance.

## License

MIT for the code in this repository outside `vendor/`. See [LICENSE](LICENSE). The bundled libraries keep their own licenses, listed above.
