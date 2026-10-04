"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SP_PER_BP = 65781.76;
const RECORD_TYPES = new Set(["[", "(", "h", "v", "x", "k", "g", "$", "r"]);
const CONTAINER_TYPES = new Set(["[", "("]);
// 実際に組まれた素材（文字列・罫線・数式）を指すレコード。g（グルー）・k（カーン）は間隔だけ
const MATERIAL_TYPES = new Set(["h", "v", "x", "$", "r"]);
const RECORD_RE = /^(.)(-?\d+),(-?\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/;

function boxFor(record) {
  if (!record.hasBox) return null;
  const left = Math.min(record.x, record.x + record.width);
  const right = Math.max(record.x, record.x + record.width);
  const top = Math.min(record.y - record.height, record.y + record.depth);
  const bottom = Math.max(record.y - record.height, record.y + record.depth);
  return { left, right, top, bottom };
}

function distanceToRecord(record, x, y) {
  const box = boxFor(record);
  if (!box) {
    const dx = x - record.x;
    const dy = y - record.y;
    return dx * dx + 4 * dy * dy;
  }
  const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
  const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
  return dx * dx + 4 * dy * dy;
}

function containsPoint(record, x, y) {
  const box = boxFor(record);
  return Boolean(box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
}

function boxArea(record) {
  const box = boxFor(record);
  return box ? (box.right - box.left) * (box.bottom - box.top) : Infinity;
}

// .synctex.gz を展開してレコードを読む。onlyPage が数値ならそのページのみ、null なら全ページ。
// synctexEdit（逆引き）と synctexForward（前方検索）で共有する。
function readSynctexRecords(gzPath, onlyPage) {
  const lines = zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8").split(/\r?\n/);
  const inputs = new Map();
  const records = [];
  let inContent = false;
  let currentPage = null;

  for (const text of lines) {
    if (!inContent) {
      const input = /^Input:(\d+):(.*)$/.exec(text);
      if (input) {
        // macOS の lualatex は Input: を NFD（濁点分離）で書く。Dropbox の File Provider 領域は
        // NFD のパスで realpath が ENOENT になるため、読み取った時点で NFC に揃える。
        inputs.set(Number(input[1]), input[2].normalize("NFC"));
        continue;
      }
      if (text === "Content:") inContent = true;
      continue;
    }

    const pageStart = /^\{(\d+)\s*$/.exec(text);
    if (pageStart) {
      currentPage = Number(pageStart[1]);
      continue;
    }
    if (/^\}\d+\s*$/.test(text)) {
      currentPage = null;
      continue;
    }
    if (currentPage === null) continue;
    if (onlyPage !== null && currentPage !== onlyPage) continue;

    const match = RECORD_RE.exec(text);
    if (!match || !RECORD_TYPES.has(match[1])) continue;
    const inputTag = Number(match[2]);
    const line = Number(match[3]);
    const file = inputs.get(inputTag);
    if (!file || !Number.isInteger(line) || line < 1) continue;

    const horizontal = Number(match[4]);
    const vertical = Number(match[5]);
    const hasBox = match[6] !== undefined;
    const width = hasBox ? Number(match[6]) : 0;
    const height = hasBox ? Number(match[7]) : 0;
    const depth = hasBox ? Number(match[8]) : 0;
    if (![horizontal, vertical, width, height, depth].every(Number.isFinite)) continue;

    records.push({
      type: match[1],
      page: currentPage,
      file,
      line,
      x: horizontal / SP_PER_BP,
      y: vertical / SP_PER_BP,
      width: width / SP_PER_BP,
      height: height / SP_PER_BP,
      depth: depth / SP_PER_BP,
      hasBox,
    });
  }

  return records;
}

function synctexEdit(gzPath, page, x, y) {
  try {
    if (!Number.isInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const records = readSynctexRecords(gzPath, page);

    if (!records.length) return null;
    const candidates = records.some((record) => !CONTAINER_TYPES.has(record.type))
      ? records.filter((record) => !CONTAINER_TYPES.has(record.type))
      : records;

    let bestInside = null;
    let bestInsideArea = Infinity;
    for (const record of candidates) {
      if (!containsPoint(record, x, y)) continue;
      const area = boxArea(record);
      if (area < bestInsideArea) {
        bestInside = record;
        bestInsideArea = area;
      }
    }
    if (bestInside) return { file: bestInside.file, line: bestInside.line };

    let nearest = null;
    let nearestDistance = Infinity;
    for (const record of candidates) {
      const distance = distanceToRecord(record, x, y);
      if (distance < nearestDistance) {
        nearest = record;
        nearestDistance = distance;
      }
    }
    return nearest ? { file: nearest.file, line: nearest.line } : null;
  } catch {
    return null;
  }
}

// Input: のパスと .tex の実パスを突き合わせるための正規化。
// 実サンプルには小文字ドライブ（c:/texlive/...）と ./ 混じり（.../01_場合の数/./001_集合.tex）が出る。
// 相対パスは .synctex.gz の置き場所（＝コンパイル時の出力先）を基準に絶対化する。
function normalizeTexPath(value, baseDir) {
  // macOS の lualatex は Input: を NFD で書く。エディタ側のパスは NFC なので揃えないと一致しない。
  const unified = String(value).normalize("NFC").replace(/\\/g, "/");
  const absolute = path.isAbsolute(unified) ? path.resolve(unified) : path.resolve(baseDir, unified);
  const slashed = absolute.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

// .tex の行数。読めなければ null（行番号の上限チェックを省く）
function countTexLines(texPath) {
  try {
    const lines = fs.readFileSync(texPath, "utf8").split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.length;
  } catch {
    return null;
  }
}

// 前方検索: .tex の行番号 → PDF 上の位置
// 戻り値 { page, x, y, width, height }（bp・原点はページ左上、y は下向きが正）または null
function synctexForward(gzPath, texPath, line) {
  try {
    if (typeof texPath !== "string" || !texPath || !Number.isInteger(line) || line < 1) return null;

    // .tex に存在しない行番号は「行以降で最も近いレコード」を探しに行かず null
    const totalLines = countTexLines(texPath);
    if (totalLines !== null && line > totalLines) return null;

    const records = readSynctexRecords(gzPath, null);
    if (!records.length) return null;

    const baseDir = path.dirname(path.resolve(gzPath));
    const wanted = normalizeTexPath(texPath, process.cwd());
    const cache = new Map();
    const matched = records.filter((record) => {
      let normalized = cache.get(record.file);
      if (normalized === undefined) {
        normalized = normalizeTexPath(record.file, baseDir);
        cache.set(record.file, normalized);
      }
      return normalized === wanted;
    });
    if (!matched.length) return null;

    // 指定行にレコードが無いのは普通（空行・\begin{document} 等）。
    // まず「その行以降で最も近い行」、無ければ「その行以前で最も近い行」を採る。
    let candidates = matched.filter((record) => record.line === line);
    if (!candidates.length) {
      const after = matched.filter((record) => record.line > line);
      if (after.length) {
        const nearest = Math.min(...after.map((record) => record.line));
        candidates = after.filter((record) => record.line === nearest);
      } else {
        const nearest = Math.max(...matched.map((record) => record.line));
        candidates = matched.filter((record) => record.line === nearest);
      }
    }
    if (!candidates.length) return null;

    // 段落を閉じる行（\section 等）には、直前の段落の末尾を指すコンテナ・グルーが同じ行番号で付く。
    // それを掴まないよう、素材レコード → 非コンテナ → 全部、の順に絞ってから選ぶ。
    const material = candidates.filter((record) => MATERIAL_TYPES.has(record.type));
    const nonContainer = candidates.filter((record) => !CONTAINER_TYPES.has(record.type));
    const chosen = material.length ? material : nonContainer.length ? nonContainer : candidates;

    // ページ番号が最小・その中で y が最小（ページ内で最も上）のものを選ぶ
    chosen.sort((a, b) => a.page - b.page || a.y - b.y);
    const best = chosen[0];
    return {
      page: best.page,
      x: best.x,
      y: best.y,
      width: best.hasBox ? best.width : 0,
      height: best.hasBox ? best.height : 0,
    };
  } catch {
    return null;
  }
}

module.exports = { synctexEdit, synctexForward };
