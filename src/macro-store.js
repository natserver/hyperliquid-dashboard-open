/**
 * 宏观与基本面读数（M1~M6）的本地历史库 —— 仅服务端与采集任务使用。
 *
 * ── 为什么需要一个库，而不是继续留在内存里 ──────────────────────────────
 *
 * `src/macro-sources.js` 每次只回答一个问题：「**此刻**读到什么」。
 * 但方向判断要回答的是「**比之前变好了还是变坏了**」——
 *
 *   · 恐慌贪婪 78 是"极端乐观"；那上周是多少？从 30 涨到 78 和从 95 回落到 78
 *     是两件完全不同的事，前者是情绪升温，后者是情绪退潮。
 *   · DXY 100.36 在 103 下方；但它是在下行还是刚从 98 反弹上来？
 *   · 机构持仓 3.915% 离门槛 5% 还差多少，一个月前差多少？
 *
 * 这些全都是**时间序列**问题，内存里的单点快照永远答不了。所以把每天的
 * 读数固定落盘，攒出序列。
 *
 * ── 存哪儿、为什么 ──────────────────────────────────────────────────
 *
 *   .data/macro.db      SQLite（Node 22.5+ 内置 node:sqlite，仍然零依赖）
 *   .data/macro.jsonl   降级格式（Node <22.5 或 sqlite 加载失败时启用）
 *
 * 放 `.data/` 而不是 `.cache/`：`.cache/` 的语义是「丢了可以重算」，而这个库
 * 一旦丢了就**永远补不回来** —— 今天的恐慌贪婪指数明天不会再有今天的值。
 * 它不是缓存，是账本。`.data/` 整体进 .gitignore（二进制不该入库）。
 *
 * ── 主键为什么是 (day, criterion) ────────────────────────────────────
 *
 * 每天每个判据只应有一行。守护进程可能一天内多次刷新（30 分钟缓存到期就刷），
 * 但那是同一天的同一个观测 —— 用 upsert 覆盖，不要追加出 48 行噪音。
 * 「今天读到的最新值」才是今天的值。
 *
 * ── 一个刻意的取舍：day 用「采集日」而不是「数据日」 ──────────────────
 *
 * 各源的发数节奏不一样：ETF 是 T+1、IBIT 持仓是 T+1、DXY 是当日。
 * 如果按数据自身的日期做主键，同一次采集的 6 条会散落到不同 day 上，
 * 就没法回答「9 月 22 日这天，六条判据分别是什么状态」。
 * 所以主键的 day = 我们**观测**的那天（UTC），数据自身的日期另存 `data_day`，
 * 两个都要，不能混。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(__dirname, '..', '.data');
export const DB_PATH = path.join(DATA_DIR, 'macro.db');
export const JSONL_PATH = path.join(DATA_DIR, 'macro.jsonl');

/** 采集日：UTC 日期串。用 UTC 而不是本地时区 —— 各源本身都是 UTC 发数，
 *  本地时区会让「同一天」在不同机器上算出不同的字符串。 */
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * 判据的固定顺序（M1 → M6）。
 *
 * 必须是**显式常量**而不是依赖 Object key 顺序或字典序：
 *   · 依赖上游对象顺序 → 上游一改就静默重排
 *   · 用字典序排序 → `etf-netflow` 会排到第一位，与界面上的 M1~M6 编号对不上
 * 落库、查询、终端回看三处都必须用它，否则同一个库在两处读出不同的行序 ——
 * 而「顺序不同」看起来只是排版问题，实际会让「第一行」指的是不同的判据。
 */
export const CRITERIA_ORDER = [
  'media-extreme',
  'etf-netflow',
  'onchain-activity',
  'liquidity-macro',
  'institutional-holding',
  'regulation-policy',
];

