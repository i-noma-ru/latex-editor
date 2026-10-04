#!/usr/bin/env node
// latex-editor server — Node 組み込みモジュールで動作
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");
const { synctexEdit, synctexForward } = require("./synctex");

// 使い方: node server.js [--port 8940] [--root <.tex のあるフォルダ>] [--build <PDF の出力先>] [--engine lualatex]
const USAGE = "使い方: node server.js [--port 8940] [--root <.tex のあるフォルダ>] [--build <PDF の出力先>] [--engine lualatex]";
const OPTIONS = (() => {
  const out = { port: "8940", root: process.cwd(), build: null, engine: "lualatex" };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !(key in out) || args[i + 1] === undefined) {
      console.error(USAGE);
      process.exit(2);
    }
    out[key] = args[i + 1];
  }
  return out;
})();
const PORT = parseInt(OPTIONS.port, 10);
const TEX_ROOT = path.resolve(OPTIONS.root).normalize("NFC");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`--port の値が不正です: ${OPTIONS.port}`);
  process.exit(2);
}
if (!fs.existsSync(TEX_ROOT) || !fs.statSync(TEX_ROOT).isDirectory()) {
  console.error(`--root のフォルダがありません: ${TEX_ROOT}`);
  process.exit(2);
}
// PDF と副産物は編集フォルダの外へ出す（.aux や .log を .tex の隣に散らさないため）。
// 既定は ~/.latex-editor/build/<フォルダ名>-<パスのハッシュ>/。
const BUILD_DIR = OPTIONS.build
  ? path.resolve(OPTIONS.build)
  : path.join(os.homedir(), ".latex-editor", "build",
      `${path.basename(TEX_ROOT)}-${crypto.createHash("sha1").update(TEX_ROOT).digest("hex").slice(0, 8)}`);
if (isWithinPath(TEX_ROOT, BUILD_DIR)) {
  console.error(`--build は編集フォルダの外を指定してください: ${BUILD_DIR}`);
  process.exit(2);
}
const COMPILE_JS = path.join(__dirname, "compile.js");

function isWithinPath(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

const VENDOR_WHITELIST = new Set([
  "codemirror.js",
  "codemirror.css",
  "stex.js",
  "comment.js",
  "pdf.min.mjs",
  "pdf.worker.min.mjs",
  "search.js",
  "searchcursor.js",
  "jump-to-line.js",
  "dialog.js",
  "dialog.css",
  "show-hint.js",
  "show-hint.css",
]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;
let compileQueue = Promise.resolve();

function isWithin(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

function normalizePathForComparison(value) {
  // macOS の lualatex は .synctex.gz に NFD（濁点分離）のパスを書き、__dirname 由来の TEX_ROOT は NFC。
  // 同じフォルダでも文字列が一致しないので、比較は NFC に揃えてから行う。
  const normalized = path.resolve(String(value).normalize("NFC")).replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinNormalized(root, target) {
  const normalizedRoot = normalizePathForComparison(root);
  const normalizedTarget = normalizePathForComparison(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + "/");
}

// 相対パスを TEX_ROOT 配下の絶対パスに解決。外れたら null（呼び出し側で 400）
function safeResolve(rel, forNewFile = false) {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  const abs = path.resolve(TEX_ROOT, rel);
  if (!isWithin(TEX_ROOT, abs)) return null;

  try {
    const realTexRoot = fs.realpathSync(TEX_ROOT);
    let targetExists = false;
    try {
      fs.lstatSync(abs);
      targetExists = true;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return null;
    }

    if (targetExists) {
      if (!isWithin(realTexRoot, fs.realpathSync(abs))) return null;
    } else if (forNewFile) {
      if (!isWithin(realTexRoot, fs.realpathSync(path.dirname(abs)))) return null;
    }
  } catch {
    return null;
  }

  return abs;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, res, cb) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      sendJson(res, 413, { ok: false, reason: "too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!tooLarge) cb(Buffer.concat(chunks).toString("utf8"));
  });
}

function listDir(abs) {
  const out = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
    const child = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      out.push({ name: ent.name, type: "dir", children: listDir(child) });
    } else if (/\.(tex|sty|cls|md|txt)$/i.test(ent.name)) {
      // /api/synctex-edit の rel と同じ区切りに揃える（Win で \ のままだとツリーの is-open が外れる）
      out.push({ name: ent.name, type: "file", rel: path.relative(TEX_ROOT, child).replace(/\\/g, "/") });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "ja");
  });
  return out;
}

