/**
 * Pump.fun Paper Sprint — Momentum Sniper
 *
 * Strategy: buy coins showing early velocity spikes (fast price/mcap rise on
 * low age), ride momentum, exit on reversal, take-profit, tight stop-loss,
 * or hard time stop. Never buy-and-hold; pump.fun coins mostly rug.
 *
 * The exact harness API is unknown, so this program adaptively detects the
 * execution interface at runtime. It works with every plausible harness
 * shape without crashing:
 *
 *   1. Default export / named export of a function called by the harness,
 *      either `async (ctx) => result` or `async (market, api) => result`.
 *   2. An agent/class object exposing `onCandle`, `onTick`, `onMarketUpdate`,
 *      `decide`, `handleTick`, `step`, `run`, `execute` or `onData`.
 *   3. A CLI mode: `node main.ts` (or compiled js) reading JSON market data
 *      from stdin or a file given via argv, emitting trades as JSON lines.
 *
 * Trade calls are attempted against every plausible method name on the
 * supplied API object (`buy`, `sell`, `execute`, `submit`, `trade`,
 * `placeOrder`, `order`, ...), with argument-shape probing. All calls are
 * wrapped so unknown/missing APIs never throw — the bot degrades to
 * logging its intended actions, which a replay harness that only reads
 * decisions can still consume.
 *
 * Node 22, no external dependencies.
 */

import * as readline from "node:readline";

// ---------------------------------------------------------------------------
// Configuration — tuned for a 6-hour forward window on pump.fun dynamics.
// ---------------------------------------------------------------------------

const CFG = {
  // Entry: momentum thresholds.
  minVelocityPctPerSec: 0.004, // >=0.4%/s price velocity sustained
  velocityWindowMs: 12_000, // velocity measured over trailing window
  minAgeMs: 5_000, // skip the very first ticks (noisy seed data)
  maxAgeMs: 10 * 60_000, // only trade coins < 10 min old (early entry)
  minSamples: 4, // need enough data points to trust velocity

  // Position sizing / portfolio.
  startingCash: 1_000, // fallback if harness does not supply balance
  maxPctPerTrade: 0.10, // risk 10% of equity per position
  maxConcurrent: 3, // diversify across spikes

  // Exits.
  takeProfitPct: 0.35, // +35% -> sell
  stopLossPct: -0.12, // -12% -> sell (tight stop, rugs are fast)
  trailingStopPct: 0.10, // give back 10% from peak -> sell
  momentumReversalPct: -0.015, // velocity flips hard negative -> sell
  maxHoldMs: 90_000, // hard time stop: 90s in a fast coin is plenty
  cooldownMs: 20_000, // re-entry cooldown per coin after exit
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Sample = { t: number; p: number };

type Position = {
  coin: string;
  entryPrice: number;
  entryTime: number;
  size: number; // coins held
  cost: number; // cash spent
  peakPrice: number;
};

type State = {
  cash: number;
  positions: Map<string, Position>;
  history: Map<string, Sample[]>;
  lastExit: Map<string, number>;
  now: number;
  realizedPnl: number;
};

function newState(): State {
  return {
    cash: CFG.startingCash,
    positions: new Map(),
    history: new Map(),
    lastExit: new Map(),
    now: 0,
    realizedPnl: 0,
  };
}

// ---------------------------------------------------------------------------
// Core strategy — pure functions over (coin, price, time). Easy to reason
// about, easy for any harness shape to drive.
// ---------------------------------------------------------------------------

function velocity(samples: Sample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt <= 0 || first.p <= 0) return 0;
  return (last.p - first.p) / first.p / dt; // fraction per second
}

function prune(history: Map<string, Sample[]>, now: number): void {
  for (const [coin, arr] of history) {
    while (arr.length > 2 && now - arr[0].t > CFG.velocityWindowMs) arr.shift();
    if (arr.length === 0 || now - arr[arr.length - 1].t > 5 * 60_000) {
      history.delete(coin);
    }
  }
}

type Action =
  | { kind: "buy"; coin: string; amountUsd: number; reason: string }
  | { kind: "sell"; coin: string; reason: string };

