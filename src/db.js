'use strict';
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees (
  id              INTEGER PRIMARY KEY,
  full_name       TEXT NOT NULL,
  sheet_name      TEXT NOT NULL UNIQUE,
  phone           TEXT,
  first_work_date TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_rates (
  id             INTEGER PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  hourly_rate    INTEGER NOT NULL,
  effective_from TEXT NOT NULL,
  UNIQUE (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS work_weeks (
  id          INTEGER PRIMARY KEY,
  week_start  TEXT NOT NULL UNIQUE,
  week_end    TEXT NOT NULL,
  sheet_link  TEXT,
  is_closed   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','synced','calculated','locked','paid'))
);

CREATE TABLE IF NOT EXISTS sheet_imports (
  id            INTEGER PRIMARY KEY,
  work_week_id  INTEGER NOT NULL REFERENCES work_weeks(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  imported_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shifts (
  id             INTEGER PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_week_id   INTEGER NOT NULL REFERENCES work_weeks(id) ON DELETE CASCADE,
  work_date      TEXT NOT NULL,
  day_code       TEXT NOT NULL CHECK (day_code IN ('FRI','SAT','SUN')),
  raw_in         TEXT,
  raw_out        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('worked','off','not_registered','error')),
  in_minute      INTEGER,
  out_minute     INTEGER,
  worked_minutes INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'sheet' CHECK (source IN ('sheet','manual')),
  import_id      INTEGER REFERENCES sheet_imports(id) ON DELETE SET NULL,
  error          TEXT,
  UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS allowance_types (
  code            TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  default_amount  INTEGER NOT NULL,
  exclusive_group TEXT,
  max_per_day     INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shift_events (
  id         INTEGER PRIMARY KEY,
  shift_id   INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  code       TEXT NOT NULL REFERENCES allowance_types(code),
  quantity   INTEGER NOT NULL DEFAULT 1,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (shift_id, code)
);

CREATE TABLE IF NOT EXISTS pay_rules (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('all','assigned')),
  params_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_rule_assignments (
  id              INTEGER PRIMARY KEY,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  rule_code       TEXT NOT NULL REFERENCES pay_rules(code),
  amount_override INTEGER,
  UNIQUE (employee_id, rule_code)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id             INTEGER PRIMARY KEY,
  work_week_id   INTEGER NOT NULL REFERENCES work_weeks(id) ON DELETE CASCADE,
  run_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status         TEXT NOT NULL CHECK (status IN ('draft','final','void')),
  rules_snapshot TEXT NOT NULL,
  total_amount   INTEGER NOT NULL,
  locked_at      TEXT,
  paid_at        TEXT
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id               INTEGER PRIMARY KEY,
  payroll_run_id   INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id      INTEGER NOT NULL REFERENCES employees(id),
  worked_minutes   INTEGER NOT NULL,
  base_amount      INTEGER NOT NULL,
  allowance_amount INTEGER NOT NULL,
  total_amount     INTEGER NOT NULL,
  UNIQUE (payroll_run_id, employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_item_lines (
  id              INTEGER PRIMARY KEY,
  payroll_item_id INTEGER NOT NULL REFERENCES payroll_items(id) ON DELETE CASCADE,
  shift_id        INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  work_date       TEXT,
  rule_code       TEXT NOT NULL,
  description     TEXT NOT NULL,
  quantity        REAL NOT NULL DEFAULT 1,
  unit_amount     INTEGER NOT NULL,
  amount          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance_periods (
  id             INTEGER PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  cycle_start    TEXT NOT NULL,
  cycle_end      TEXT NOT NULL,
  days_absent    INTEGER NOT NULL,
  eligible       INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  paid_in_run_id INTEGER REFERENCES payroll_runs(id) ON DELETE SET NULL,
  UNIQUE (employee_id, cycle_start)
);

CREATE TABLE IF NOT EXISTS week_tips (
  id           INTEGER PRIMARY KEY,
  work_week_id INTEGER NOT NULL REFERENCES work_weeks(id) ON DELETE CASCADE,
  day_code     TEXT NOT NULL CHECK (day_code IN ('FRI','SAT','SUN')),
  amount       INTEGER NOT NULL,             -- đồng
  raw_value    TEXT,
  source       TEXT NOT NULL DEFAULT 'sheet' CHECK (source IN ('sheet','manual')),
  UNIQUE (work_week_id, day_code)
);

CREATE TABLE IF NOT EXISTS deductions (
  id           INTEGER PRIMARY KEY,
  work_week_id INTEGER NOT NULL REFERENCES work_weeks(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date    TEXT,                          -- NULL = phạt cả tuần
  amount       INTEGER NOT NULL CHECK (amount > 0),
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS banks (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  code  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_bank_accounts (
  id             INTEGER PRIMARY KEY,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  account_holder TEXT NOT NULL CHECK (length(account_holder) <= 70),
  account_number TEXT NOT NULL CHECK (length(account_number) <= 25),
  bank_id        INTEGER NOT NULL REFERENCES banks(id),
  is_default     INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payroll_exports (
  id             INTEGER PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('payroll','bank_transfer')),
  file_name      TEXT NOT NULL,
  file_path      TEXT NOT NULL,
  sha256         TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (payroll_run_id, kind)
);
`;

const DEFAULT_ALLOWANCES = [
  ['RAIN_PARTIAL', 'Mưa ướt quần hoặc áo', 20000, 'RAIN', 1, 1],
  ['RAIN_FULL', 'Mưa ướt toàn thân', 50000, 'RAIN', 1, 2],
  ['CARRY', 'Bưng ghế, bàn, đá', 20000, null, null, 3],
  ['INJURY', 'Sự cố (cắt dao, bỏng nhẹ)', 20000, null, null, 4],
];

const DEFAULT_RULES = [
  ['BASE', 'Lương giờ', 'all', {}],
  ['NIGHT', 'Lương khung 22h30–24h', 'assigned', { window_start: 1350, window_end: 1440, in_from: 960, in_to: 1020, out_at: 1440, rate: 40000 }],
  ['MEAL', 'Tiền ăn', 'all', { in_from: 960, in_to: 1020, out_at: 1440, long_amount: 30000, short_amount: 10000 }],
  ['FUEL', 'Tiền xăng', 'all', { amount: 10000 }],
  ['FIXED_DAILY', 'Cộng cố định mỗi ngày đi làm', 'assigned', { amount: 80000 }],
  ['ATTENDANCE', 'Chuyên cần', 'assigned', { amount: 200000, cycle_weeks: 4, max_absent_days: 1 }],
];

// Không tạo sẵn nhân viên: thêm ở trang Nhân viên, hoặc bấm "Thêm các tên này" sau khi đồng bộ sheet.
const DEFAULT_EMPLOYEES = [];
const DEFAULT_ASSIGNMENTS = [];

const DEFAULT_SETTINGS = {
  sheet_link: '',
  sheet_mode: 'public',            // public | service_account
  service_account_path: '',
  export_folder: '',
  remark_format: 'Luong tuan {tu}-{den}',
  first_data_row: '3',
  tip_cells: 'K15,L15,M15',        // ô tổng tip T6, T7, CN trên sheet
  tip_unit: '1000',                // 1 trên sheet = 1.000đ
};

class Database {
  static async open(filePath, opts = {}) {
    const wasmPath = opts.wasmPath || path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
    const exists = filePath && fs.existsSync(filePath);
    const raw = exists ? new SQL.Database(fs.readFileSync(filePath)) : new SQL.Database();
    const db = new Database(raw, filePath);
    db.migrate(!exists);
    return db;
  }

  constructor(raw, filePath) {
    this.raw = raw;
    this.filePath = filePath;
    this.inTx = 0;
  }

  migrate(isNew) {
    this.raw.exec(SCHEMA);
    // Bản 1.1: mã BIN cho VietQR và đánh dấu đã chuyển tiền
    this.addColumn('banks', 'bin', 'TEXT');
    this.addColumn('payroll_items', 'paid_at', 'TEXT');
    // Bản 1.3: "Tai nạn nhỏ" đổi tên thành "Sự cố"
    this.raw.run("UPDATE allowance_types SET name='Sự cố (cắt dao, bỏng nhẹ)' WHERE code='INJURY' AND name LIKE 'Tai n%'");
    // Bản 1.2: cài đặt tip cho database cũ
    this.raw.run("INSERT OR IGNORE INTO app_settings(key,value) VALUES ('tip_cells','K15,L15,M15')");
    this.raw.run("INSERT OR IGNORE INTO app_settings(key,value) VALUES ('tip_unit','1000')");
    if (isNew || !this.get('SELECT 1 AS x FROM pay_rules LIMIT 1')) this.seed();
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.save();
  }

  seed() {
    this.tx(() => {
      for (const [code, name, amount, group, max, order] of DEFAULT_ALLOWANCES) {
        this.run('INSERT OR IGNORE INTO allowance_types(code,name,default_amount,exclusive_group,max_per_day,sort_order) VALUES (?,?,?,?,?,?)', [code, name, amount, group, max, order]);
      }
      for (const [code, name, scope, params] of DEFAULT_RULES) {
        this.run('INSERT OR IGNORE INTO pay_rules(code,name,scope,params_json) VALUES (?,?,?,?)', [code, name, scope, JSON.stringify(params)]);
      }
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) this.run('INSERT OR IGNORE INTO app_settings(key,value) VALUES (?,?)', [k, v]);
      if (!this.get('SELECT 1 AS x FROM employees LIMIT 1')) {
        for (const n of DEFAULT_EMPLOYEES) this.run('INSERT INTO employees(full_name, sheet_name) VALUES (?,?)', [n, n]);
        for (const [n, code] of DEFAULT_ASSIGNMENTS) {
          const e = this.get('SELECT id FROM employees WHERE sheet_name=?', [n]);
          if (e) this.run('INSERT OR IGNORE INTO employee_rule_assignments(employee_id, rule_code) VALUES (?,?)', [e.id, code]);
        }
      }
    });
  }

  addColumn(table, column, type) {
    const cols = this.all(`PRAGMA table_info(${table})`).map((c) => c.name);
    if (!cols.includes(column)) this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  all(sql, params = []) {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  get(sql, params = []) { return this.all(sql, params)[0] || null; }

  run(sql, params = []) {
    this.raw.run(sql, params);
    const id = this.raw.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    if (!this.inTx) this.save();
    return { lastId: id, changes: this.raw.getRowsModified() };
  }

  tx(fn) {
    if (this.inTx) { this.inTx++; try { return fn(); } finally { this.inTx--; } }
    this.raw.exec('BEGIN');
    this.inTx = 1;
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      this.inTx = 0;
      this.save();
      return r;
    } catch (e) {
      this.inTx = 0;
      try { this.raw.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  save() {
    if (!this.filePath) return;
    const data = Buffer.from(this.raw.export());
    // sql.js export() tắt foreign_keys, bật lại sau mỗi lần ghi
    this.raw.exec('PRAGMA foreign_keys = ON;');
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  getSettings() {
    const o = {};
    for (const r of this.all('SELECT key, value FROM app_settings')) o[r.key] = r.value;
    return o;
  }

  setSettings(obj) {
    this.tx(() => {
      for (const [k, v] of Object.entries(obj)) this.run('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v ?? '')]);
    });
  }
}

module.exports = { Database };