/* ══════════════════ SQLite 后端 ══════════════════ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS macro_daily (
  day         TEXT    NOT NULL,
  ord         INTEGER,
  criterion   TEXT    NOT NULL,
  layer       TEXT,
  label       TEXT,
  value       REAL,
  unit        TEXT,
  available   INTEGER NOT NULL DEFAULT 0,
  vote        INTEGER,
  data_day    TEXT,
  freshness   TEXT,
  reason      TEXT,
  provider    TEXT,
  spot_price  REAL,
  detail      TEXT,
  fetched_at  TEXT    NOT NULL,
  PRIMARY KEY (day, criterion)
);
CREATE INDEX IF NOT EXISTS ix_daily_criterion ON macro_daily (criterion, day);
CREATE INDEX IF NOT EXISTS ix_daily_day       ON macro_daily (day);

CREATE TABLE IF NOT EXISTS macro_runs (
  day         TEXT PRIMARY KEY,
  fetched_at  TEXT NOT NULL,
  available   INTEGER,
  abstain     INTEGER,
  vote_long   INTEGER,
  vote_short  INTEGER,
  spot_price  REAL,
  bias        TEXT,
  bias_label  TEXT,
  confidence  TEXT,
  cycle_phase TEXT,
  errors      TEXT
);
`;

/**
 * 轻量迁移：把后来新增的列补到已存在的表上。
 *
 * 为什么需要：这个库是「账本」，一旦开始用就不能靠删文件重建来升级 ——
 * 重建会把历史清掉，而历史正是这个库存在的理由。`CREATE TABLE IF NOT EXISTS`
 * 对已存在的表是**空操作**，新列不会自己出现，于是旧库上所有 INSERT 都会
 * 因为没有那一列而报错。
 *
 * 只做加列（ADD COLUMN），不做删改 —— 加列是唯一向前兼容、且不会破坏既有数据的变更。
 */
function ensureColumns(db, table, wanted) {
  let have;
  try {
    have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  } catch {
    return;
  }
  for (const [name, decl] of Object.entries(wanted)) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    } catch {
      /* 加不上（只读库等）就算了，不阻断 */
    }
  }
}

/**
 * 取内置 SQLite 的 DatabaseSync，取不到返回 null。
 *
 * ⚠ 这一整段必须是**运行期**动态取用，不能写成顶层 `import ... from 'node:sqlite'`：
 * ESM 的顶层 import 在模块解析期就求值，Node <22.5 上会直接
 * `ERR_UNKNOWN_BUILTIN_MODULE` 崩掉，降级分支根本没机会执行 ——
 * 那样「零依赖 + 兼容旧 Node」就只是注释里的一句空话。
 *
 * 而且 ESM 里没有 `require`（这是实测踩到的），所以走
 * `process.getBuiltinModule`（Node 22.3+）或 `createRequire` 兜底。
 */
function loadDatabaseSync() {
  try {
    const mod =
      typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule('node:sqlite')
        : createRequire(import.meta.url)('node:sqlite');
    if (mod && typeof mod.DatabaseSync === 'function') return mod.DatabaseSync;
  } catch {
    /* 没有内置 sqlite → 由调用方走 JSONL 降级 */
  }
  return null;
}

function openSqlite(dir) {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) return null;

  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'macro.db'));
  // WAL：采集任务与服务端可能同时读写（服务端在一次快照里写、任务在 cron 里写）。
  // 默认的 rollback journal 会让并发写直接报 SQLITE_BUSY。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  // 旧库升级：补齐后来新增的列（见 ensureColumns 的注释）
  ensureColumns(db, 'macro_daily', {
    ord: 'INTEGER',
    unit: 'TEXT',
    data_day: 'TEXT',
    freshness: 'TEXT',
    provider: 'TEXT',
    spot_price: 'REAL',
    detail: 'TEXT',
  });
  ensureColumns(db, 'macro_runs', {
    cycle_phase: 'TEXT',
    bias_label: 'TEXT',
  });
  return db;
}