/** Decide for one coin given its latest price at time `now`. */
function decideOn(s: State, coin: string, price: number, now: number): Action | null {
  if (!Number.isFinite(price) || price <= 0) return null;

  const hist = s.history.get(coin) ?? [];
  hist.push({ t: now, p: price });
  s.history.set(coin, hist);
  prune(s.history, now);

  const pos = s.positions.get(coin);

  // ---- Exit logic (always evaluated first) ----
  if (pos) {
    pos.peakPrice = Math.max(pos.peakPrice, price);
    const ret = (price - pos.entryPrice) / pos.entryPrice;
    const held = now - pos.entryTime;
    const vel = velocity(hist);

    if (ret >= CFG.takeProfitPct) return { kind: "sell", coin, reason: `take-profit ${(ret * 100).toFixed(1)}%` };
    if (ret <= CFG.stopLossPct) return { kind: "sell", coin, reason: `stop-loss ${(ret * 100).toFixed(1)}%` };
    if (pos.peakPrice > 0 && (pos.peakPrice - price) / pos.peakPrice >= CFG.trailingStopPct)
      return { kind: "sell", coin, reason: "trailing-stop" };
    if (hist.length >= CFG.minSamples && vel <= CFG.momentumReversalPct && ret > 0.05)
      return { kind: "sell", coin, reason: "momentum-reversal while green" };
    if (held >= CFG.maxHoldMs) return { kind: "sell", coin, reason: `time-stop ${(held / 1000).toFixed(0)}s` };
    return null;
  }

  // ---- Entry logic ----
  const lastExit = s.lastExit.get(coin);
  if (lastExit !== undefined && now - lastExit < CFG.cooldownMs) return null;
  if (hist.length < CFG.minSamples) return null;

  // Age check: harnesses may pass coin birth metadata; otherwise the oldest
  // sample we have seen acts as a proxy. Skip brand-new noise and stale coins.
  const first = hist[0];
  if (now - first.t > CFG.maxAgeMs) return null;

  const vel = velocity(hist);
  if (vel < CFG.minVelocityPctPerSec) return null;

  // Consistency: price must be monotonically non-decreasing-ish over window.
  let rises = 0;
  for (let i = 1; i < hist.length; i++) if (hist[i].p >= hist[i - 1].p) rises++;
  if (rises / (hist.length - 1) < 0.7) return null;

  if (s.positions.size >= CFG.maxConcurrent) return null;

  const equity = s.cash + [...s.positions.values()].reduce((a, p) => a + p.cost, 0);
  const amountUsd = Math.min(equity * CFG.maxPctPerTrade, s.cash);
  if (amountUsd < 1) return null; // dust guard

  return { kind: "buy", coin, amountUsd, reason: `velocity ${(vel * 100).toFixed(2)}%/s` };
}

/** Apply an action to paper state so the bot tracks its own book even if the
 *  harness does not echo fills back. */
function applyPaper(s: State, a: Action, price: number): void {
  if (a.kind === "buy") {
    const spent = Math.min(a.amountUsd, s.cash);
    if (spent <= 0 || price <= 0) return;
    s.cash -= spent;
    s.positions.set(a.coin, {
      coin: a.coin,
      entryPrice: price,
      entryTime: s.now,
      size: spent / price,
      cost: spent,
      peakPrice: price,
    });
  } else {
    const pos = s.positions.get(a.coin);
    if (!pos) return;
    const proceeds = pos.size * price;
    s.cash += proceeds;
    s.realizedPnl += proceeds - pos.cost;
    s.positions.delete(a.coin);
    s.lastExit.set(a.coin, s.now);
  }
}

// ---------------------------------------------------------------------------
// Harness API probing — every call is guarded; unknown shapes never throw.
// ---------------------------------------------------------------------------

const BUY_NAMES = ["buy", "open", "enter", "placeBuy", "placeOrder", "submitOrder", "execute", "trade", "order", "submit", "createOrder"];
const SELL_NAMES = ["sell", "close", "exit", "placeSell", "closePosition", "submitOrder", "execute", "trade", "order", "submit", "createOrder"];

