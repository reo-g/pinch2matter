/**
 * pinch2matter — Apple Watch ダブルタップ(指パッチン)で Matter 照明を制御するための
 * matter.js ベースの仮想 Matter デバイス。
 *
 * 2 つのモードを `PINCH2MATTER_MODE` で切り替え可能:
 *   - switch (デフォルト): Generic Switch (Momentary)。ボタンプレスイベントで自動化発火
 *   - bulb:               OnOff Light。状態 ON/OFF を持つ仮想電球
 *
 * 共通フロー:
 *   Apple Watch (ダブルタップ)
 *     → iOS ショートカット (HTTP POST)
 *     → このサーバの POST /press
 *     → matter.js が対応する Matter イベント/属性変化を発火
 *     → Apple Home の自動化が実電球を操作 (※ 自動化実行には Apple Home Hub 必須)
 */

import { Endpoint, Environment, ServerNode } from "@matter/main";
import { GenericSwitchDevice } from "@matter/main/devices/generic-switch";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { SwitchServer } from "@matter/main/behaviors/switch";
import express from "express";
import QRCode from "qrcode";
import { rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";

// "switch" (Generic Switch / 押しボタン) または "bulb" (OnOff Light / 仮想電球)。
// Hub 無しで Apple Home に追加できるか確認したい場合は "bulb" を試す。
const MODE = (process.env.PINCH2MATTER_MODE || "switch").toLowerCase();
if (!["switch", "bulb"].includes(MODE)) {
  throw new Error(`Invalid PINCH2MATTER_MODE: ${MODE}. Use "switch" or "bulb".`);
}

// matter.js デフォルトは ~/.matter/<node-id>/ だが、プロジェクト配下に固定する。
// 理由: (1) systemd の WorkingDirectory と整合 (2) `npm run reset` で安全に消せる
//       (3) .gitignore の除外パターンと一致
const STORAGE_PATH = process.env.PINCH2MATTER_STORAGE || resolve("./.matter");
Environment.default.vars.set("storage.path", STORAGE_PATH);

// ─────────────────────────────────────────────
// 1. Matter デバイス
//    MODE=switch → Momentary Generic Switch (MS + MSR + MSL + MSM)
//    MODE=bulb   → OnOff Light (仮想電球。タップで ON/OFF できる)
// ─────────────────────────────────────────────
const server = await ServerNode.create({
  id: "pinch2matter-node",
  network: { port: 5540 },
  productDescription: {
    name: "pinch2matter",
    deviceType:
      MODE === "bulb" ? OnOffLightDevice.deviceType : GenericSwitchDevice.deviceType,
  },
  commissioning: {
    passcode: 20202021,
    discriminator: 3840,
  },
  // matter.js では BasicInformation クラスタの初期 state をここで全部指定する。
  // (以前は `productAttribution` というキーで設定していたが、それは matter.js に存在しない
  //  無効キーで黙って無視され、結果 "Matter.js Test Product" がデフォルトとして使われていた)
  basicInformation: {
    vendorId: 0xfff1, // CSA のテスト用 VID。本番製品では別途取得が必要
    vendorName: "reomaru",
    productId: 0x8001,
    productName: "pinch2matter",
    // Apple Home がコミッショニング時に提案するデフォルト名 = nodeLabel
    nodeLabel: "pinch2matter",
    productLabel: "pinch2matter",
  },
});

let device;
if (MODE === "bulb") {
  device = new Endpoint(OnOffLightDevice, { id: "pinch2matter" });
} else {
  const MomentaryButtonServer = SwitchServer.with(
    "MomentarySwitch",
    "MomentarySwitchRelease",
    "MomentarySwitchLongPress",
    "MomentarySwitchMultiPress",
  );
  device = new Endpoint(
    GenericSwitchDevice.with(MomentaryButtonServer),
    {
      id: "pinch2matter",
      switch: {
        numberOfPositions: 2, // 0 = released, 1 = pressed
        currentPosition: 0,
        multiPressMax: 2,
      },
    },
  );
}
await server.add(device);
await server.start();

const codes = server.state.commissioning.pairingCodes;
console.log("\n✅ Matter device started");
console.log(`🎛  Mode: ${MODE}`);
console.log("💾 Storage:", STORAGE_PATH);
console.log("📷 Scan this QR in Apple Home:");
console.log(codes.qrPairingCode);
console.log("🔢 Manual pairing code:", codes.manualPairingCode);

// ─────────────────────────────────────────────
// 2. プレス発火ヘルパ
//    switch モード: state 更新 + Switch イベントを emit
//    bulb モード:   OnOff attribute をモーメンタリに ON→OFF
//    Apple Home オートメーションが拾うのは:
//      - switch: InitialPress / ShortRelease イベント
//      - bulb:   OnOff = true への遷移 (Attribute Report)
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function singlePress() {
  if (MODE === "bulb") {
    // bulb モードでは press = 状態トグル (モーメンタリではなく永続的に反転)
    return toggleBulb();
  }
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 1;
    agent.switch.events.initialPress.emit({ newPosition: 1 });
  });
  await sleep(50);
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 0;
    agent.switch.events.shortRelease.emit({ previousPosition: 1 });
    agent.switch.events.multiPressComplete.emit({
      previousPosition: 1,
      totalNumberOfPressesCounted: 1,
    });
  });
}

