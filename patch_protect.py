# -*- coding: utf-8 -*-
p = "/mnt/cos/artifacts/recruit/server.js"
s = open(p, encoding="utf-8").read()

def rep(old, new):
    global s
    n = s.count(old)
    assert n == 1, "count %d for: %r" % (n, old[:90])
    s = s.replace(old, new)
    print("OK:", old[:60].replace("\n", "\\n"))

# ---------- 1) 存储层：加入 dbLoaded 保护 + 空库不覆盖非空库 + 原子写 + 备份 ----------
old_store = """let db = { users: [], resumes: [], sessions: {} };

let pool = null;
let pgReady = false;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\\.0\\.0\\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
  }
} catch (e) {
  console.error('[warn] pg 未安装，回退本地文件存储:', e.message);
  pool = null;
}

async function loadDB() {
  if (pool) {
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      if (r.rows.length && r.rows[0].data) {
        const d = r.rows[0].data;
        db.users = Array.isArray(d.users) ? d.users : [];
        db.resumes = Array.isArray(d.resumes) ? d.resumes : [];
        db.sessions = d.sessions && typeof d.sessions === 'object' ? d.sessions : {};
      }
      pgReady = true;
      console.log('[db] 已连接 Postgres，数据将持久保存（部署迭代不丢失）');
      return;
    } catch (e) {
      console.error('[warn] Postgres 初始化失败，回退本地文件:', e.message);
      pool = null;
    }
  }
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      db.users = Array.isArray(raw.users) ? raw.users : [];
      db.resumes = Array.isArray(raw.resumes) ? raw.resumes : [];
      db.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    } catch (e) {
      console.error('[warn] data.json 解析失败，使用空数据库:', e.message);
    }
  }
  console.log('[db] 使用本地文件存储:', DATA_FILE, '（未配置 DATABASE_URL，重新部署会重置）');
}

let persistTimer = null;
function persist() {
  if (pool && pgReady) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      pool.query(
        'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()',
        [JSON.stringify(db)]
      ).catch(function (e) { console.error('[persist]', e.message); });
    }, 150);
    return;
  }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('[persist]', e.message); }
}"""

