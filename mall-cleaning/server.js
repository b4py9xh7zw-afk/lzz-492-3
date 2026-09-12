'use strict';
/**
 * 商场保洁巡检排班系统 - 后端服务
 * 功能: 排班管理 / 扫码签到+照片上传 / 投诉追溯 / 大屏数据 / 员工手机端
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 数据库 ---------------- */
const db = new Database(path.join(DATA_DIR, 'mall.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','cleaner'))
);
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,          -- 点位编码(二维码内容的一部分)
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('restroom','dining','escalator')),
  floor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  cleaner_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,                 -- YYYY-MM-DD
  start_time TEXT NOT NULL,           -- HH:MM
  deadline TEXT NOT NULL,             -- HH:MM
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','missed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  cleaner_id INTEGER NOT NULL REFERENCES users(id),
  checked_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  photo TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  content TEXT NOT NULL,
  contact TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','processing','resolved')),
  last_inspection_id INTEGER REFERENCES inspections(id)   -- 投诉自动追溯的最近巡检
);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date, status);
CREATE INDEX IF NOT EXISTS idx_insp_zone ON inspections(zone_id, checked_at);
`);

const TYPE_LABEL = { restroom: '洗手间', dining: '餐饮区', escalator: '扶梯口' };
const STATUS_LABEL = { pending: '待巡检', done: '已完成', missed: '已超时' };

/* ---------------- 工具 ---------------- */
const pad = n => String(n).padStart(2, '0');
function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function nowHM() { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowStr() { const d = new Date(); return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

/** 将超过截止时间仍未完成的任务标记为"已超时" */
function markMissed() {
  db.prepare(`UPDATE tasks SET status='missed'
              WHERE status='pending' AND (date < ? OR (date = ? AND deadline < ?))`)
    .run(today(), today(), nowHM());
}
setInterval(markMissed, 30 * 1000);

/* ---------------- 种子数据(首次启动) ---------------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return;
  console.log('[seed] 初始化演示数据...');

  const insUser = db.prepare('INSERT INTO users (username,password,name,role) VALUES (?,?,?,?)');
  insUser.run('admin', 'admin123', '刘主管', 'admin');
  const cid = {};
  for (const [u, n] of [['zhang', '张桂芳'], ['li', '李建国'], ['wang', '王秀兰'], ['zhao', '赵铁柱']]) {
    cid[u] = Number(insUser.run(u, '123456', n, 'cleaner').lastInsertRowid);
  }

  const insZone = db.prepare('INSERT INTO zones (code,name,type,floor) VALUES (?,?,?,?)');
  const zid = {};
  const zoneDefs = [
    ['1F-WS-E', '1F 东侧洗手间', 'restroom', '1F'], ['1F-WS-W', '1F 西侧洗手间', 'restroom', '1F'],
    ['1F-ESC-C', '1F 中庭扶梯口', 'escalator', '1F'],
    ['2F-WS-E', '2F 东侧洗手间', 'restroom', '2F'], ['2F-WS-W', '2F 西侧洗手间', 'restroom', '2F'],
    ['2F-ESC-C', '2F 中庭扶梯口', 'escalator', '2F'],
    ['3F-WS-E', '3F 东侧洗手间', 'restroom', '3F'], ['3F-WS-W', '3F 西侧洗手间', 'restroom', '3F'],
    ['3F-ESC-C', '3F 中庭扶梯口', 'escalator', '3F'],
    ['4F-DIN-E', '4F 餐饮区东区', 'dining', '4F'], ['4F-DIN-W', '4F 餐饮区西区', 'dining', '4F'],
    ['4F-DIN-DS', '4F 餐饮区收餐台', 'dining', '4F'], ['4F-ESC-C', '4F 中庭扶梯口', 'escalator', '4F'],
  ];
  for (const [code, name, type, floor] of zoneDefs) {
    zid[code] = Number(insZone.run(code, name, type, floor).lastInsertRowid);
  }

  // 占位巡检照片(种子数据用)
  const seedPhoto = 'seed-placeholder.svg';
  fs.writeFileSync(path.join(UPLOAD_DIR, seedPhoto),
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#e8eef5"/><rect x="24" y="24" width="592" height="432" fill="none" stroke="#9db4c8" stroke-width="4" stroke-dasharray="16 12"/><text x="50%" y="52%" font-size="30" fill="#5b7186" text-anchor="middle" font-family="sans-serif">巡检现场照片(示例)</text></svg>`);

  // 今日排班: [点位, 保洁员, 开始, 截止]
  const plan = [
    ['1F-WS-E', 'zhang', '08:00', '08:30'], ['1F-WS-W', 'zhang', '08:10', '08:40'],
    ['1F-ESC-C', 'zhang', '09:00', '09:30'], ['1F-WS-E', 'zhang', '11:00', '11:30'],
    ['1F-WS-W', 'zhang', '11:10', '11:40'], ['1F-ESC-C', 'zhang', '14:00', '14:30'],
    ['1F-WS-E', 'zhang', '16:00', '16:30'], ['1F-WS-W', 'zhang', '16:10', '16:40'],
    ['2F-WS-E', 'li', '08:00', '08:30'], ['2F-WS-W', 'li', '08:10', '08:40'],
    ['2F-ESC-C', 'li', '09:00', '09:30'], ['2F-WS-E', 'li', '11:00', '11:30'],
    ['2F-WS-W', 'li', '11:10', '11:40'], ['2F-ESC-C', 'li', '14:00', '14:30'],
    ['2F-WS-E', 'li', '16:00', '16:30'], ['2F-WS-W', 'li', '16:10', '16:40'],
    ['3F-WS-E', 'wang', '08:00', '08:30'], ['3F-WS-W', 'wang', '08:10', '08:40'],
    ['3F-ESC-C', 'wang', '09:00', '09:30'], ['3F-WS-E', 'wang', '11:00', '11:30'],
    ['3F-WS-W', 'wang', '11:10', '11:40'], ['3F-ESC-C', 'wang', '14:00', '14:30'],
    ['3F-WS-E', 'wang', '16:00', '16:30'], ['3F-WS-W', 'wang', '16:10', '16:40'],
    ['4F-ESC-C', 'zhao', '09:30', '10:00'], ['4F-DIN-E', 'zhao', '10:00', '10:30'],
    ['4F-DIN-W', 'zhao', '10:10', '10:40'], ['4F-DIN-DS', 'zhao', '11:30', '12:00'],
    ['4F-DIN-E', 'zhao', '13:00', '13:30'], ['4F-DIN-W', 'zhao', '13:10', '13:40'],
    ['4F-DIN-DS', 'zhao', '15:00', '15:30'], ['4F-ESC-C', 'zhao', '17:00', '17:30'],
  ];
  const insTask = db.prepare('INSERT INTO tasks (zone_id,cleaner_id,date,start_time,deadline,status) VALUES (?,?,?,?,?,?)');
  const insInsp = db.prepare('INSERT INTO inspections (task_id,zone_id,cleaner_id,checked_at,photo,note) VALUES (?,?,?,?,?,?)');
  const t = today(), hm = nowHM();
  let pastIdx = 0;
  for (const [code, who, st, dl] of plan) {
    // 截止时间已过的任务: 约 2/3 标记为已完成并补巡检记录, 其余留作"已超时"演示
    const past = dl < hm;
    const done = past && (pastIdx++ % 3 !== 2);
    const r = insTask.run(zid[code], cid[who], t, st, dl, done ? 'done' : 'pending');
    if (done) {
      insInsp.run(Number(r.lastInsertRowid), zid[code], cid[who], `${t} ${st}:00`, seedPhoto, '例行巡检,现场正常');
    }
  }
  // 一条已追溯的演示投诉
  const last = db.prepare('SELECT * FROM inspections WHERE zone_id=? ORDER BY checked_at DESC LIMIT 1').get(zid['1F-WS-E']);
  if (last) {
    db.prepare('INSERT INTO complaints (zone_id,content,contact,created_at,status,last_inspection_id) VALUES (?,?,?,?,?,?)')
      .run(zid['1F-WS-E'], '洗手间地面有水渍,异味较重,请尽快处理', '138****0000', `${t} ${nowHM()}:00`, 'open', last.id);
  }
  markMissed();
  console.log('[seed] 完成: 4名保洁员, 13个点位, ' + plan.length + '条今日任务');
}
seed();

