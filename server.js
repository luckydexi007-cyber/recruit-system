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
const TERMINAL_PASS = process.env.TERMINAL_PASS || 'admin123';
const ALL_DEPTS = ['办公室', '组织部', '宣传部', '学习部', '文体部', '生活心理部'];

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */
let db = { users: [], resumes: [], sessions: {} };

let pool = null;
let pgReady = false;
try {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
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
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
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
    const u = findUserByStudentId(sid);
    if (!u || !u.isAdmin || u.passwordHash !== hashPassword(password, u.salt)) {
      send(res, 401, { error: '管理员账号或密码错误' }); return true;
    }
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
    if (username !== TERMINAL_USER || password !== TERMINAL_PASS) {
      send(res, 401, { error: '终端管理员账号或密码错误' }); return true;
    }
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
  persist();
  server.listen(PORT, function () {
    console.log('===========================================');
    console.log(' 车辆与交通学院招新系统 · 云端后端已启动');
    console.log(' 访问地址: http://localhost:' + PORT);
    console.log(' 终端管理员: ' + TERMINAL_USER + ' / ' + TERMINAL_PASS);
    console.log(' 存储方式: ' + ((pool && pgReady) ? 'Postgres（持久）' : '本地文件 ' + DATA_FILE));
    console.log('===========================================');
  });
})();