function handleTree(res) {
  sendJson(res, 200, { ok: true, tree: listDir(TEX_ROOT) });
}

function handleRead(u, res) {
  const abs = safeResolve(u.searchParams.get("path"));
  if (!abs || !/\.(tex|sty|cls|md|txt)$/i.test(abs)) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }
  if (!fs.existsSync(abs)) return sendJson(res, 404, { ok: false, reason: "not found" });
  const st = fs.statSync(abs);
  if (!st.isFile()) return sendJson(res, 404, { ok: false, reason: "not found" });
  sendJson(res, 200, {
    ok: true,
    content: fs.readFileSync(abs, "utf8"),
    mtimeMs: st.mtimeMs,
  });
}


function handleSave(body, res) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }

  const abs = safeResolve(j.path, true);
  if (!abs || !/\.(tex|sty|cls)$/i.test(abs) || typeof j.content !== "string") {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }

  // 競合検出: ディスクの mtime がクライアントの基準値と違えば拒否する。
  if (fs.existsSync(abs)) {
    const disk = fs.statSync(abs).mtimeMs;
    if (typeof j.baseMtimeMs !== "number" || Math.abs(disk - j.baseMtimeMs) > 1) {
      return sendJson(res, 409, { ok: false, reason: "conflict", diskMtimeMs: disk });
    }
  }

  fs.writeFileSync(abs, j.content, "utf8");
  const newMtime = fs.statSync(abs).mtimeMs;
  if (!/\.tex$/i.test(abs)) {
    return sendJson(res, 200, { ok: true, mtimeMs: newMtime, compile: null });
  }

  enqueueCompile(abs, newMtime, res);
}

function enqueueCompile(abs, newMtime, res) {
  const runCompile = () =>
    new Promise((resolve) => {
      try {
        // 出力先は相対フォルダをミラーし、編集フォルダに副産物を書かない。
        const relDir = path.dirname(path.relative(TEX_ROOT, abs));
        const destDir = path.join(BUILD_DIR, relDir);
        fs.mkdirSync(destDir, { recursive: true });

        let proc;
        try {
          proc = spawn(process.execPath, [COMPILE_JS, abs, "--dest", destDir, "--engine", OPTIONS.engine], {
            cwd: TEX_ROOT,
            timeout: 180000,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          sendJson(res, 200, {
            ok: true,
            mtimeMs: newMtime,
            compile: { ok: false, log: String(error), pdf: null },
          });
          resolve();
          return;
        }

        let log = "";
        let responded = false;
        const finish = (code) => {
          if (responded) return;
          responded = true;
          if (code === null) log += "\ntimeout (180s)";
          const pdfRel = path.join(relDir, path.basename(abs).replace(/\.tex$/i, ".pdf"));
          const okPdf = code === 0 && fs.existsSync(path.join(BUILD_DIR, pdfRel));
          sendJson(res, 200, {
            ok: true,
            mtimeMs: newMtime,
            compile: {
              ok: okPdf,
              log: log.split("\n").slice(-40).join("\n"),
              pdf: okPdf ? "/api/pdf?path=" + encodeURIComponent(pdfRel) : null,
            },
          });
          resolve();
        };

        proc.stdout.on("data", (data) => {
          log += data;
        });
        proc.stderr.on("data", (data) => {
          log += data;
        });
        proc.on("error", (error) => {
          log += String(error);
          finish(-1);
        });
        proc.on("close", finish);
      } catch (error) {
        sendJson(res, 500, { ok: false, reason: String(error) });
        resolve();
      }
    });

  compileQueue = compileQueue.then(runCompile, runCompile);
}

function handlePdf(u, res) {
  // BUILD_DIR 配下限定の前方一致ガード（safeResolve と同型・ルートだけ違う）
  const rel = u.searchParams.get("path") || "";
  const abs = path.resolve(BUILD_DIR, rel);
  if (
    !abs.startsWith(BUILD_DIR + path.sep) ||
    !abs.endsWith(".pdf") ||
    !fs.existsSync(abs) ||
    !fs.statSync(abs).isFile()
  ) {
    return sendJson(res, 404, { ok: false, reason: "not found" });
  }
  try {
    const realBuildDir = fs.realpathSync(BUILD_DIR);
    const realAbs = fs.realpathSync(abs);
    if (!isWithin(realBuildDir, realAbs)) {
      return sendJson(res, 404, { ok: false, reason: "not found" });
    }
  } catch {
    return sendJson(res, 404, { ok: false, reason: "not found" });
  }
  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Cache-Control": "no-store",
  });
  res.end(fs.readFileSync(abs));
}