/* ---------------- 会话 ---------------- */
const sessions = new Map(); // token -> userId
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const uid = h.startsWith('Bearer ') && sessions.get(h.slice(7));
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = db.prepare('SELECT id,username,name,role FROM users WHERE id=?').get(uid);
  if (!req.user) return res.status(401).json({ error: '用户不存在' });
  next();
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: '仅主管可操作' });
const cleanerOnly = (req, res, next) => req.user.role === 'cleaner' ? next() : res.status(403).json({ error: '仅保洁员可操作' });

/* ---------------- 上传 ---------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname || '') || '.jpg'}`)
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

/* ---------------- 路由 ---------------- */
const app = express();
app.use(express.json());

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(String(username || ''), String(password || ''));
  if (!u) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, u.id);
  res.json({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.post('/api/logout', auth, (req, res) => {
  sessions.delete((req.headers.authorization || '').slice(7));
  res.json({ ok: true });
});

// 点位
app.get('/api/zones', (req, res) => {
  res.json(db.prepare('SELECT * FROM zones ORDER BY floor, type, code').all()
    .map(z => ({ ...z, type_label: TYPE_LABEL[z.type] })));
});
app.post('/api/zones', auth, adminOnly, (req, res) => {
  const { code, name, type, floor } = req.body || {};
  if (!code || !name || !TYPE_LABEL[type] || !floor) return res.status(400).json({ error: '参数不完整或类型无效' });
  try {
    const r = db.prepare('INSERT INTO zones (code,name,type,floor) VALUES (?,?,?,?)')
      .run(String(code).trim(), String(name).trim(), type, String(floor).trim());
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  } catch { res.status(400).json({ error: '点位编码已存在' }); }
});
// 点位二维码: type=checkin(员工签到) | complaint(顾客投诉)
app.get('/api/zones/:id/qrcode', async (req, res) => {
  const z = db.prepare('SELECT * FROM zones WHERE id=?').get(req.params.id);
  if (!z) return res.status(404).end();
  const base = `${req.protocol}://${req.get('host')}`;
  const url = req.query.type === 'complaint'
    ? `${base}/complaint.html?zone=${encodeURIComponent(z.code)}`
    : `${base}/mobile.html#/checkin/${encodeURIComponent(z.code)}`;
  res.type('png').send(await QRCode.toBuffer(url, { width: 360, margin: 1 }));
});

// 保洁员列表
app.get('/api/cleaners', auth, adminOnly, (req, res) => {
  res.json(db.prepare("SELECT id,username,name FROM users WHERE role='cleaner' ORDER BY id").all());
});

// 排班
app.post('/api/tasks', auth, adminOnly, (req, res) => {
  const { zone_ids, cleaner_id, date, start_time, deadline } = req.body || {};
  if (!Array.isArray(zone_ids) || !zone_ids.length) return res.status(400).json({ error: '请选择点位' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(start_time || '') || !/^\d{2}:\d{2}$/.test(deadline || ''))
    return res.status(400).json({ error: '日期或时间格式不正确' });
  if (deadline <= start_time) return res.status(400).json({ error: '截止时间必须晚于开始时间' });
  const cleaner = db.prepare("SELECT * FROM users WHERE id=? AND role='cleaner'").get(cleaner_id);
  if (!cleaner) return res.status(400).json({ error: '保洁员不存在' });
  const ins = db.prepare('INSERT INTO tasks (zone_id,cleaner_id,date,start_time,deadline) VALUES (?,?,?,?,?)');
  const dup = db.prepare('SELECT id FROM tasks WHERE zone_id=? AND cleaner_id=? AND date=? AND start_time=?');
  let created = 0;
  for (const z of zone_ids) {
    if (!db.prepare('SELECT id FROM zones WHERE id=?').get(z)) continue;
    if (dup.get(z, cleaner_id, date, start_time)) continue;
    ins.run(z, cleaner_id, date, start_time, deadline); created++;
  }
  markMissed();
  res.json({ ok: true, created });
});
const taskRows = (where, ...params) => db.prepare(
  `SELECT t.*, z.name zone_name, z.type, z.floor, z.code zone_code, u.name cleaner_name
   FROM tasks t JOIN zones z ON z.id=t.zone_id JOIN users u ON u.id=t.cleaner_id ${where}`)
  .all(...params)
  .map(r => ({ ...r, type_label: TYPE_LABEL[r.type], status_label: STATUS_LABEL[r.status] }));
app.get('/api/tasks', auth, adminOnly, (req, res) => {
  markMissed();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  let where = 'WHERE t.date=?'; const params = [date];
  if (STATUS_LABEL[req.query.status]) { where += ' AND t.status=?'; params.push(req.query.status); }
  res.json(taskRows(where + ' ORDER BY t.start_time, z.floor, z.code', ...params));
});
app.delete('/api/tasks/:id', auth, adminOnly, (req, res) => {
  const r = db.prepare("DELETE FROM tasks WHERE id=? AND status!='done'").run(req.params.id);
  res.json({ ok: true, deleted: r.changes });
});

// 员工: 我的今日路线(只能看自己)
app.get('/api/my/tasks', auth, cleanerOnly, (req, res) => {
  markMissed();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const rows = db.prepare(
    `SELECT t.id, t.date, t.start_time, t.deadline, t.status,
            z.id zone_id, z.name zone_name, z.type, z.floor, z.code zone_code,
            i.checked_at, i.photo
     FROM tasks t JOIN zones z ON z.id=t.zone_id
     LEFT JOIN inspections i ON i.task_id=t.id
     WHERE t.cleaner_id=? AND t.date=? ORDER BY t.start_time, z.floor`).all(req.user.id, date);
  res.json(rows.map(r => ({ ...r, type_label: TYPE_LABEL[r.type], status_label: STATUS_LABEL[r.status] })));
});

// 员工: 扫码签到 + 上传现场照片
app.post('/api/checkin', auth, cleanerOnly, upload.single('photo'), (req, res) => {
  const { zone_code, task_id, note } = req.body || {};
  const zone = db.prepare('SELECT * FROM zones WHERE code=?').get(String(zone_code || '').trim());
  if (!zone) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: '二维码无效,未找到对应点位' }); }
  if (!req.file) return res.status(400).json({ error: '请上传现场照片' });

  let task = null;
  if (task_id) {
    task = db.prepare('SELECT * FROM tasks WHERE id=?').get(task_id);
    if (!task || task.cleaner_id !== req.user.id) { fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: '任务不存在或不属于当前员工' }); }
    if (task.zone_id !== zone.id) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: `扫码点位与任务不符,该任务应到「${db.prepare('SELECT name FROM zones WHERE id=?').get(task.zone_id).name}」签到` }); }
    if (task.status === 'done') { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: '该任务已完成,请勿重复签到' }); }
  } else {
    // 未指定任务: 自动匹配本人今日在该点位的待办任务
    task = db.prepare(`SELECT * FROM tasks WHERE zone_id=? AND cleaner_id=? AND date=? AND status!='done'
                       ORDER BY deadline LIMIT 1`).get(zone.id, req.user.id, today());
  }
  const late = task ? (task.date < today() || (task.date === today() && nowHM() > task.deadline)) : false;
  const r = db.prepare('INSERT INTO inspections (task_id,zone_id,cleaner_id,checked_at,photo,note) VALUES (?,?,?,?,?,?)')
    .run(task ? task.id : null, zone.id, req.user.id, nowStr(), req.file.filename, String(note || '').slice(0, 200));
  if (task) db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id);
  res.json({
    ok: true, late, matched_task: !!task,
    message: task ? (late ? '签到成功(已超过截止时间)' : '签到成功') : '签到成功(额外巡检,未关联排班任务)',
    inspection_id: Number(r.lastInsertRowid)
  });
});