function sqliteBackend(db) {
  const stUpReading = db.prepare(`
    INSERT INTO macro_daily
      (day, ord, criterion, layer, label, value, unit, available, vote,
       data_day, freshness, reason, provider, spot_price, detail, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day, criterion) DO UPDATE SET
      ord=excluded.ord,
      layer=excluded.layer, label=excluded.label, value=excluded.value,
      unit=excluded.unit, available=excluded.available, vote=excluded.vote,
      data_day=excluded.data_day, freshness=excluded.freshness,
      reason=excluded.reason, provider=excluded.provider,
      spot_price=excluded.spot_price, detail=excluded.detail,
      fetched_at=excluded.fetched_at
  `);
  const stUpRun = db.prepare(`
    INSERT INTO macro_runs
      (day, fetched_at, available, abstain, vote_long, vote_short,
       spot_price, bias, bias_label, confidence, cycle_phase, errors)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET
      fetched_at=excluded.fetched_at, available=excluded.available,
      abstain=excluded.abstain, vote_long=excluded.vote_long,
      vote_short=excluded.vote_short, spot_price=excluded.spot_price,
      bias=COALESCE(excluded.bias, macro_runs.bias),
      bias_label=COALESCE(excluded.bias_label, macro_runs.bias_label),
      confidence=COALESCE(excluded.confidence, macro_runs.confidence),
      cycle_phase=COALESCE(excluded.cycle_phase, macro_runs.cycle_phase),
      errors=excluded.errors
  `);
  // 按 ord 排而不是按 criterion 排 —— 字典序会把 etf-netflow 排到第一位，
  // 而 JSONL 后端是按写入顺序（M1→M6）来的，两边 latest[0] 就不是同一条判据。
  const stLatest = db.prepare('SELECT * FROM macro_daily WHERE day = ? ORDER BY ord, criterion');
  const stLastDay = db.prepare('SELECT MAX(day) AS d FROM macro_daily');
  const stHist = db.prepare(
    'SELECT * FROM macro_daily WHERE criterion = ? AND day >= ? ORDER BY day'
  );
  const stSeries = db.prepare(
    'SELECT day, value, vote, available, freshness FROM macro_daily WHERE criterion = ? ORDER BY day DESC LIMIT ?'
  );
  const stRuns = db.prepare('SELECT * FROM macro_runs ORDER BY day DESC LIMIT ?');
  const stStats = db.prepare(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT day) AS days,
           MIN(day) AS first_day, MAX(day) AS last_day,
           SUM(available) AS avail FROM macro_daily
  `);
  const stCrit = db.prepare(
    'SELECT criterion, COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM macro_daily GROUP BY criterion ORDER BY criterion'
  );
  const stPruneR = db.prepare('DELETE FROM macro_daily WHERE day < ?');
  const stPruneU = db.prepare('DELETE FROM macro_runs  WHERE day < ?');
  const stCountDays = db.prepare('SELECT COUNT(DISTINCT day) AS n FROM macro_daily WHERE day < ?');
  const stCountRows = db.prepare('SELECT COUNT(*) AS n FROM macro_daily WHERE day < ?');

  return {
    kind: 'sqlite',
    path: DB_PATH,

    writeDay({ day, fetchedAt, spotPrice, bias, biasLabel, confidence, cyclePhase, counts = {}, errors, rows }) {
      db.exec('BEGIN');
      try {
        for (const r of rows) stUpReading.run(...r);
        stUpRun.run(
          day,
          fetchedAt,
          counts.available ?? null,
          counts.abstain ?? null,
          counts.voteLong ?? null,
          counts.voteShort ?? null,
          spotPrice ?? null,
          bias ?? null,
          biasLabel ?? null,
          confidence ?? null,
          cyclePhase ?? null,
          errors && errors.length ? JSON.stringify(errors) : null
        );
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    latestDay() {
      const got = stLastDay.get();
      return got && got.d ? got.d : null;
    },
    latestRows(day) {
      return day ? stLatest.all(day) : [];
    },
    history(criterion, sinceDay) {
      return stHist.all(criterion, sinceDay);
    },
    series(criterion, limit) {
      return stSeries.all(criterion, limit).reverse();
    },
    runs(limit) {
      return stRuns.all(limit);
    },
    stats() {
      const s = stStats.get() || {};
      const perCriterion = stCrit.all();
      return { ...s, perCriterion };
    },
    /**
     * 裁剪保留期之外的数据。
     * @param {number} keepDays 保留最近几天
     * @param {number} [now] 基准时刻（毫秒）。**只为可测性存在** —— 测试要能钉死
     *   时间轴，否则「库里有几天数据」会随真实日期流逝而变，断言自己变红。
     *   生产调用方不传，行为与从前完全一致。
     */
    prune(keepDays, now = Date.now()) {
      const cut = dayOf(now - keepDays * 86400000);
      // 先数后删 —— 两个后端必须报同一套口径（天数 + 行数）。
      // 早期 SQLite 版只报行数、JSONL 版只报天数，同一个 prune() 在两台机器上
      // 返回不同的量纲，调用方根本没法判断「到底清了多少」。
      // ⚠ 必须把 cut 传进去。漏参数时 `?` 会是 NULL，`day < NULL` 恒为假，
      //    于是「清了多少」永远报 0，而删除本身照常生效 —— 报表和事实脱节。
      const days = Number(stCountDays.get(cut).n || 0);
      const rows = Number(stCountRows.get(cut).n || 0);
      stPruneR.run(cut);
      const runs = Number(stPruneU.run(cut).changes || 0);
      return { removedDays: days, removedRows: rows, removedRuns: runs, cut };
    },
    close() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
    },
  };
}

/* ══════════════════ JSONL 降级后端 ══════════════════
 *
 * 语义与 SQLite 后端**完全一致**，只是精度低（每天一行、查询在内存里过滤）。
 * 日度数据一年也就 6 × 365 ≈ 2200 行，全量读进来毫无压力，
 * 所以这里不做索引，只保证「同样的 upsert 语义」——
 * 两个后端行为不一致才是真正会咬人的 bug。
 */

function jsonlBackend(dir) {
  const file = path.join(dir, 'macro.jsonl');
  fs.mkdirSync(dir, { recursive: true });

  /** 读全部天记录。坏行（正好写到一半）直接跳过，不让一行脏数据废掉整个库 */
  const readAll = () => {
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && j.day) out.push(j);
      } catch {
        /* 半行跳过 */
      }
    }
    return out;
  };

  /** upsert 需要改写而不是追加 —— 追加会在同一天里长出多份。
   *  原子写（tmp + rename）保证进程被 kill 时不会留下半个文件。 */
  const writeAll = (days) => {
    days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, days.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
  };

  return {
    kind: 'jsonl',
    path: file,

    writeDay({ day, fetchedAt, spotPrice, bias, biasLabel, confidence, cyclePhase, counts = {}, errors, rows }) {
      const days = readAll();
      const i = days.findIndex((d) => d.day === day);
      const prev = i >= 0 ? days[i] : null;
      const rec = {
        day,
        fetchedAt,
        spotPrice: spotPrice ?? null,
        // 方向层可能这一轮没算（只跑采集时）—— 已有值不能被 null 冲掉
        bias: bias ?? (prev ? prev.bias : null),
        biasLabel: biasLabel ?? (prev ? prev.biasLabel : null),
        confidence: confidence ?? (prev ? prev.confidence : null),
        cyclePhase: cyclePhase ?? (prev ? prev.cyclePhase : null),
        counts: Object.keys(counts).length ? counts : (prev ? prev.counts : null) || null,
        errors: errors && errors.length ? errors : [],
        rows,
      };
      if (i >= 0) days[i] = rec;
      else days.push(rec);
      writeAll(days);
    },

    latestDay() {
      const days = readAll();
      if (!days.length) return null;
      return days.reduce((m, d) => (d.day > m ? d.day : m), days[0].day);
    },
    latestRows(day) {
      const rec = readAll().find((d) => d.day === day);
      // 必须还原成**列名对象**，与 SQLite 后端同形 —— 否则调用方拿到的
      // 一边是 {criterion, value}、一边是裸数组，同一个字段一处能读一处读不到。
      return rec ? rec.rows.map((r) => rowFromTuple(day, r)) : [];
    },
    history(criterion, sinceDay) {
      const out = [];
      for (const d of readAll()) {
        if (d.day < sinceDay) continue;
        for (const r of d.rows) {
          const row = rowFromTuple(d.day, r);
          if (row.criterion === criterion) out.push(row);
        }
      }
      return out;
    },
    series(criterion, limit) {
      const out = [];
      for (const d of readAll()) {
        for (const r of d.rows) {
          const row = rowFromTuple(d.day, r);
          if (row.criterion === criterion) out.push(row);
        }
      }
      return out.slice(-limit);
    },
    runs(limit) {
      return readAll()
        .slice()
        .reverse()
        .slice(0, limit)
        .map((d) => ({
          // 键集必须与 SQLite 后端的 `SELECT *` 完全一致（哪怕值是 null）。
          // 早先这里只写有值的键，于是 `'available' in run` 在 SQLite 上是 true、
          // 在 JSONL 上是 false —— 同一份调用方代码，两台机器两种行为。
          day: d.day,
          fetched_at: d.fetchedAt,
          available: d.counts?.available ?? null,
          abstain: d.counts?.abstain ?? null,
          vote_long: d.counts?.voteLong ?? null,
          vote_short: d.counts?.voteShort ?? null,
          spot_price: d.spotPrice ?? null,
          bias: d.bias ?? null,
          bias_label: d.biasLabel ?? null,
          confidence: d.confidence ?? null,
          cycle_phase: d.cyclePhase ?? null,
          errors: d.errors && d.errors.length ? JSON.stringify(d.errors) : null,
        }));
    },
    stats() {
      const days = readAll();
      let rows = 0;
      let avail = 0;
      const per = new Map();
      for (const d of days) {
        for (const r of d.rows) {
          // 走 rowFromTuple 而不是裸下标 —— 下标会随 tuple 形状变化而错位，
          // 上一版这里写死 r[1]/r[6]，把 ord 当成了 criterion，统计直接错。
          const row = rowFromTuple(d.day, r);
          rows++;
          if (row.available) avail++;
          const cur = per.get(row.criterion) || { criterion: row.criterion, n: 0, first_day: d.day, last_day: d.day };
          cur.n++;
          if (d.day < cur.first_day) cur.first_day = d.day;
          if (d.day > cur.last_day) cur.last_day = d.day;
          per.set(row.criterion, cur);
        }
      }
      const ds = days.map((d) => d.day).sort();
      return {
        rows,
        days: days.length,
        first_day: ds[0] ?? null,
        last_day: ds[ds.length - 1] ?? null,
        avail,
        perCriterion: [...per.values()].sort((a, b) => (a.criterion < b.criterion ? -1 : 1)),
      };
    },
    prune(keepDays, now = Date.now()) {
      const cut = dayOf(now - keepDays * 86400000);
      const days = readAll();
      const kept = days.filter((d) => d.day >= cut);
      const dropped = days.filter((d) => d.day < cut);
      if (kept.length !== days.length) writeAll(kept);
      // 与 SQLite 后端同口径：天数 + 行数（见 SQLite 版 prune 的注释）
      return {
        removedDays: dropped.length,
        removedRows: dropped.reduce((n, d) => n + d.rows.length, 0),
        removedRuns: dropped.length,
        cut,
      };
    },
    close() {},
  };
}

/** JSONL 的 rows 存成定长数组而不是对象 —— 一天 6 行 × 365 天，
 *  用数组每行省掉一整套重复的键名，文件能小一半。这里是唯一需要还原的地方。
 *
 *  形状（下标即含义，改动必须同步 tupleFromRow）：
 *    0 day · 1 ord · 2 criterion · 3 layer · 4 label · 5 value · 6 unit
 *    7 available · 8 vote · 9 data_day · 10 freshness · 11 reason
 *    12 provider · 13 spot_price · 14 detail · 15 fetched_at
 */
function rowFromTuple(day, r) {
  return {
    day,
    ord: r[1],
    criterion: r[2],
    layer: r[3],
    label: r[4],
    value: r[5],
    unit: r[6],
    available: r[7],
    vote: r[8],
    data_day: r[9],
    freshness: r[10],
    reason: r[11],
    provider: r[12],
    spot_price: r[13],
    detail: r[14],
    fetched_at: r[15],
  };
}
function tupleFromRow(ord, day, r, fetchedAt, spotPrice) {
  return [
    day,
    ord,
    r.id,
    r.layer ?? null,
    r.name ?? r.label ?? null,
    Number.isFinite(r.value) ? r.value : null,
    r.unit ?? null,
    r.available ? 1 : 0,
    Number.isFinite(r.vote) ? r.vote : null,
    r.asOf ?? null,
    r.ttl ?? null,
    r.reason ?? null,
    r.provider ?? null,
    Number.isFinite(spotPrice) ? spotPrice : null,
    detailOf(r),
    fetchedAt,
  ];
}

/** 读数里除了 reason 之外的附加字段（gate / tightening / items …）原样留档。
 *  reason 已经单独成列，不重复进 detail。items 可能很长，截断保护单行体积。 */
function detailOf(r) {
  const skip = new Set(['id', 'layer', 'name', 'label', 'value', 'unit', 'available', 'vote', 'ttl', 'asOf', 'reason', 'provider']);
  const extra = {};
  for (const [k, v] of Object.entries(r)) {
    if (skip.has(k) || v === undefined) continue;
    extra[k] = v;
  }
  if (!Object.keys(extra).length) return null;
  let s;
  try {
    s = JSON.stringify(extra);
  } catch {
    return null;
  }
  const CAP = 8192;
  return s.length > CAP ? `${s.slice(0, CAP)}…` : s;
}

/* ══════════════════ 对外入口 ══════════════════ */

/**
 * 打开历史库。
 *
 * @param {object}   [opts]
 * @param {string}   [opts.dir]      数据目录，默认 .data/
 * @param {'auto'|'sqlite'|'jsonl'} [opts.backend='auto']
 *        `jsonl` 用来在测试里强制走降级路径 —— 否则降级分支永远没人跑过。
 * @returns {object|null} 打不开时返回 null（**不抛**）：历史库坏了不该让看板打不开
 */
export function openMacroStore({ dir = DATA_DIR, backend = 'auto' } = {}) {
  try {
    if (backend === 'sqlite' || backend === 'auto') {
      const db = openSqlite(dir);
      if (db) return sqliteBackend(db);
      if (backend === 'sqlite') return null;
    }
    return jsonlBackend(dir);
  } catch (e) {
    // 落到降级路径。这里吞掉异常是刻意的：SQLite 在某台机器上打不开
    // （只读盘、权限、PRAGMA 不支持）时，看板仍然应该能跑，只是少一段历史。
    try {
      return jsonlBackend(dir);
    } catch {
      return null;
    }
  }
}

/**
 * 把一次采集结果写进历史库。
 *
 * @param {object} store         openMacroStore() 的返回值
 * @param {object} panel         { readings, errors, fetchedAt, spotPrice }
 * @param {object} [meta]        { bias, biasLabel, confidence, cyclePhase, now }
 * @returns {{day:string, rows:number}|null}
 */
export function recordMacro(store, panel, meta = {}) {
  if (!store || !panel) return null;
  const readings = Array.isArray(panel.readings) ? panel.readings : [];
  if (!readings.length) return null;

  const fetchedAt = panel.fetchedAt || new Date(meta.now ?? Date.now()).toISOString();
  // day 取采集日（见文件头注释）：数据日另存 data_day。
  // ⚠ `??` 与 `||` 不能直接叠用（JS 语法禁止），必须括号分开。
  const day = dayOf(meta.now ?? (Date.parse(fetchedAt) || Date.now()));
  const spotPrice = panel.spotPrice ?? null;

  // 判据顺序固定，写进库才是可比的 —— 依赖 Object key 顺序会随上游改动而漂。
  const sorted = readings
    .slice()
    .sort((a, b) => {
      const ia = CRITERIA_ORDER.indexOf(a.id);
      const ib = CRITERIA_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

  const rows = sorted.map((r, i) => tupleFromRow(i, day, r, fetchedAt, spotPrice));

  /* 把当天的票面统计一起存下来。
   *
   * 为什么在库里算而不是让调用方传：这两个调用方（server.js 的每次快照、
   * tools/macro-daily.js 的定时任务）都只是想存数据，让它们各自算一遍
   * 等于给"两边算法漂移"留了门。而且 macro_runs 这四列**原先从来没人填**
   * （写死的 null），等于建了列却不用 —— 那比没有这一列更坏，因为它看起来
   * 有数据。现在由唯一的入口统一填。 */
  const availRows = sorted.filter((r) => r.available);
  const counts = {
    available: availRows.length,
    abstain: sorted.length - availRows.length,
    voteLong: availRows.filter((r) => Number.isFinite(r.vote) && r.vote > 0).length,
    voteShort: availRows.filter((r) => Number.isFinite(r.vote) && r.vote < 0).length,
  };

  try {
    store.writeDay({
      day,
      fetchedAt,
      spotPrice,
      bias: meta.bias ?? null,
      biasLabel: meta.biasLabel ?? null,
      confidence: meta.confidence ?? null,
      cyclePhase: meta.cyclePhase ?? null,
      counts,
      errors: panel.errors || [],
      rows,
    });
    return { day, rows: rows.length };
  } catch {
    return null;
  }
}

/**
 * 查每个判据的近期序列 —— 界面画趋势用。
 *
 * @returns {object} { [criterion]: [{day, value, vote, available}] }
 */
export function macroHistory(store, { days = 30 } = {}) {
  if (!store) return {};
  const since = dayOf(Date.now() - days * 86400000);
  const out = {};
  for (const id of CRITERIA_ORDER) {
    try {
      out[id] = store
        .history(id, since)
        .map((h) => ({
          day: h.day,
          value: h.value,
          vote: h.vote,
          available: !!h.available,
          freshness: h.freshness,
        }))
        .filter((h) => h.value !== null || h.vote !== null);
    } catch {
      out[id] = [];
    }
  }
  return out;
}

/** 看板「历史库」小卡片要的一行摘要 */
export function storeSummary(store) {
  if (!store) return null;
  try {
    const s = store.stats();
    return {
      backend: store.kind,
      path: path.basename(store.path || ''),
      rows: s.rows || 0,
      days: s.days || 0,
      firstDay: s.first_day || null,
      lastDay: s.last_day || null,
      available: s.avail || 0,
      perCriterion: (s.perCriterion || []).map((c) => ({
        criterion: c.criterion,
        n: c.n,
        firstDay: c.first_day,
        lastDay: c.last_day,
      })),
    };
  } catch {
    return null;
  }
}