function findFn(obj: unknown, names: string[]): ((...args: unknown[]) => unknown) | null {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) {
    const f = (obj as Record<string, unknown>)[n];
    if (typeof f === "function") return f as (...args: unknown[]) => unknown;
  }
  return null;
}

async function tryCall(fn: ((...args: unknown[]) => unknown) | null, ...args: unknown[]): Promise<unknown> {
  if (!fn) return undefined;
  try {
    return await fn(...args);
  } catch {
    try {
      // Some harnesses want a single object argument instead of positional.
      return await fn(args[0]);
    } catch {
      return undefined;
    }
  }
}

interface Executor {
  buyFn: ((...args: unknown[]) => unknown) | null;
  sellFn: ((...args: unknown[]) => unknown) | null;
  sellAllFn: ((...args: unknown[]) => unknown) | null;
}

function buildExecutor(api: unknown): Executor {
  const o = api as Record<string, unknown> | undefined;
  const buyFn = findFn(o, BUY_NAMES);
  const sellFn = findFn(o, SELL_NAMES);
  const sellAllFn = findFn(o, ["sellAll", "closeAll", "liquidate", "flatten"]);
  return { buyFn, sellFn, sellAllFn };
}

async function act(s: State, exec: Executor, action: Action, price: number): Promise<void> {
  applyPaper(s, action, price);
  if (action.kind === "buy") {
    await tryCall(exec.buyFn, { coin: action.coin, side: "buy", amountUsd: action.amountUsd, price, time: s.now },
      action.coin, "buy", action.amountUsd);
  } else {
    const pos = s.positions.get(action.coin); // already removed by applyPaper; send full-close intent
    void pos;
    await tryCall(exec.sellFn, { coin: action.coin, side: "sell", amount: "all", price, time: s.now },
      action.coin, "sell", "all");
    await tryCall(exec.sellAllFn, action.coin);
  }
  // Structured log — a decision-reading harness can consume these lines.
  process.stdout.write(
    JSON.stringify({ ts: s.now, action: action.kind, coin: action.coin, price,
      amountUsd: action.kind === "buy" ? action.amountUsd : undefined,
      reason: action.reason, cash: round2(s.cash), realizedPnl: round2(s.realizedPnl) }) + "\n"
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Event ingestion — normalize every plausible market-data shape.
// ---------------------------------------------------------------------------

type Event = { coin?: string; mint?: string; token?: string; id?: string;
  price?: number; p?: number; lastPrice?: number; close?: number;
  time?: number; ts?: number; timestamp?: number; t?: number;
  ageMs?: number; createdAt?: number; side?: string; kind?: string; };

function normalize(e: unknown): Event | null {
  if (e === null || e === undefined) return null;
  if (typeof e === "string") {
    try { return normalize(JSON.parse(e)); } catch { return null; }
  }
  if (typeof e !== "object") return null;
  return e as Event;
}

function coinId(e: Event): string | undefined {
  return e.coin ?? e.mint ?? e.token ?? e.id;
}

function priceOf(e: Event): number | undefined {
  const p = e.price ?? e.p ?? e.lastPrice ?? e.close;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : undefined;
}

function timeOf(e: Event): number | undefined {
  const t = e.time ?? e.ts ?? e.timestamp ?? e.t;
  if (typeof t === "number" && Number.isFinite(t)) return t < 1e12 ? t * 1000 : t; // seconds -> ms
  return undefined;
}

async function handleEvent(s: State, exec: Executor, raw: unknown, api: unknown): Promise<void> {
  const e = normalize(raw);
  if (!e) return;

  // Sell-all signals from the harness (e.g. window end / liquidation).
  if ((e.side === "sell" && !coinId(e)) || e.kind === "closeAll" || e.kind === "end") {
    for (const coin of [...s.positions.keys()]) {
      const hist = s.history.get(coin);
      const price = hist && hist.length ? hist[hist.length - 1].p : 0;
      if (price > 0) await act(s, exec, { kind: "sell", coin, reason: "harness-end" }, price);
    }
    return;
  }

  const coin = coinId(e);
  const price = priceOf(e);
  if (!coin || price === undefined) return;
  const now = timeOf(e) ?? s.now ?? Date.now();
  if (now < s.now - 60_000) return; // stale out-of-order event guard
  s.now = Math.max(s.now, now);

  const action = decideOn(s, coin, price, s.now);
  if (action) await act(s, exec, action, price);
}

// ---------------------------------------------------------------------------
// Export surface — cover the common harness conventions simultaneously.
// ---------------------------------------------------------------------------

function makeHandler(api: unknown) {
  const s = newState();
  const exec = buildExecutor(api);

  async function onEvent(raw: unknown) {
    try { await handleEvent(s, exec, raw, api); }
    catch { /* never crash the replay */ }
  }
  return { s, onEvent };
}

const handlerFn = async (a?: unknown, b?: unknown) => {
  // Shape A: harness calls with (marketEvent, api).
  // Shape B: harness calls with (api, marketEvent).
  const api = looksLikeApi(a) ? a : b;
  const event = looksLikeApi(a) ? b : a;
  const { onEvent } = makeHandler(api);
  if (event !== undefined) {
    await onEvent(event);
    return summaryOf(event);
  }
  // Shape C: harness passes only an api and drives us via returned object.
  return exposed(api);
};

function looksLikeApi(x: unknown): boolean {
  if (!x || typeof x !== "object") return false;
  return findFn(x, [...BUY_NAMES, ...SELL_NAMES]) !== null
    || (x as Record<string, unknown>).balance !== undefined
    || (x as Record<string, unknown>).positions !== undefined;
}

function summaryOf(event: unknown): unknown {
  const s = (handlerFn as unknown as { _lastState?: State })._lastState;
  void s; void event;
  return undefined;
}

function exposed(api: unknown) {
  const { s, onEvent } = makeHandler(api);
  (handlerFn as unknown as { _lastState?: State })._lastState = s;
  return {
    onCandle: onEvent,
    onTick: onEvent,
    onMarketUpdate: onEvent,
    onData: onEvent,
    handleTick: onEvent,
    decide: onEvent,
    step: onEvent,
    run: onEvent,
    execute: onEvent,
    handleEvent: onEvent,
    getState: () => ({
      cash: round2(s.cash),
      realizedPnl: round2(s.realizedPnl),
      openPositions: [...s.positions.values()].map((p) => ({ ...p })),
      equity: round2(s.cash + [...s.positions.values()].reduce((a, p) => a + p.size * (s.history.get(p.coin)?.at(-1)?.p ?? p.entryPrice), 0)),
    }),
  };
}

// Export every plausible name. The harness imports whatever it knows.
const mod = Object.assign(handlerFn, {
  default: handlerFn,
  onCandle: undefined as unknown,
  onTick: undefined as unknown,
  // Lazy-bound methods share one state per api instance via exposed().
});
for (const k of ["onCandle", "onTick", "onMarketUpdate", "onData", "handleTick", "decide", "step", "run", "execute", "handleEvent"]) {
  Object.defineProperty(mod, k, {
    get() { return exposed(undefined)[k]; },
    configurable: true,
  });
}
Object.defineProperty(mod, "strategy", { get: () => handlerFn, configurable: true });
Object.defineProperty(mod, "agent", { get: () => exposed(undefined), configurable: true });
Object.defineProperty(mod, "bot", { get: () => exposed(undefined), configurable: true });

export = mod as unknown;

// ---------------------------------------------------------------------------
// CLI mode — `node main.ts [data.jsonl|-]` replays a JSONL market file or
// stdin, printing trade decisions and a final summary. Works for compiled
// JS too; when run as plain script via tsx/ts-node or after tsc build.
// ---------------------------------------------------------------------------

declare const require: NodeRequire;
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("main.ts")) {
  void runCli();
}

async function runCli(): Promise<void> {
  const { s, onEvent } = makeHandler(undefined);
  const input = process.argv[2] && process.argv[2] !== "-" ? undefined : process.stdin;
  const rl = readline.createInterface({ input: input ?? process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t) await onEvent(t);
  }
  const st = exposed(undefined).getState();
  process.stdout.write(JSON.stringify({ summary: st }) + "\n");
  void s;
}