// 巡检记录(管理端)
app.get('/api/inspections', auth, adminOnly, (req, res) => {
  const conds = [], params = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')) { conds.push('date(i.checked_at)=?'); params.push(req.query.date); }
  if (req.query.zone_id) { conds.push('i.zone_id=?'); params.push(req.query.zone_id); }
  const sql = `SELECT i.*, z.name zone_name, z.type, z.floor, z.code zone_code, u.name cleaner_name
               FROM inspections i JOIN zones z ON z.id=i.zone_id JOIN users u ON u.id=i.cleaner_id
               ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY i.checked_at DESC LIMIT 200`;
  res.json(db.prepare(sql).all(...params).map(r => ({ ...r, type_label: TYPE_LABEL[r.type] })));
});

// 投诉: 顾客提交(公开), 自动追溯该点位最近一次巡检
app.post('/api/complaints', (req, res) => {
  const { zone_code, content, contact } = req.body || {};
  const z = db.prepare('SELECT * FROM zones WHERE code=?').get(String(zone_code || ''));
  if (!z) return res.status(400).json({ error: '点位无效' });
  if (!String(content || '').trim()) return res.status(400).json({ error: '请填写问题描述' });
  const last = db.prepare('SELECT * FROM inspections WHERE zone_id=? ORDER BY checked_at DESC LIMIT 1').get(z.id);
  const r = db.prepare('INSERT INTO complaints (zone_id,content,contact,last_inspection_id) VALUES (?,?,?,?)')
    .run(z.id, String(content).trim().slice(0, 500), String(contact || '').slice(0, 50), last ? last.id : null);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});