function handleSynctexEdit(body, res) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }

  const pdfRel = j.pdf;
  if (
    typeof pdfRel !== "string" ||
    pdfRel.includes("\0") ||
    path.isAbsolute(pdfRel) ||
    pdfRel.split(/[\\/]+/).includes("..") ||
    !/\.pdf$/i.test(pdfRel) ||
    !Number.isInteger(j.page) ||
    j.page < 1 ||
    !Number.isFinite(j.x) ||
    !Number.isFinite(j.y)
  ) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }

  const pdfAbs = path.resolve(BUILD_DIR, pdfRel);
  if (!isWithinNormalized(BUILD_DIR, pdfAbs)) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }
  const synctexAbs = pdfAbs.replace(/\.pdf$/i, ".synctex.gz");
  if (!fs.existsSync(synctexAbs) || !fs.statSync(synctexAbs).isFile()) {
    return sendJson(res, 200, {
      ok: false,
      reason: "SyncTeX 情報がありません。一度保存してコンパイルし直してください",
    });
  }

  try {
    const realBuildDir = fs.realpathSync(BUILD_DIR);
    const realSynctex = fs.realpathSync(synctexAbs);
    if (!isWithinNormalized(realBuildDir, realSynctex)) {
      return sendJson(res, 400, { ok: false, reason: "bad path" });
    }
  } catch {
    return sendJson(res, 200, {
      ok: false,
      reason: "SyncTeX 情報がありません。一度保存してコンパイルし直してください",
    });
  }

  const target = synctexEdit(synctexAbs, j.page, j.x, j.y);
  if (!target) {
    return sendJson(res, 200, { ok: false, reason: "該当する SyncTeX 情報が見つかりません" });
  }

  const sourceAbs = path.resolve(target.file);
  if (!/\.tex$/i.test(sourceAbs) || !isWithinNormalized(TEX_ROOT, sourceAbs)) {
    return sendJson(res, 200, { ok: false, reason: "該当箇所は編集対象の .tex ファイルではありません" });
  }
  try {
    const realTexRoot = fs.realpathSync(TEX_ROOT);
    const realSource = fs.realpathSync(sourceAbs);
    if (!isWithinNormalized(realTexRoot, realSource)) {
      return sendJson(res, 200, { ok: false, reason: "該当箇所は編集対象の .tex ファイルではありません" });
    }
    return sendJson(res, 200, {
      ok: true,
      rel: path.relative(realTexRoot, realSource).replace(/\\/g, "/"),
      line: target.line,
    });
  } catch {
    return sendJson(res, 200, { ok: false, reason: "該当箇所は編集対象の .tex ファイルではありません" });
  }
}

function handleSynctexForward(body, res) {
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) {
    return sendJson(res, 400, { ok: false, reason: "bad json" });
  }

  const pdfRel = j.pdf;
  if (
    typeof pdfRel !== "string" ||
    pdfRel.includes("\0") ||
    path.isAbsolute(pdfRel) ||
    pdfRel.split(/[\\/]+/).includes("..") ||
    !/\.pdf$/i.test(pdfRel) ||
    !Number.isInteger(j.line) ||
    j.line < 1
  ) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }

  const texAbs = safeResolve(j.rel);
  if (!texAbs || !/\.tex$/i.test(texAbs) || !fs.existsSync(texAbs) || !fs.statSync(texAbs).isFile()) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }

  const pdfAbs = path.resolve(BUILD_DIR, pdfRel);
  if (!isWithinNormalized(BUILD_DIR, pdfAbs)) {
    return sendJson(res, 400, { ok: false, reason: "bad path" });
  }
  const synctexAbs = pdfAbs.replace(/\.pdf$/i, ".synctex.gz");
  if (!fs.existsSync(synctexAbs) || !fs.statSync(synctexAbs).isFile()) {
    return sendJson(res, 200, {
      ok: false,
      reason: "SyncTeX 情報がありません。一度保存してコンパイルし直してください",
    });
  }

  try {
    const realBuildDir = fs.realpathSync(BUILD_DIR);
    const realSynctex = fs.realpathSync(synctexAbs);
    if (!isWithinNormalized(realBuildDir, realSynctex)) {
      return sendJson(res, 400, { ok: false, reason: "bad path" });
    }
  } catch {
    return sendJson(res, 200, {
      ok: false,
      reason: "SyncTeX 情報がありません。一度保存してコンパイルし直してください",
    });
  }

  const target = synctexForward(synctexAbs, texAbs, j.line);
  if (!target) {
    return sendJson(res, 200, { ok: false, reason: "該当する SyncTeX 情報が見つかりません" });
  }
  return sendJson(res, 200, {
    ok: true,
    page: target.page,
    x: target.x,
    y: target.y,
    width: target.width,
    height: target.height,
  });
}

