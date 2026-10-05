"use strict";

const assert = require("node:assert/strict");
const { after, before, test: nodeTest } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { synctexEdit, synctexForward } = require("../synctex");

// PATH の lualatex を使う。無ければ、このファイルのテストはすべて飛ばす（フィクスチャを作れないため）
const LUALATEX = "lualatex";
const HAS_LUALATEX = spawnSync(LUALATEX, ["--version"], { stdio: "ignore" }).status === 0;
const test = (name, fn) => nodeTest(name, { skip: HAS_LUALATEX ? false : "lualatex が無い" }, fn);
const SOURCE = String.raw`\documentclass{article}
\begin{document}
Hello world one
\section{Sec}
Line five here
\end{document}
`;
const SAMPLES = [
  { name: "Hello world one", x: 182.75, y: 130.6, line: 3 },
  { name: "Sec", x: 167.95, y: 161.65, line: 4 },
  { name: "Line five here", x: 163.2, y: 185.35, line: 5 },
];
// メイン側が PyMuPDF で独立に実測した y 範囲（A4・原点左上・上下 6pt の余裕を見る）
const FORWARD_SAMPLES = [
  { name: "Hello world one", line: 3, yMin: 123.5, yMax: 137.7 },
  { name: "Sec", line: 4, yMin: 151.4, yMax: 171.9 },
  { name: "Line five here", line: 5, yMin: 178.3, yMax: 192.4 },
];
const Y_TOLERANCE = 6;
const forcedY = process.env.SYNCTEX_TEST_Y === undefined ? null : Number(process.env.SYNCTEX_TEST_Y);

let fixtureDir;
let gzPath;
let texPath;

before(() => {
  if (!HAS_LUALATEX) return;
  const tempRoot = process.platform === "win32" ? "C:\\texlive\\tmp" : os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  // フォルダ名に日本語を入れる: macOS の lualatex は Input: を NFD で書くので、
  // NFC の texPath と突き合わせられるかを毎回の前方検索テストで踏ませる
  // realpath にするのは macOS の os.tmpdir() が /var → /private/var のシンボリックリンクで、
  // lualatex が Input: に書く実パスと比較が外れるため
  fixtureDir = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, "synctex-test-アプリ-")));
  texPath = path.join(fixtureDir, "fixture.tex");
  fs.writeFileSync(texPath, SOURCE, "utf8");
  const result = spawnSync(LUALATEX, ["--synctex=1", "-interaction=nonstopmode", "fixture.tex"], {
    cwd: fixtureDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(fs.existsSync(path.join(fixtureDir, "fixture.pdf")), "fixture.pdf が生成されませんでした");
  gzPath = path.join(fixtureDir, "fixture.synctex.gz");
  assert.ok(fs.existsSync(gzPath), "fixture.synctex.gz が生成されませんでした");
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

for (const sample of SAMPLES) {
  test(`${sample.name} の中心座標は ${sample.line} 行を返す`, () => {
    const result = synctexEdit(gzPath, 1, sample.x, forcedY === null ? sample.y : forcedY);
    assert.equal(result && result.line, sample.line);
  });
}

test("存在しないページは null を返す", () => {
  assert.equal(synctexEdit(gzPath, 999, 100, 100), null);
});

test("存在しない gz パスは null を返す", () => {
  assert.equal(synctexEdit(path.join(fixtureDir, "missing.synctex.gz"), 1, 100, 100), null);
});

for (const sample of FORWARD_SAMPLES) {
  test(`前方検索: ${sample.line} 行は ${sample.name} の位置を返す`, () => {
    const result = synctexForward(gzPath, texPath, sample.line);
    assert.ok(result, `${sample.line} 行の結果が null です`);
    assert.equal(result.page, 1);
    assert.ok(Number.isFinite(result.x), `x が有限数ではありません: ${result.x}`);
    assert.ok(
      result.y >= sample.yMin - Y_TOLERANCE && result.y <= sample.yMax + Y_TOLERANCE,
      `y=${result.y} が ${sample.yMin - Y_TOLERANCE}〜${sample.yMax + Y_TOLERANCE} の範囲外です`,
    );
  });
}

for (const sample of FORWARD_SAMPLES) {
  test(`前方検索 → 逆引きの往復で ${sample.line} 行に戻る`, () => {
    const forward = synctexForward(gzPath, texPath, sample.line);
    assert.ok(forward, `${sample.line} 行の結果が null です`);
    const back = synctexEdit(gzPath, forward.page, forward.x, forward.y);
    assert.equal(back && back.line, sample.line);
  });
}

test("前方検索: 存在しない行番号は null を返す", () => {
  assert.equal(synctexForward(gzPath, texPath, 999), null);
});

test("前方検索: Input に無い .tex パスは null を返す", () => {
  assert.equal(synctexForward(gzPath, path.join(fixtureDir, "other.tex"), 3), null);
});

test("前方検索: 存在しない gz パスは null を返す", () => {
  assert.equal(synctexForward(path.join(fixtureDir, "missing.synctex.gz"), texPath, 3), null);
});

// macOS の lualatex は、クラウド同期のフォルダ（File Provider）配下では Input: を NFD（濁点分離）で書く。
// temp は APFS 直下で NFC のまま出るため、ここでは .synctex.gz の Input: を NFD に書き換えて再現する
// （揃えないと、逆引きが「編集対象の .tex ではありません」になり、前方検索が null になる）。
test("Input: が NFD でも逆引きは NFC の file を返し、前方検索は NFC の texPath で引ける", () => {
  const zlib = require("node:zlib");
  const raw = zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf8");
  const nfdRaw = raw.replace(/^Input:1:(.*)$/m, (m, p) => "Input:1:" + p.normalize("NFD"));
  assert.notEqual(nfdRaw, raw, "フィクスチャのパスに NFD で変わる文字が含まれていません");
  const nfdGz = path.join(fixtureDir, "fixture-nfd.synctex.gz");
  fs.writeFileSync(nfdGz, zlib.gzipSync(Buffer.from(nfdRaw, "utf8")));

  const back = synctexEdit(nfdGz, 1, SAMPLES[0].x, SAMPLES[0].y);
  assert.ok(back, "逆引きの結果が null です");
  assert.equal(back.file, back.file.normalize("NFC"), "file が NFC ではありません");
  assert.equal(path.resolve(back.file), path.resolve(texPath));

  const forward = synctexForward(nfdGz, texPath, 3);
  assert.ok(forward, "NFC の texPath で前方検索が null になりました");
  assert.equal(forward.page, 1);
});
