# latex-editor

LaTeX をローカルで編集する Web エディタです。ファイルの一覧・エディタ・PDF のプレビューが、ブラウザの 1 画面に並びます。`.tex` を保存すると、手元の TeX でコンパイルして PDF を読み込み直します。すべて `127.0.0.1` で動き、外部へは何も送りません。

English: [README.md](README.md)

- サーバーは Node.js の組み込みモジュールだけで動きます。CodeMirror 5 と PDF.js を `vendor/` に同梱しているので、`npm install` なしで、オフラインで使えます。
- PDF と副産物（`.aux`・`.log`・`.synctex.gz`）は別の出力先フォルダへ出し、`.tex` の隣には書きません。同期しているフォルダや Git で管理しているフォルダを汚しません。
- SyncTeX に両方向で対応しています。PDF をクリックすると該当する行へ、キー操作でカーソルの行から PDF の位置へ飛びます。
- ほかの場所でファイルが書き換えられたことを検知し、上書きを断ります。

## 必要なもの

- Node.js 18 以降
- `lualatex` に PATH が通った TeX 環境（TeX Live など）。PDF を直接出す別のエンジン（`pdflatex`・`xelatex` など）は `--engine` で指定できます。
- **`uplatex` と `platex` には対応していません。** PDF ではなく DVI を出すので、毎回コンパイル失敗の扱いになります。

エディタ自体は、作者の環境の一部として macOS と Windows で使ってきました。単体で動くこの版（コンパイル処理 `compile.js` を新しく書いたもの）は、macOS でだけ確認しています。

## 起動

`.tex` を置いているフォルダで実行します。

```sh
node /path/to/latex-editor/start.js
```

`start.js` は、サーバーが動いていなければ切り離して起動し、応答するまで待ってから `http://127.0.0.1:8940` を開きます。止めるときは次を実行します。

```sh
node /path/to/latex-editor/stop.js
```

`stop.js` が止めるのは、このエディタのサーバーだけです。同じポートを別のプロセスが使っているときは、止めずに終了コード 1 で知らせます。

### 見本で試す

`examples/` に、日本語の小さな文書（`sample.tex`・クラスは `ltjsarticle`）と、その文書が使う命令を定義したスタイルファイル（`sample-style.sty`・同じフォルダ）があります。`luatexja` が必要です（TeX Live をフルで入れていれば入っています）。

```sh
node start.js --root examples
```

一覧の `sample.tex` をクリックして保存（`Cmd+S` / `Ctrl+S`）すると、右に PDF が出ます。

### オプション

| オプション | 意味 |
|---|---|
| `--port 8950` | ポート（既定 8940）。`stop.js` にも同じ値を渡します。 |
| `--root <フォルダ>` | 編集するフォルダ。既定は実行した場所です。 |
| `--build <フォルダ>` | PDF と副産物の出力先。`--root` の外を指定します。既定は `~/.latex-editor/build/<フォルダ名>-<ハッシュ>/` です。 |
| `--engine <コマンド>` | 実行する TeX エンジン（既定 `lualatex`）。`-interaction=nonstopmode -halt-on-error -file-line-error --synctex=1 -output-directory=<出力先>` を付けて呼びます。 |
| `--no-open` | ブラウザを開きません（`start.js` だけ）。 |

サーバーを前面で動かしてログを見るときは、同じオプションで `node server.js`（Ctrl+C で終了）。

## 編集

- 一覧に出るのは、編集フォルダ以下の `.tex`・`.sty`・`.cls`・`.md`・`.txt` です。隠しフォルダと `node_modules` は出しません。
- `.tex` を保存するとコンパイルします。ログが再実行を求めたときは、最大 3 回まで実行します。
- 出力先フォルダは、編集フォルダと同じフォルダ構成になります。コンパイルの前に、`.tex` のあるフォルダの下位フォルダを出力先にも作るので、`\include{chapters/ch1}` の `.aux` をそこへ書けます。
- BibTeX・biber・makeindex は実行しません。
- 補完候補の一部（`\dfrac`・`\text`・`\therefore`・`\mathbb` など）は、`amsmath` か `amssymb` が必要です。