const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${PORT}` && req.headers.host !== `localhost:${PORT}`) {
    return sendJson(res, 403, { ok: false, reason: "forbidden host" });
  }
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      // no-store: 更新後にブラウザが古い index.html を使い続けないようにする
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
    } else if (req.method === "GET" && u.pathname.startsWith("/vendor/")) {
      const name = path.basename(u.pathname);
      if (!VENDOR_WHITELIST.has(name)) return sendJson(res, 404, { ok: false });
      const mime = name.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "Content-Type": mime + "; charset=utf-8", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(path.join(__dirname, "vendor", name)));
    } else if (req.method === "GET" && u.pathname === "/health") {
      sendJson(res, 200, { ok: true, texRoot: TEX_ROOT });
    } else if (req.method === "GET" && u.pathname === "/api/tree") {
      handleTree(res);
    } else if (req.method === "GET" && u.pathname === "/api/file") {
      handleRead(u, res);
    } else if (req.method === "POST" && u.pathname === "/api/save") {
      readBody(req, res, (body) => {
        try {
          handleSave(body, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: String(error) });
        }
      });
    } else if (req.method === "GET" && u.pathname === "/api/stat") {
      // 外部更新の検知用: 開いているファイルの mtime だけ返す（軽量ポーリング前提）
      const abs = safeResolve(u.searchParams.get("path"));
      if (!abs || !/\.(tex|sty|cls|md|txt)$/i.test(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return sendJson(res, 404, { ok: false, reason: "not found" });
      }
      sendJson(res, 200, { ok: true, mtimeMs: fs.statSync(abs).mtimeMs });
    } else if (req.method === "POST" && u.pathname === "/api/compile") {
      // 保存なしコンパイル（再読込ボタン用: 他所で更新されたファイルをそのままコンパイルする）
      readBody(req, res, (body) => {
        try {
          let j;
          try {
            j = JSON.parse(body);
          } catch {
            return sendJson(res, 400, { ok: false, reason: "bad json" });
          }
          const abs = safeResolve(j && j.path);
          if (!abs || !/\.tex$/i.test(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            return sendJson(res, 400, { ok: false, reason: "bad path" });
          }
          enqueueCompile(abs, fs.statSync(abs).mtimeMs, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: String(error) });
        }
      });
    } else if (req.method === "POST" && u.pathname === "/api/synctex-edit") {
      readBody(req, res, (body) => {
        try {
          handleSynctexEdit(body, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: String(error) });
        }
      });
    } else if (req.method === "POST" && u.pathname === "/api/synctex-forward") {
      readBody(req, res, (body) => {
        try {
          handleSynctexForward(body, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, reason: String(error) });
        }
      });
    } else if (req.method === "GET" && u.pathname === "/api/pdf") {
      handlePdf(u, res);
    } else {
      sendJson(res, 404, { ok: false, reason: "not found" });
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, reason: String(error) });
  }
});

process.on("SIGINT", () => {
  process.exit();
});

process.on("SIGTERM", () => {
  process.exit();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`latex-editor: http://127.0.0.1:${PORT} で待機中（Ctrl+C で終了）`);
  console.log(`編集フォルダ: ${TEX_ROOT}`);
  console.log(`PDF の出力先: ${BUILD_DIR}`);
});
