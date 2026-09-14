/*
 * 车辆与交通学院·团总支学生会 招新系统 —— 云端后端服务
 * 数据存储：优先使用 Postgres（环境变量 DATABASE_URL），部署迭代后数据不丢失；
 *          未配置 DATABASE_URL 时回退到本地 data.json（仅本地开发用）。
 * 启动：node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(process.env.DATA_DIR || ROOT, 'data.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MAX_ADMINS = 100;
const MAX_BODY = 20 * 1024 * 1024;           // 20MB（附件以 base64 内嵌）
const MAX_FILE = 5 * 1024 * 1024;            // 单附件 5MB
const TERMINAL_USER = process.env.TERMINAL_USER || 'admin';
const TERMINAL_PASS = process.env.TERMINAL_PASS || '';  // 未配置则禁止登录，不再回退弱口令

/* ==================================================================
 * 安全防护层
 *   1) 安全码（SECURITY_CODE）：管理员 / 终端管理员登录时额外校验，
 *      攻击者即便拿到账号密码，没有安全码也无法登录。
 *      通过 Render 环境变量 SECURITY_CODE 配置；设为空字符串即关闭。
 *   2) 全局限流：同一 IP 每时间窗请求次数上限，超限返回 429。
 *   3) 登录防爆破：同一 IP+账号 连续失败达上限后锁定冷却。
 * ================================================================== */
const SECURITY_CODE = (process.env.SECURITY_CODE !== undefined)
  ? String(process.env.SECURITY_CODE) : '';  // 未配置则关闭安全码，避免仓库硬编码泄露默认值
const RATE_WINDOW_MS = 60 * 1000;      // 限流时间窗：1 分钟
const RATE_MAX_REQ = 150;              // 每窗口每 IP 最大请求数
const LOGIN_MAX_FAIL = 5;              // 连续失败上限
const LOGIN_LOCK_MS = 10 * 60 * 1000;  // 锁定时长：10 分钟

const rateBuckets = new Map();         // ip -> { count, start }
const loginFails = new Map();          // ip+account -> { count, lockUntil }

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimited(ip) {
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > RATE_WINDOW_MS) { b = { count: 0, start: now }; rateBuckets.set(ip, b); }
  b.count++;
  if (rateBuckets.size > 5000) {
    rateBuckets.forEach(function (v, k) { if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k); });
  }
  return b.count > RATE_MAX_REQ;
}
function securityCodeOk(provided) {
  if (!SECURITY_CODE) return true;   // 未配置安全码 → 不启用
  return String(provided == null ? '' : provided) === SECURITY_CODE;
}
function loginLocked(key) {
  const now = Date.now();
  const f = loginFails.get(key);
  if (f && f.lockUntil && now < f.lockUntil) return Math.ceil((f.lockUntil - now) / 1000);
  return 0;
}
function recordLoginFail(key) {
  const now = Date.now();
  let f = loginFails.get(key);
  if (!f || (f.lockUntil && now >= f.lockUntil)) f = { count: 0, lockUntil: 0 };
  f.count++;
  if (f.count >= LOGIN_MAX_FAIL) { f.lockUntil = now + LOGIN_LOCK_MS; f.count = 0; }
  loginFails.set(key, f);
  return f.count;
}
function clearLoginFail(key) { loginFails.delete(key); }
const ALL_DEPTS = ['办公室', '组织部', '宣传部', '学习部', '文体部', '生活心理部'];

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */
let db = { users: [], resumes: [], sessions: {} };

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
  return pathname === '/api/account' || /^\/api\/users\/[^/]+$/.test(pathname);
}

