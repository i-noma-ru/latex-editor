#!/usr/bin/env node
// .tex を 1 本コンパイルし、PDF・SyncTeX・副産物を出力先フォルダへ出す。server.js が保存のたびに呼ぶ。
// 使い方: node compile.js <.tex の絶対パス> --dest <出力先フォルダ> [--engine lualatex]
// 終了コード: 0=PDF ができた / 1=コンパイル失敗 / 2=引数の誤り
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_RUNS = 3;
const RERUN = /Rerun to get|Label\(s\) may have changed|Rerun LaTeX/;

function main(args) {
  const tex = args[0];
  const options = { dest: null, engine: "lualatex" };
  for (let i = 1; i < args.length; i += 2) {
    const key = String(args[i]).replace(/^--/, "");
    if (!String(args[i]).startsWith("--") || !(key in options) || args[i + 1] === undefined) return usage();
    options[key] = args[i + 1];
  }
  if (!tex || tex.startsWith("--") || !options.dest) return usage();
  if (!path.isAbsolute(tex) || !/\.tex$/i.test(tex) || !fs.existsSync(tex)) {
    console.error(`.tex が見つかりません（絶対パスで指定してください）: ${tex}`);
    return 2;
  }

  const dest = path.resolve(options.dest);
  fs.mkdirSync(dest, { recursive: true });
  const name = path.basename(tex).replace(/\.tex$/i, "");
  const pdf = path.join(dest, name + ".pdf");
  const log = path.join(dest, name + ".log");
  // 前回の PDF が残っていると、失敗しても成功に見える。先に消す
  fs.rmSync(pdf, { force: true });

  for (let run = 1; run <= MAX_RUNS; run += 1) {
    console.log(`[${run}] ${options.engine} ${path.basename(tex)}`);
    const result = spawnSync(
      options.engine,
      ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "--synctex=1", `-output-directory=${dest}`, tex],
      // 相対パスの \input や画像を解決できるよう、.tex のあるフォルダで実行する
      { cwd: path.dirname(tex), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    if (result.error) {
      console.error(result.error.code === "ENOENT"
        ? `${options.engine} が見つかりません。TeX Live などを入れて PATH を通すか、--engine で実行ファイルを指定してください。`
        : `${options.engine} を実行できません: ${result.error.message}`);
      return 1;
    }
    const output = String(result.stdout || "") + String(result.stderr || "");
    if (result.status !== 0 || !fs.existsSync(pdf)) {
      // エラーの行（! や file:line:）とその前後だけを出す
      const lines = output.split(/\r?\n/);
      const at = lines.findIndex((line) => /^!|^[^\s:]+:\d+:/.test(line));
      console.error((at >= 0 ? lines.slice(Math.max(0, at - 2), at + 12) : lines.slice(-25)).join("\n"));
      console.error(`コンパイルに失敗しました（終了コード ${result.status}）。全文は ${log}`);
      return 1;
    }
    const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : output;
    if (!RERUN.test(logText)) break;
  }
  console.log(`OK: ${pdf}`);
  return 0;
}

function usage() {
  console.error("使い方: node compile.js <.tex の絶対パス> --dest <出力先フォルダ> [--engine lualatex]");
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