async function doublePress() {
  if (MODE === "bulb") {
    throw new Error("double-press is switch-mode only");
  }
  // 1回目
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 1;
    agent.switch.events.initialPress.emit({ newPosition: 1 });
  });
  await sleep(50);
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 0;
    agent.switch.events.shortRelease.emit({ previousPosition: 1 });
  });
  await sleep(120);
  // 2回目
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 1;
    agent.switch.events.initialPress.emit({ newPosition: 1 });
  });
  await sleep(50);
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 0;
    agent.switch.events.shortRelease.emit({ previousPosition: 1 });
    agent.switch.events.multiPressComplete.emit({
      previousPosition: 1,
      totalNumberOfPressesCounted: 2,
    });
  });
}

async function longPress() {
  if (MODE === "bulb") {
    throw new Error("long-press is switch-mode only");
  }
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 1;
    agent.switch.events.initialPress.emit({ newPosition: 1 });
  });
  await sleep(500); // Apple Home の長押し判定 (約 0.5 秒) より長く保持
  await device.act(async (agent) => {
    agent.switch.events.longPress.emit({ newPosition: 1 });
  });
  await sleep(80);
  await device.act(async (agent) => {
    agent.switch.state.currentPosition = 0;
    agent.switch.events.longRelease.emit({ previousPosition: 1 });
  });
}

async function toggleBulb() {
  if (MODE !== "bulb") {
    throw new Error("toggle is bulb-mode only");
  }
  const next = !device.state.onOff.onOff;
  await device.set({ onOff: { onOff: next } });
  return next;
}

// ─────────────────────────────────────────────
// 3. HTTP エンドポイント (iOS ショートカットから叩く)
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());

const TOKEN = process.env.PINCH2MATTER_TOKEN || "change-me";
const PORT = Number(process.env.PINCH2MATTER_PORT || 3000);

// ─────────────────────────────────────────────
// 3a. ペアリング状態 / コミッショニングウィンドウ操作
//     matter.js のバージョンで API パスが変わり得るので、複数の場所を見るフォールバックを入れている
// ─────────────────────────────────────────────
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));

function fabricCount() {
  try {
    const n = server.state.operationalCredentials?.commissionedFabrics;
    if (typeof n === "number") return n;
  } catch {
    /* fall through */
  }
  return 0;
}

function isCommissioned() {
  if (fabricCount() > 0) return true;
  try {
    const c = server.state.commissioning?.commissioned;
    if (typeof c === "boolean") return c;
  } catch {
    /* fall through */
  }
  return false;
}