let pool = null;
let pgReady = false;
const PG_ENABLED = !!process.env.DATABASE_URL;
try {
  if (PG_ENABLED) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
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
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */
function genId() { return 'R' + Date.now() + crypto.randomBytes(2).toString('hex'); }
function hashPassword(pwd, salt) {
  return crypto.pbkdf2Sync(String(pwd), salt, 100000, 64, 'sha512').toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(24).toString('hex'); }

function publicUser(u) {
  return {
    id: u.id, studentId: u.studentId, name: u.name, class: u.class,
    phone: u.phone, email: u.email || '', createdAt: u.createdAt, isAdmin: !!u.isAdmin
  };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  if (!token || !db.sessions[token]) return null;
  return Object.assign({ token: token }, db.sessions[token]);
}

function findUserById(id) { return db.users.find(function (u) { return u.id === id; }); }
function findUserByStudentId(sid) { return db.users.find(function (u) { return u.studentId === sid; }); }

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp'
};

function sendFile(res, filePath, data) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  // 安全：拦截后端代码、配置与数据文件（含根目录回退路径）
  const BLOCK_BASENAMES = /^(server\.js|package\.json|package-lock\.json|data\.json|render\.yaml|procfile|readme\.md|app\.json|dockerfile|\.env|\.gitignore)$/i;
  const BLOCK_EXTS = /\.(py|zip|bat|cmd|sh|log|bak|tmp|sql|map|md|yml|yaml|env|ini|conf|json5)$/i;
  const segs = safe.split('/');
  const baseLower = path.basename(safe).toLowerCase();
  if (segs.some(function (s) { return s.charAt(0) === '.'; }) || BLOCK_BASENAMES.test(baseLower) || BLOCK_EXTS.test(baseLower)) {
    notFound(res); return;
  }
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (!err) return sendFile(res, filePath, data);
    // 兼容：网页直接放在仓库根目录（没有 public 文件夹）的情况
    const alt = path.join(ROOT, safe);
    if (!alt.startsWith(ROOT) || alt.startsWith(PUBLIC_DIR)) { notFound(res); return; }
    fs.readFile(alt, function (err2, data2) {
      if (err2) { notFound(res); return; }
      sendFile(res, alt, data2);
    });
  });
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */
async function handleApi(method, pathname, body, req, res) {
  const session = auth(req);

  if (method === 'GET' && pathname === '/api/health') { send(res, 200, { ok: true, ts: Date.now(), storage: (pool && pgReady) ? 'postgres' : 'file' }); return true; }

  if (method === 'GET' && pathname === '/api/me') {
    if (!session) { send(res, 200, { user: null, isAdmin: false, isTerminal: false }); return true; }
    if (session.isTerminal) {
      send(res, 200, { user: { id: 'admin', name: '终端管理员', isTerminal: true }, isAdmin: true, isTerminal: true });
      return true;
    }
    const u = findUserById(session.userId);
    if (!u) { delete db.sessions[session.token]; persist(); send(res, 200, { user: null, isAdmin: false, isTerminal: false }); return true; }
    send(res, 200, { user: publicUser(u), isAdmin: !!session.isAdmin, isTerminal: false });
    return true;
  }

  // ---- 注册 ----
  if (method === 'POST' && pathname === '/api/register') {
    const sid = String(body.studentId || '').trim();
    const name = String(body.name || '').trim();
    const cls = String(body.class || '').trim();
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    if (!sid || !/^\d{14}$/.test(sid)) { send(res, 400, { error: '学号需为14位数字' }); return true; }
    if (!name) { send(res, 400, { error: '请输入姓名' }); return true; }
    if (!cls) { send(res, 400, { error: '请输入班级' }); return true; }
    if (!phone) { send(res, 400, { error: '请输入手机号' }); return true; }
    if (password.length < 6) { send(res, 400, { error: '密码至少6位' }); return true; }
    if (findUserByStudentId(sid)) { send(res, 409, { error: '该学号已注册，请直接登录' }); return true; }
    const salt = newSalt();
    const user = {
      id: genId(), studentId: sid, name: name, class: cls, phone: phone, email: email,
      salt: salt, passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(), isAdmin: false
    };
    db.users.push(user); persist();
    send(res, 200, { ok: true, user: publicUser(user) });
    return true;
  }

  // ---- 用户登录 ----
  if (method === 'POST' && pathname === '/api/login') {
    const sid = String(body.studentId || '').trim();
    const password = String(body.password || '');
    const u = findUserByStudentId(sid);
    if (!u || u.passwordHash !== hashPassword(password, u.salt)) { send(res, 401, { error: '学号或密码错误' }); return true; }
    const token = newToken();
    db.sessions[token] = { userId: u.id, isAdmin: false, isTerminal: false };
    persist();
    send(res, 200, { token: token, user: publicUser(u), isAdmin: false, isTerminal: false });
    return true;
  }

  // ---- 管理员登录 ----
  if (method === 'POST' && pathname === '/api/admin/login') {
    const sid = String(body.studentId || '').trim();
    const password = String(body.password || '');
    const lockKey = 'a:' + clientIp(req) + ':' + sid;
    const locked = loginLocked(lockKey);
    if (locked) { send(res, 429, { error: '尝试次数过多，请 ' + locked + ' 秒后再试' }); return true; }
    if (!securityCodeOk(body.securityCode)) { recordLoginFail(lockKey); send(res, 401, { error: '安全码错误' }); return true; }
    const u = findUserByStudentId(sid);
    if (!u || !u.isAdmin || u.passwordHash !== hashPassword(password, u.salt)) {
      recordLoginFail(lockKey);
      send(res, 401, { error: '管理员账号或密码错误' }); return true;
    }
    clearLoginFail(lockKey);
    const token = newToken();
    db.sessions[token] = { userId: u.id, isAdmin: true, isTerminal: false };
    persist();
    send(res, 200, { token: token, user: publicUser(u), isAdmin: true, isTerminal: false });
    return true;
  }

  // ---- 终端管理员登录 ----
  if (method === 'POST' && pathname === '/api/terminal/login') {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const lockKey = 't:' + clientIp(req) + ':' + username;
    const locked = loginLocked(lockKey);
    if (locked) { send(res, 429, { error: '尝试次数过多，请 ' + locked + ' 秒后再试' }); return true; }
    if (!securityCodeOk(body.securityCode)) { recordLoginFail(lockKey); send(res, 401, { error: '安全码错误' }); return true; }
    if (!TERMINAL_PASS || username !== TERMINAL_USER || password !== TERMINAL_PASS) {
      recordLoginFail(lockKey);
      send(res, 401, { error: '终端管理员账号或密码错误' }); return true;
    }
    clearLoginFail(lockKey);
    const token = newToken();
    db.sessions[token] = { userId: null, isAdmin: true, isTerminal: true };
    persist();
    send(res, 200, { token: token, user: { id: 'admin', name: '终端管理员', isTerminal: true }, isAdmin: true, isTerminal: true });
    return true;
  }

  // ---- 退出 ----
  if (method === 'POST' && pathname === '/api/logout') {
    if (session) { delete db.sessions[session.token]; persist(); }
    send(res, 200, { ok: true });
    return true;
  }

  // ---- 注销账户（用户本人永久删除自己的账号与全部数据） ----
  if (method === 'DELETE' && pathname === '/api/account') {
    if (!session || !session.userId) { send(res, 403, { error: '请先登录用户账号' }); return true; }
    const id = session.userId;
    db.users = db.users.filter(function (u) { return u.id !== id; });
    db.resumes = db.resumes.filter(function (r) { return r.userId !== id; });
    Object.keys(db.sessions).forEach(function (t) { if (db.sessions[t].userId === id) delete db.sessions[t]; });
    persist();
    send(res, 200, { ok: true });
    return true;
  }

  /* ---------------- 简历 ---------------- */
  if (method === 'GET' && pathname === '/api/resumes') {
    if (!session || !session.isAdmin) { send(res, 403, { error: '无权限' }); return true; }
    send(res, 200, { resumes: db.resumes });
    return true;
  }

  if (method === 'GET' && pathname === '/api/resumes/mine') {
    if (!session || session.isTerminal || !session.userId) { send(res, 200, { resume: null }); return true; }
    const r = db.resumes.find(function (x) { return x.userId === session.userId; });
    send(res, 200, { resume: r || null });
    return true;
  }

  if (method === 'POST' && pathname === '/api/resumes') {
    if (!session || session.isTerminal || !session.userId) { send(res, 403, { error: '请先登录用户账号' }); return true; }
    const u = findUserById(session.userId);
    if (!u) { send(res, 403, { error: '用户不存在' }); return true; }
    if (db.resumes.find(function (r) { return r.userId === u.id; })) { send(res, 409, { error: '你已经投递过简历，不能重复投递' }); return true; }

    const name = String(body.name || '').trim();
    const cls = String(body.className || '').trim();
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    const departments = Array.isArray(body.departments) ? body.departments.filter(function (d) { return ALL_DEPTS.includes(d); }) : [];
    if (!name || !cls || !phone) { send(res, 400, { error: '请填写必填字段' }); return true; }
    if (departments.length === 0) { send(res, 400, { error: '请至少选择一个意向部门' }); return true; }
    if (departments.length > 3) { send(res, 400, { error: '最多可选择3个意向部门' }); return true; }

    let file = null;
    if (body.file && body.file.data) {
      if (body.file.size > MAX_FILE) { send(res, 400, { error: '文件大小不能超过5MB' }); return true; }
      file = { name: String(body.file.name || 'attachment'), size: Number(body.file.size) || 0, type: String(body.file.type || ''), data: String(body.file.data) };
    }

    const resume = {
      id: genId(), userId: u.id, name: name, studentId: u.studentId, className: cls,
      phone: phone, email: email, departments: departments,
      intro: String(body.intro || ''), skills: String(body.skills || ''),
      awards: String(body.awards || ''), prevPosition: String(body.prevPosition || ''),
      file: file, status: 'pending', admittedDepartment: null, admittedType: null,
      submittedAt: new Date().toISOString()
    };
    db.resumes.push(resume); persist();
    send(res, 200, { ok: true, resume: resume });
    return true;
  }

  let m = pathname.match(/^\/api\/resumes\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    if (!session) { send(res, 403, { error: '无权限' }); return true; }
    const id = m[1];
    const idx = db.resumes.findIndex(function (r) { return r.id === id; });
    if (idx < 0) { send(res, 404, { error: '简历不存在' }); return true; }
    const owner = session.userId && db.resumes[idx].userId === session.userId;
    if (!session.isAdmin && !owner) { send(res, 403, { error: '无权限' }); return true; }
    db.resumes.splice(idx, 1); persist();
    send(res, 200, { ok: true });
    return true;
  }

  m = pathname.match(/^\/api\/resumes\/([^/]+)\/admit$/);
  if (method === 'POST' && m) {
    if (!session || !session.isAdmin) { send(res, 403, { error: '无权限' }); return true; }
    const r = db.resumes.find(function (x) { return x.id === m[1]; });
    if (!r) { send(res, 404, { error: '简历不存在' }); return true; }
    const dept = String(body.department || '');
    if (!r.departments.includes(dept)) { send(res, 400, { error: '只能录取至该生填报的意向部门' }); return true; }
    r.status = 'admitted'; r.admittedDepartment = dept; r.admittedType = 'direct';
    persist();
    send(res, 200, { ok: true, resume: r });
    return true;
  }

  m = pathname.match(/^\/api\/resumes\/([^/]+)\/reallocate$/);
  if (method === 'POST' && m) {
    if (!session || !session.isAdmin) { send(res, 403, { error: '无权限' }); return true; }
    const r = db.resumes.find(function (x) { return x.id === m[1]; });
    if (!r) { send(res, 404, { error: '简历不存在' }); return true; }
    const dept = String(body.department || '');
    if (!ALL_DEPTS.includes(dept)) { send(res, 400, { error: '请选择有效部门' }); return true; }
    if (r.departments.includes(dept)) { send(res, 400, { error: '调剂部门不能是该生的意向部门' }); return true; }
    r.status = 'admitted'; r.admittedDepartment = dept; r.admittedType = 'reallocate';
    persist();
    send(res, 200, { ok: true, resume: r });
    return true;
  }

  m = pathname.match(/^\/api\/resumes\/([^/]+)\/reject$/);
  if (method === 'POST' && m) {
    if (!session || !session.isAdmin) { send(res, 403, { error: '无权限' }); return true; }
    const r = db.resumes.find(function (x) { return x.id === m[1]; });
    if (!r) { send(res, 404, { error: '简历不存在' }); return true; }
    r.status = 'rejected'; r.admittedDepartment = null; r.admittedType = null;
    persist();
    send(res, 200, { ok: true, resume: r });
    return true;
  }

  /* ---------------- 用户管理（仅终端管理员） ---------------- */
  if (method === 'GET' && pathname === '/api/users') {
    if (!session || !session.isTerminal) { send(res, 403, { error: '无权限' }); return true; }
    send(res, 200, { users: db.users.map(publicUser), resumes: db.resumes, maxAdmins: MAX_ADMINS });
    return true;
  }

  m = pathname.match(/^\/api\/users\/([^/]+)\/promote$/);
  if (method === 'POST' && m) {
    if (!session || !session.isTerminal) { send(res, 403, { error: '无权限' }); return true; }
    const u = findUserById(m[1]);
    if (!u) { send(res, 404, { error: '用户不存在' }); return true; }
    const count = db.users.filter(function (x) { return x.isAdmin; }).length;
    if (!u.isAdmin && count >= MAX_ADMINS) { send(res, 400, { error: '管理员数量已达上限(' + MAX_ADMINS + ')' }); return true; }
    u.isAdmin = true; persist();
    send(res, 200, { ok: true, user: publicUser(u) });
    return true;
  }

  m = pathname.match(/^\/api\/users\/([^/]+)\/demote$/);
  if (method === 'POST' && m) {
    if (!session || !session.isTerminal) { send(res, 403, { error: '无权限' }); return true; }
    const u = findUserById(m[1]);
    if (!u) { send(res, 404, { error: '用户不存在' }); return true; }
    u.isAdmin = false; persist();
    send(res, 200, { ok: true, user: publicUser(u) });
    return true;
  }

  m = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (method === 'DELETE' && m) {
    if (!session || !session.isTerminal) { send(res, 403, { error: '无权限' }); return true; }
    const id = m[1];
    const existed = findUserById(id);
    if (!existed) { send(res, 404, { error: '用户不存在' }); return true; }
    db.users = db.users.filter(function (u) { return u.id !== id; });
    db.resumes = db.resumes.filter(function (r) { return r.userId !== id; });
    Object.keys(db.sessions).forEach(function (t) { if (db.sessions[t].userId === id) delete db.sessions[t]; });
    persist();
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */
const server = http.createServer(async function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method.toUpperCase();
  // 安全响应头（防 MIME 嗅探、防被嵌入、限制 referrer）
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block'); res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()'); res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  // 全局限流：同一 IP 每时间窗请求超限 → 429
  if (rateLimited(clientIp(req))) { send(res, 429, { error: '请求过于频繁，请稍后再试' }); return; }
  try {
    if (pathname.startsWith('/api/')) {
      const body = (method === 'POST' || method === 'PUT' || method === 'DELETE') ? await readBody(req) : {};
      const handled = await handleApi(method, pathname, body, req, res);
      if (!handled) send(res, 404, { error: '接口不存在' });
      return;
    }
    serveStatic(pathname, res);
  } catch (err) {
    console.error('[error]', err.message);
    if (!res.headersSent) send(res, 400, { error: err.message || '请求错误' });
  }
});

(async function () {
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
    console.log(' 终端管理员账号: ' + TERMINAL_USER + '（密码已隐藏）'); /* 终端密码不再打印到日志 */
    console.log(' 存储方式: ' + ((pool && pgReady) ? 'Postgres（持久，更新不丢数据）' : '本地文件 ' + DATA_FILE));
    console.log(' 数据保护: 仅允许「本人注销」「终端管理员删除用户」两种删除，更新不丢数据');
    console.log('===========================================');
  });
})();