### 別のフォルダにあるスタイルファイル

エンジンは `.tex` のあるフォルダで実行するので、同じフォルダの `.sty`・`.cls` は読み込まれます。別のフォルダに置いたものは見つかりません（エディタは検索パスを足しません）。読み込ませる方法は 2 つあります。

- 個人用の TeX ツリーに置く（場所は `kpsewhich -var-value TEXMFHOME` で分かります。MacTeX では `~/Library/texmf`、ほかではふつう `~/texmf` で、LaTeX のファイルはその下の `tex/latex/` に置きます）。
- 環境変数 `TEXINPUTS` を設定してからエディタを起動する（エンジンに引き継がれます）。末尾の区切り文字は、標準の検索先を残すためのものです: `TEXINPUTS=/path/to/styles//: node start.js`（Windows の区切り文字は `;`）。

`.sty`・`.cls` を保存してもコンパイルは走りません。それを使う `.tex` を保存してください。

| キー（Mac / Windows） | 動作 |
|---|---|
| `Cmd+S` / `Ctrl+S` | 保存してコンパイル |
| `Cmd+/` / `Ctrl+/` | カーソル行または選択範囲の `%` コメントを付け外し |
| `Ctrl+Space` | TeX コマンドの補完候補 |
| `Cmd+F` / `Ctrl+F` | 検索 |
| `Cmd+Option+F` / `Ctrl+Shift+F` | 置換 |
| `Alt+G` | 行ジャンプ |
| `Cmd+Alt+J` / `Ctrl+Alt+J` | カーソル行に対応する PDF の位置へ飛ぶ |
| PDF をクリック | 該当する行へ飛ぶ（別のファイルなら開いてから飛ぶ） |

SyncTeX は、ファイルを移したあとや初めて開いたあとに 1 回コンパイルするまで効きません。古い PDF には対応表が無いためです。

## ほかの場所での編集

- 開いた時点の更新時刻を覚えておき、保存のときにディスクの時刻と比べます。違っていれば保存を HTTP 409 で断り、画面に表示します。一覧から開き直してください。
- 開いているファイルを 3 秒ごとに確かめ、ほかのプログラムが書き換えたら、再読込してコンパイルするよう促すバナーを出します。
- 比べているのは更新時刻なので、同じ時刻の刻みの中で 2 回書かれた場合は見分けられません。

## テスト

```sh
node --test test/synctex.test.js test/start_stop.test.js
```

`start_stop.test.js` は、一時フォルダを編集フォルダにして、空いているローカルのポートで実際にサーバーを起動し、小さな文書をコンパイルします。PATH に `lualatex` が無いときは、コンパイルのテストを飛ばします。`synctex.test.js` は見本を `lualatex` で作るので、`lualatex` が無いときは全部のテストを飛ばします。

## 制約

- 1 人でローカルに使う前提です。認証は無く、bind は `127.0.0.1` だけです。
- サーバーは同期 I/O なので、とても大きなファイルや深いフォルダでは、一時的に応答が止まることがあります。
- コンパイルは 1 件ずつ順に行い、上限は 180 秒です。

## 同梱ライブラリ

- エディタ: [CodeMirror 5](https://codemirror.net/5/) 5.65.16（[ソース](https://github.com/codemirror/codemirror5)・MIT License・© Marijn Haverbeke and others）。ライセンス本文は [`vendor/LICENSE`](vendor/LICENSE)。
- PDF プレビュー: [PDF.js](https://mozilla.github.io/pdf.js/) 4.10.38（[ソース](https://github.com/mozilla/pdf.js)・Apache License 2.0・Mozilla Foundation）。ライセンス本文は [`vendor/LICENSE_pdfjs`](vendor/LICENSE_pdfjs)。

## 補足

- AI のコーディング支援を受けて書いています。

## ライセンス

`vendor/` 以外のコードは MIT です。[LICENSE](LICENSE) を参照してください。同梱ライブラリは、上記のそれぞれのライセンスのままです。