async function openCommissioningWindow(seconds = 900) {
  // matter.js 0.11 系で想定される API。バージョン違いで動かない場合はここを差し替える。
  if (typeof server.openCommissioningWindow === "function") {
    return await server.openCommissioningWindow({ commissioningTimeoutSeconds: seconds });
  }
  const ac = server.administrativeCommissioning;
  if (ac && typeof ac.openCommissioningWindow === "function") {
    return await ac.openCommissioningWindow({ commissioningTimeoutSeconds: seconds });
  }
  throw new Error(
    "openCommissioningWindow API not found — node_modules/@matter/main の現バージョンに合わせて実装を更新してください",
  );
}

const STRINGS = {
  ja: {
    title: "pinch2matter ペアリング",
    runtimeMode: "モード",
    runtimeStorage: "ストレージ",
    runtimeFabrics: "Fabric 数",
    fabricsMultipleWarning: "(複数 — リセットして整理推奨)",
    modeSwitchDesc: "Generic Switch (ステートレスボタン — シングル/ダブル/長押し)",
    modeBulbDesc: "OnOff Light (仮想電球 — タップで ON/OFF)",
    pairedStatus: "✅ ペアリング済み",
    pairedLine1: "このデバイスは既にコミッショニング済みです。",
    pairedLine2:
      "別の Apple Home / Matter コントローラに追加するには、コミッショニングウィンドウを再オープンしてください (15 分間有効)。",
    tokenPlaceholder: "起動時のトークン",
    reopenButton: "コミッショニングを再オープン",
    reopenSuccess: "✅ ウィンドウが開きました。3秒後にリロードします...",
    unpairedStatus: "📡 コミッショニング待機中",
    unpairedInstruction:
      "iPhone「ホーム」アプリで以下の QR をスキャンするか、マニュアルコードを入力してください。",
    manualCodeLabel: "マニュアルコード:",
    qrUnavailable: "(未取得)",
    qrDetailSummary: "QR 文字列 (詳細)",
    autoRefreshNote:
      "⏱ このページは 5 秒ごとに自動更新されます。ペアリング完了で表示が切り替わります。",
    hubWarning:
      "⚠️ Apple Home に追加するには、HomePod / Apple TV のいずれかが家のハブとして必要です。Hub 不在だと「ホームハブが必要です」で蹴られます。",
    logFooter: "サーバログ",
    htmlLang: "ja",
  },
  en: {
    title: "pinch2matter Pairing",
    runtimeMode: "Mode",
    runtimeStorage: "Storage",
    runtimeFabrics: "Fabrics",
    fabricsMultipleWarning: "(multiple — consider resetting to clean up)",
    modeSwitchDesc: "Generic Switch (stateless button — single / double / long press)",
    modeBulbDesc: "OnOff Light (virtual bulb — tap to turn on / off)",
    pairedStatus: "✅ Paired",
    pairedLine1: "This device is already commissioned.",
    pairedLine2:
      "To add it to another Apple Home / Matter controller, reopen the commissioning window (valid for 15 minutes).",
    tokenPlaceholder: "Token set at startup",
    reopenButton: "Reopen Commissioning",
    reopenSuccess: "✅ Window opened. Reloading in 3 seconds...",
    unpairedStatus: "📡 Awaiting Commissioning",
    unpairedInstruction:
      "Open the Home app on your iPhone and scan the QR below, or enter the manual code.",
    manualCodeLabel: "Manual code:",
    qrUnavailable: "(unavailable)",
    qrDetailSummary: "QR string (details)",
    autoRefreshNote:
      "⏱ This page auto-refreshes every 5 seconds and flips to \"Paired\" once commissioning completes.",
    hubWarning:
      "⚠️ Adding to Apple Home requires a HomePod or Apple TV configured as the Home Hub. Without one, Apple Home rejects the device with \"You need a Home Hub to use this app in the Home app.\"",
    logFooter: "Server logs",
    htmlLang: "en",
  },
};