// 投诉列表(管理端, 含追溯到的巡检与责任人)
app.get('/api/complaints', auth, adminOnly, (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, z.name zone_name, z.floor, z.type, z.code zone_code,
            i.checked_at insp_time, i.photo insp_photo, i.note insp_note, u.name insp_cleaner
     FROM complaints c JOIN zones z ON z.id=c.zone_id
     LEFT JOIN inspections i ON i.id=c.last_inspection_id
     LEFT JOIN users u ON u.id=i.cleaner_id
     ORDER BY c.id DESC LIMIT 100`).all();
  res.json(rows.map(r => ({
    ...r, type_label: TYPE_LABEL[r.type],
    minutes_since_inspection: r.insp_time
      ? Math.round((new Date(r.created_at.replace(' ', 'T')) - new Date(r.insp_time.replace(' ', 'T'))) / 60000) : null
  })));
});
app.put('/api/complaints/:id', auth, adminOnly, (req, res) => {
  const { status } = req.body || {};
  if (!['open', 'processing', 'resolved'].includes(status)) return res.status(400).json({ error: '状态无效' });
  db.prepare('UPDATE complaints SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ ok: true });
});

// 大屏数据(公开)
app.get('/api/screen', (req, res) => {
  markMissed();
  const t = today();
  const tasks = taskRows('WHERE t.date=?', t);
  const stats = { total: tasks.length, done: 0, pending: 0, missed: 0 };
  for (const x of tasks) stats[x.status]++;
  const pending = tasks.filter(x => x.status !== 'done')
    .sort((a, b) => a.floor.localeCompare(b.floor) || a.deadline.localeCompare(b.deadline));
  const recentDone = db.prepare(
    `SELECT i.checked_at, z.name zone_name, z.floor, u.name cleaner_name
     FROM inspections i JOIN zones z ON z.id=i.zone_id JOIN users u ON u.id=i.cleaner_id
     WHERE date(i.checked_at)=? ORDER BY i.checked_at DESC LIMIT 10`).all(t);
  const complaints = db.prepare(
    `SELECT c.id, c.content, c.created_at, c.status, z.name zone_name, z.floor
     FROM complaints c JOIN zones z ON z.id=c.zone_id
     WHERE c.status!='resolved' ORDER BY c.id DESC LIMIT 6`).all();
  res.json({ now: nowStr(), date: t, stats, pending, recentDone, complaints });
});

/* ---------------- 静态资源 ---------------- */
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/', (req, res) => res.redirect('/admin.html'));

// 统一错误处理(含 multer)
app.use((err, req, res, next) => {
  if (err) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '照片大小不能超过10MB'
      : err.message === 'Unexpected field' ? '上传字段错误' : '服务器错误: ' + err.message;
    return res.status(400).json({ error: msg });
  }
  next();
});

app.listen(PORT, () => console.log(`商场保洁巡检系统已启动: http://localhost:${PORT}`));