new_store = """let db = { users: [], resumes: [], sessions: {} };

/* ==================================================================
 * 数据保护层（硬性规则）
 * 规则：除「用户本人注销」与「终端管理员删除用户」两条授权通道外，
 *      任何情况下（含网站/代码更新、重新部署、启动初始化）都不得
 *      删除用户信息与管理员信息。
 * 实现：
 *   1) dbLoaded 为 false 时绝不写盘（避免用空数据覆盖已有数据）。
 *   2) 空库永不覆盖「非空库」（防止误清空）。
 *   3) 本地文件采用原子写 + 滚动备份（.bak）。
 * ================================================================== */
let dbLoaded = false;          // 只有在成功读取到存储后才会置为 true
let lastStoreCount = 0;        // 上一次已知的（用户+简历）记录数，用于防空覆盖

const RESERVED_DELETE_PATHS = ['/api/account', '/api/users/:id']; // 仅这两条删除通道合法
function isAuthorizedDelete(pathname) {
  return pathname === '/api/account' || /^\\/api\\/users\\/[^/]+$/.test(pathname);
}

let pool = null;
let pgReady = false;
const PG_ENABLED = !!process.env.DATABASE_URL;
try {
  if (PG_ENABLED) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\\.0\\.0\\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
    });
  }
} catch (e) {
  console.error('[warn] pg 未安装，无法使用数据库存储:', e.message);
  pool = null;
}

function hydrate(raw) {
  db.users = Array.isArray(raw.users) ? raw.users : [];
  db.resumes = Array.isArray(raw.resumes) ? raw.resumes : [];
  db.sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  lastStoreCount = db.users.length + db.resumes.length;
}

async function loadDB() {
  if (PG_ENABLED && pool) {
    // 连接数据库并读取；失败则保持 dbLoaded=false 并稍后重试，绝不回退到空库
    try {
      await pool.query('CREATE TABLE IF NOT EXISTS app_state (id INT PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now())');
      const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
      if (r.rows.length && r.rows[0].data) {
        hydrate(r.rows[0].data);
      } else {
        // 全新数据库，确实没有数据
        hydrate({ users: [], resumes: [], sessions: {} });
      }
      pgReady = true;
      dbLoaded = true;
      console.log('[db] 已连接 Postgres，数据永久保存（部署/更新不丢失）');
      return;
    } catch (e) {
      pgReady = false;
      dbLoaded = false;
      console.error('[db] Postgres 读取失败，暂不写入以免覆盖数据，将自动重试:', e.message);
      return;
    }
  }

  // 本地文件存储（仅本地开发）
  if (fs.existsSync(DATA_FILE)) {
    try {
      hydrate(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
      dbLoaded = true;
    } catch (e) {
      dbLoaded = false;
      console.error('[db] data.json 解析失败，暂不写入以免覆盖数据:', e.message);
      return;
    }
  } else {
    hydrate({ users: [], resumes: [], sessions: {} });
    dbLoaded = true;
  }
  console.log('[db] 使用本地文件存储:', DATA_FILE, '（未配置 DATABASE_URL，重新部署会重置，请配置 DATABASE_URL）');
}

let persistTimer = null;
function persist() {
  // 保护 1：存储尚未成功加载时，绝不写盘
  if (!dbLoaded) { console.error('[persist] 已阻止写入：存储尚未就绪，避免覆盖已有数据'); return; }

  const total = db.users.length + db.resumes.length;
  // 保护 2：空库永不覆盖非空库（防止因异常/错误更新清空）
  if (total === 0 && lastStoreCount > 0) {
    console.error('[persist] 已阻止写入：本次为空数据(0) 而现有存储有 ' + lastStoreCount + ' 条记录，拒绝覆盖');
    return;
  }

  if (PG_ENABLED && pool) {
    if (!pgReady) { console.error('[persist] 已阻止写入：Postgres 未就绪'); return; }
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      pool.query(
        'INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()',
        [JSON.stringify(db)]
      ).then(function () { lastStoreCount = total; })
       .catch(function (e) { console.error('[persist]', e.message); });
    }, 150);
    return;
  }

  // 本地文件：滚动备份 + 原子写
  try {
    if (fs.existsSync(DATA_FILE)) {
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch (e) {}
    }
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
    lastStoreCount = total;
  } catch (e) { console.error('[persist]', e.message); }
}"""

rep(old_store, new_store)

# ---------- 2) 启动块：加载失败时不写盘，并周期性重试连接 ----------
old_boot = """(async function () {
  await loadDB();
  persist();
  server.listen(PORT, function () {
    console.log('===========================================');
    console.log(' 车辆与交通学院招新系统 · 云端后端已启动');
    console.log(' 访问地址: http://localhost:' + PORT);
    console.log(' 终端管理员: ' + TERMINAL_USER + ' / ' + TERMINAL_PASS);
    console.log(' 存储方式: ' + ((pool && pgReady) ? 'Postgres（持久）' : '本地文件 ' + DATA_FILE));
    console.log('===========================================');
  });
})();"""

new_boot = """(async function () {
  await loadDB();
  // 仅在成功加载后才写入（首次为空库时写入空结构；已有数据时原样保留）
  if (dbLoaded) persist();

  // 若数据库暂时不可用，定期重试连接，期间拒绝任何破坏性写入
  if (PG_ENABLED && !pgReady) {
    const retry = setInterval(async function () {
      if (pgReady) { clearInterval(retry); return; }
      await loadDB();
      if (pgReady) { clearInterval(retry); console.log('[db] 已恢复连接'); }
    }, 10000);
  }

  server.listen(PORT, function () {
    console.log('===========================================');
    console.log(' 车辆与交通学院招新系统 · 云端后端已启动');
    console.log(' 访问地址: http://localhost:' + PORT);
    console.log(' 终端管理员: ' + TERMINAL_USER + ' / ' + TERMINAL_PASS);
    console.log(' 存储方式: ' + ((pool && pgReady) ? 'Postgres（持久，更新不丢数据）' : '本地文件 ' + DATA_FILE));
    console.log(' 数据保护: 仅允许「本人注销」「终端管理员删除用户」两种删除，更新不丢数据');
    console.log('===========================================');
  });
})();"""

rep(old_boot, new_boot)

open(p, "w", encoding="utf-8").write(s)
print("SAVED server.js len=", len(s))
