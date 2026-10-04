// 実サーバーを空きポートで起動して確かめる統合テスト（localhost への bind と fetch、macOS / Linux では lsof を使う）。
// node --test test/start_stop.test.js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const { after, before, test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const HERE = path.resolve(__dirname, "..");
const START = path.join(HERE, "start.js");
const STOP = path.join(HERE, "stop.js");
// Win は固定パス・Mac は TeX Live の標準リンク（どちらも無ければ PATH の lualatex）
const LUALATEX = [
  "C:\\texlive\\2025\\bin\\windows\\lualatex.exe",
  "/Library/TeX/texbin/lualatex",
].find((p) => fs.existsSync(p)) || "lualatex";
const HAS_LUALATEX = spawnSync(LUALATEX, ["--version"], { stdio: "ignore" }).status === 0;

let port;
let occupiedPort;
let dummy;
let work;
let texRoot;
let buildDir;

async function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: work });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const chosen = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(chosen)));
    });
  });
}

async function health(target) {
  const response = await fetch(`http://127.0.0.1:${target}/health`);
  return response.json();
}

async function post(urlPath, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: "POST", body: JSON.stringify(payload) });
  return { status: response.status, body: await response.json() };
}

function listenerPid(target) {
  const result = spawnSync("lsof", ["-nP", `-tiTCP:${target}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return String(result.stdout || "").trim();
}

function startArgs(target) {
  return ["--port", String(target), "--root", texRoot, "--build", buildDir, "--engine", LUALATEX, "--no-open"];
}

before(async () => {
  // realpath にするのは、macOS の os.tmpdir() が /var → /private/var のシンボリックリンクのため
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "latex-editor-test-")));
  texRoot = path.join(work, "tex");
  buildDir = path.join(work, "build");
  fs.mkdirSync(path.join(texRoot, "sub"), { recursive: true });
  fs.writeFileSync(path.join(texRoot, "top.tex"), "\\documentclass{article}\n\\begin{document}\ntop\n\\end{document}\n");
  fs.writeFileSync(path.join(texRoot, "sub", "sample.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  fs.writeFileSync(path.join(texRoot, "sub", "broken.tex"), "\\documentclass{article}\n\\begin{document}\n\\undefinedcommand\n\\end{document}\n");
  fs.writeFileSync(path.join(texRoot, "sub", "ignored.png"), "x");

  port = await freePort();
  occupiedPort = await freePort();
  dummy = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":false}');
  });
  await new Promise((resolve, reject) => {
    dummy.once("error", reject);
    dummy.listen(occupiedPort, "127.0.0.1", resolve);
  });
});

after(async () => {
  await run(STOP, ["--port", String(port)]);
  await new Promise((resolve) => dummy.close(resolve));
  fs.rmSync(work, { recursive: true, force: true });
});

test("起動", { timeout: 30000 }, async () => {
  const result = await run(START, startArgs(port));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /サーバーを起動しました/);
  const body = await health(port);
  assert.equal(body.ok, true);
  assert.equal(body.texRoot, texRoot);
});

test("許可していない vendor ファイルは配信しない", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/vendor/xterm.js`);
  assert.equal(response.status, 404);
});

test("tree は .tex 類だけを返し、rel は OS を問わず / 区切り", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/tree`);
  const body = await response.json();
  assert.equal(body.ok, true);
  const rels = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.type === "dir") walk(node.children);
      else rels.push(node.rel);
    }
  };
  walk(body.tree);
  assert.deepEqual(rels.sort(), ["sub/broken.tex", "sub/sample.tex", "top.tex"]);
});

test("編集フォルダの外は読めない・書けない", async () => {
  const read = await fetch(`http://127.0.0.1:${port}/api/file?path=${encodeURIComponent("../build/x.tex")}`);
  assert.notEqual(read.status, 200);
  const save = await post("/api/save", { path: "../outside.tex", content: "x" });
  assert.equal(save.status, 400);
  assert.equal(fs.existsSync(path.join(work, "outside.tex")), false);
});

test("保存すると PDF と SyncTeX が出力先にだけ出る", { timeout: 120000 }, async (t) => {
  if (!HAS_LUALATEX) return t.skip("lualatex が無い");
  const stat = await (await fetch(`http://127.0.0.1:${port}/api/stat?path=${encodeURIComponent("sub/sample.tex")}`)).json();
  const saved = await post("/api/save", {
    path: "sub/sample.tex",
    content: "\\documentclass{article}\n\\begin{document}\nHello again\n\\end{document}\n",
    baseMtimeMs: stat.mtimeMs,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.compile.ok, true, saved.body.compile.log);
  const pdf = await fetch(`http://127.0.0.1:${port}${saved.body.compile.pdf}`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
  assert.equal(fs.existsSync(path.join(buildDir, "sub", "sample.synctex.gz")), true);
  // 編集フォルダには副産物を書かない
  assert.deepEqual(fs.readdirSync(path.join(texRoot, "sub")).sort(), ["broken.tex", "ignored.png", "sample.tex"]);

  // 古い基準時刻での保存は、他で更新されたものとして断る
  const stale = await post("/api/save", { path: "sub/sample.tex", content: "x", baseMtimeMs: stat.mtimeMs });
  assert.equal(stale.status, 409);
});

test("コンパイルに失敗したら、失敗として返す（前回の PDF を成功に見せない）", { timeout: 120000 }, async (t) => {
  if (!HAS_LUALATEX) return t.skip("lualatex が無い");
  const result = await post("/api/compile", { path: "sub/broken.tex" });
  assert.equal(result.status, 200);
  assert.equal(result.body.compile.ok, false);
  assert.equal(result.body.compile.pdf, null);
  assert.match(result.body.compile.log, /Undefined control sequence/);
});

test("再実行は冪等", { timeout: 30000 }, async (t) => {
  if (process.platform === "win32") return t.skip("win32 では lsof が無いため PID 同一性を確認しない");
  const beforePid = listenerPid(port);
  const result = await run(START, startArgs(port));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /既に稼働中です/);
  assert.equal(listenerPid(port), beforePid);
});

test("停止", { timeout: 30000 }, async () => {
  const result = await run(STOP, ["--port", String(port)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /エディタを閉じました/);
  await assert.rejects(health(port));
});

test("未起動で停止", { timeout: 30000 }, async () => {
  const result = await run(STOP, ["--port", String(port)]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /起動していません/);
});

test("ネガティブ制御 A（他人のポートを止めない）", { timeout: 30000 }, async () => {
  const result = await run(STOP, ["--port", String(occupiedPort)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /止めません/);
  assert.equal((await health(occupiedPort)).ok, false);
});

test("ネガティブ制御 B（起動できないときは失敗で終わる）", { timeout: 30000 }, async () => {
  const result = await run(START, startArgs(occupiedPort));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /起動に失敗/);
});

test("サーバーの引数の誤りは終了コード 2", () => {
  const server = path.join(HERE, "server.js");
  const exit = (...args) => spawnSync(process.execPath, [server, ...args], { encoding: "utf8", timeout: 10000 }).status;
  assert.equal(exit("--bogus", "1"), 2);
  assert.equal(exit("--port", "abc"), 2);
  assert.equal(exit("--root", path.join(work, "no-such-dir")), 2);
  assert.equal(exit("--root", texRoot, "--build", path.join(texRoot, "out")), 2);
});
