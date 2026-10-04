#!/usr/bin/env node
// latex-editor を起動し、利用可能になったらブラウザで開く。止めるのは stop.js。
// 使い方: node start.js [--port 8940] [--root <.tex のあるフォルダ>] [--build <PDF の出力先>] [--engine lualatex] [--no-open]
// --no-open 以外の引数は server.js へそのまま渡す。--root を省くと、実行した場所が編集フォルダになる。
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "server.js");
const portIndex = process.argv.indexOf("--port");
const port = portIndex === -1 ? 8940 : parseInt(process.argv[portIndex + 1], 10);
const noOpen = process.argv.includes("--no-open");
const serverArgs = process.argv.slice(2).filter((arg) => arg !== "--no-open");
const url = `http://127.0.0.1:${port}`;

async function health() {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.status === 200 && body.ok === true ? body : null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser() {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      console.log(code === 0
        ? `ブラウザで開きました: ${url}`
        : `ブラウザを開けませんでした（終了コード ${code}）: ${url}`);
      resolve();
    };
    try {
      const child = spawn(command, args);
      child.on("error", () => finish(1));
      child.on("close", (code) => finish(code));
    } catch {
      finish(1);
    }
  });
}

function report(body) {
  console.log(`latex-editor: ${url}  texRoot=${body.texRoot}`);
}

async function main() {
  let body = await health();
  if (body) {
    console.log("既に稼働中です。");
    if (!noOpen) await openBrowser();
    report(body);
    return;
  }

  try {
    const child = spawn(process.execPath, [SERVER, ...serverArgs], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    console.error("サーバーの起動に失敗しました。");
    process.exitCode = 1;
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    body = await health();
    if (body) {
      console.log("サーバーを起動しました。");
      if (!noOpen) await openBrowser();
      report(body);
      return;
    }
  }

  console.error("サーバーの起動に失敗しました。");
  process.exitCode = 1;
}

main();