function pickLang(req) {
  const q = (req.query?.lang || "").toLowerCase();
  if (q === "ja" || q === "en") return q;
  const al = (req.headers["accept-language"] || "").toLowerCase();
  if (al.startsWith("en")) return "en";
  return "ja"; // 日本語をデフォルト (リポジトリ第一言語に揃える)
}

function pairingPageHtml({
  commissioned,
  qrPairingCode,
  manualPairingCode,
  qrDataUrl,
  mode,
  storagePath,
  fabrics,
  lang,
}) {
  const S = STRINGS[lang] || STRINGS.ja;
  const autoRefresh = commissioned ? "" : '<meta http-equiv="refresh" content="5">';
  const modeDescription = mode === "bulb" ? S.modeBulbDesc : S.modeSwitchDesc;
  const langSwitcher =
    lang === "ja"
      ? `🇯🇵 日本語 | 🇬🇧 <a href="?lang=en">English</a>`
      : `🇯🇵 <a href="?lang=ja">日本語</a> | 🇬🇧 English`;
  const runtimeCard = `
    <div class="card runtime">
      <table>
        <tr><th>${esc(S.runtimeMode)}</th><td><code>${esc(mode)}</code> — ${esc(modeDescription)}</td></tr>
        <tr><th>${esc(S.runtimeStorage)}</th><td><code>${esc(storagePath)}</code></td></tr>
        <tr><th>${esc(S.runtimeFabrics)}</th><td>${fabrics}${fabrics > 1 ? ` <span class="warn">${esc(S.fabricsMultipleWarning)}</span>` : ""}</td></tr>
      </table>
    </div>`;
  const body = commissioned
    ? `
    <div class="card">
      <span class="status paired">${esc(S.pairedStatus)}</span>
      <p>${esc(S.pairedLine1)}</p>
      <p>${esc(S.pairedLine2)}</p>
      <form id="reopen">
        <label>x-token:
          <input id="token" type="password" autocomplete="off" placeholder="${esc(S.tokenPlaceholder)}">
        </label>
        <button type="submit">${esc(S.reopenButton)}</button>
      </form>
      <div id="result" class="result"></div>
    </div>
    <script>
      const REOPEN_SUCCESS = ${JSON.stringify(S.reopenSuccess)};
      document.getElementById('reopen').addEventListener('submit', async (e) => {
        e.preventDefault();
        const token = document.getElementById('token').value;
        const r = document.getElementById('result');
        r.textContent = '...';
        try {
          const res = await fetch('/pairing/reopen', { method: 'POST', headers: { 'x-token': token } });
          const j = await res.json().catch(() => ({}));
          if (res.ok) {
            r.textContent = REOPEN_SUCCESS;
            setTimeout(() => location.reload(), 3000);
          } else {
            r.textContent = '❌ ' + (j.error || res.statusText);
          }
        } catch (err) {
          r.textContent = '❌ ' + err.message;
        }
      });
    </script>`
    : `
    <div class="card">
      <span class="status unpaired">${esc(S.unpairedStatus)}</span>
      <p>${esc(S.unpairedInstruction)}</p>
      ${qrDataUrl ? `<img src="${esc(qrDataUrl)}" alt="Pairing QR" class="qr">` : ""}
      <p>${esc(S.manualCodeLabel)}</p>
      <p class="code">${esc(manualPairingCode || S.qrUnavailable)}</p>
      <details>
        <summary>${esc(S.qrDetailSummary)}</summary>
        <p class="qrstr">${esc(qrPairingCode || S.qrUnavailable)}</p>
      </details>
      <p class="note">${esc(S.autoRefreshNote)}</p>
      <p class="note">${esc(S.hubWarning)}</p>
    </div>`;
  return `<!doctype html>
<html lang="${esc(S.htmlLang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(S.title)}</title>
${autoRefresh}
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 540px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1d1d1f; background: #f5f5f7; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  .langswitch { font-size: 0.85rem; color: #666; margin: 0 0 1rem; }
  .langswitch a { color: #007aff; text-decoration: none; }
  .card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 1rem; }
  .status { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.85rem; font-weight: 600; }
  .status.paired { background: #d1f4d1; color: #1a6b1a; }
  .status.unpaired { background: #ffe9c2; color: #8a5a00; }
  .qr { display: block; margin: 1rem auto; max-width: 280px; width: 100%; image-rendering: pixelated; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1.8rem; letter-spacing: 0.08em; text-align: center; padding: 1rem; background: #f5f5f7; border-radius: 8px; user-select: all; }
  .qrstr { font-family: ui-monospace, monospace; font-size: 0.75rem; word-break: break-all; color: #666; }
  button { background: #007aff; color: white; border: 0; padding: 0.6rem 1.2rem; border-radius: 8px; font-size: 1rem; cursor: pointer; margin-top: 0.5rem; }
  button:hover { background: #0056b3; }
  input { padding: 0.5rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; margin-left: 0.5rem; }
  .note { font-size: 0.85rem; color: #666; }
  .result { margin-top: 1rem; font-size: 0.9rem; }
  details { margin-top: 1rem; font-size: 0.85rem; }
  .runtime { padding: 1rem 1.5rem; }
  .runtime table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  .runtime th { text-align: left; padding: 0.3rem 0.5rem 0.3rem 0; color: #666; font-weight: 500; white-space: nowrap; vertical-align: top; width: 6rem; }
  .runtime td { padding: 0.3rem 0; word-break: break-all; }
  .runtime code { background: #f5f5f7; padding: 0.05rem 0.3rem; border-radius: 4px; }
  .warn { color: #a04000; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>🤏→💡 pinch2matter</h1>
<p class="langswitch">${langSwitcher}</p>
${runtimeCard}
${body}
<p class="note">${esc(S.logFooter)}: <code>sudo journalctl -u pinch2matter -f</code></p>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// 3b. 認証不要ルート (疎通確認 / ペアリング情報の表示)
// ─────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const state =
    MODE === "bulb"
      ? { on: device.state.onOff.onOff }
      : { position: device.state.switch.currentPosition };
  res.json({
    ok: true,
    mode: MODE,
    commissioned: isCommissioned(),
    fabrics: fabricCount(),
    storage: STORAGE_PATH,
    ...state,
  });
});

app.get("/pairing", async (req, res) => {
  const commissioned = isCommissioned();
  const pairing = server.state.commissioning?.pairingCodes ?? {};
  let qrDataUrl = null;
  if (!commissioned && pairing.qrPairingCode) {
    try {
      qrDataUrl = await QRCode.toDataURL(pairing.qrPairingCode, { width: 320, margin: 2 });
    } catch (e) {
      console.error("QR render failed:", e);
    }
  }
  res.type("html").send(
    pairingPageHtml({
      commissioned,
      qrPairingCode: pairing.qrPairingCode,
      manualPairingCode: pairing.manualPairingCode,
      qrDataUrl,
      mode: MODE,
      storagePath: STORAGE_PATH,
      fabrics: fabricCount(),
      lang: pickLang(req),
    }),
  );
});

// ─────────────────────────────────────────────
// 3c. ここから先は x-token 認証必須
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.headers["x-token"] !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.post("/pairing/reopen", async (_req, res) => {
  try {
    await openCommissioningWindow(900);
    const pairing = server.state.commissioning?.pairingCodes ?? {};
    console.log("🔓 Commissioning window reopened for 15 min");
    res.json({
      ok: true,
      message: "commissioning window opened for 15 minutes",
      qrPairingCode: pairing.qrPairingCode,
      manualPairingCode: pairing.manualPairingCode,
    });
  } catch (e) {
    console.error("reopen failed:", e);
    res.status(500).json({ error: String(e) });
  }
});

// ファクトリーリセット: matter.js の API を試し、無ければストレージを手動で消す。
// どちらにせよプロセスは exit し、systemd 環境なら Restart=always で復帰、
// Mac ローカルなら手動で `npm start` し直す前提。
async function fallbackWipeStorage() {
  const removed = [];
  // 設定済みストレージパス (デフォルト ./.matter)
  try {
    await rm(STORAGE_PATH, { recursive: true, force: true });
    removed.push(STORAGE_PATH);
  } catch (e) {
    console.error(`rm ${STORAGE_PATH} failed:`, e);
  }
  // 念のため CWD 配下の旧候補もスキャン
  for (const p of [".matter", "storage"]) {
    try {
      await rm(p, { recursive: true, force: true });
      removed.push(p);
    } catch (e) {
      console.error(`rm ${p} failed:`, e);
    }
  }
  try {
    const entries = await readdir(".");
    for (const f of entries) {
      if (f.endsWith(".storage")) {
        await rm(f, { force: true });
        removed.push(f);
      }
    }
  } catch (e) {
    console.error("scan *.storage failed:", e);
  }
  return removed;
}

app.post("/factory-reset", async (_req, res) => {
  console.warn("⚠️  Factory reset requested via HTTP");
  try {
    let method;
    let removed = [];
    if (typeof server.factoryReset === "function") {
      await server.factoryReset();
      method = "server.factoryReset()";
    } else {
      removed = await fallbackWipeStorage();
      method = "manual rm";
    }
    res.json({
      ok: true,
      message: "factory reset complete; process will exit, restart to re-commission",
      method,
      removed,
    });
  } catch (e) {
    console.error("factory reset failed:", e);
    return res.status(500).json({ error: String(e) });
  }
  // レスポンスを送り終えてから exit
  setTimeout(() => {
    console.log("🧹 Exiting after factory reset");
    process.exit(0);
  }, 250);
});

// 連打中に新しいプレスが来ても古い処理が走り続けないようにロック
let pressBusy = false;
async function withLock(name, fn, res) {
  if (pressBusy) {
    return res.status(429).json({ error: "press in progress" });
  }
  pressBusy = true;
  try {
    await fn();
    res.json({ ok: true, kind: name });
  } catch (e) {
    console.error(`${name} failed:`, e);
    res.status(500).json({ error: String(e) });
  } finally {
    pressBusy = false;
  }
}

app.post("/press", (_req, res) => withLock("single", singlePress, res));

app.post("/double-press", (req, res) => {
  if (MODE !== "switch") {
    return res.status(400).json({ error: "double-press requires PINCH2MATTER_MODE=switch" });
  }
  return withLock("double", doublePress, res);
});

app.post("/long-press", (req, res) => {
  if (MODE !== "switch") {
    return res.status(400).json({ error: "long-press requires PINCH2MATTER_MODE=switch" });
  }
  return withLock("long", longPress, res);
});

app.post("/toggle", async (req, res) => {
  if (MODE !== "bulb") {
    return res.status(400).json({ error: "toggle requires PINCH2MATTER_MODE=bulb" });
  }
  try {
    const on = await toggleBulb();
    res.json({ ok: true, kind: "toggle", on });
  } catch (e) {
    console.error("toggle failed:", e);
    res.status(500).json({ error: String(e) });
  }
});

const httpServer = app.listen(PORT, () => {
  console.log(`🌐 HTTP listening on :${PORT}`);
});

// SIGINT/SIGTERM で確実に shutdown。matter.js 側 + Express 側を両方閉じる
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    console.log(`(${signal} again — forcing exit)`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down...`);
  try {
    httpServer.close();
  } catch (e) {
    console.error("httpServer.close() failed:", e);
  }
  try {
    if (typeof server.close === "function") await server.close();
    else if (typeof server.cancel === "function") await server.cancel();
  } catch (e) {
    console.error("server shutdown failed:", e);
  }
  process.exit(0);
}
process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });
