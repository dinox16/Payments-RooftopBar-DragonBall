'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeShift, fmt, stripAccents } = require('./time');
const { addDays, fridayOf, weekDays, dmy, todayIso } = require('./dates');
const { matrixToEntries, fetchPublicCsv, fetchWithServiceAccount, readLocalFile, readTips, parseNumber } = require('./sheet');
const { calculateWeek, attendanceFor } = require('./engine');
const X = require('./export');
const QRCode = require('qrcode');
const { buildPayload, binForBank } = require('./vietqr');

const STATUS_LABEL = { worked: 'Đi làm', off: 'Nghỉ (off)', not_registered: 'Không đăng ký', error: 'Lỗi giờ' };

function keyName(s) { return stripAccents(String(s).trim().toLowerCase()).replace(/\s+/g, ' '); }

class PayrollService {
  /** @param {import('./db').Database} db */
  constructor(db, opts = {}) {
    this.db = db;
    this.templatePath = opts.templatePath;
    this.defaultExportFolder = opts.defaultExportFolder || process.cwd();
    this.fetchImpl = opts.fetchImpl;
  }

  async init() {
    if (!this.db.get('SELECT 1 AS x FROM banks LIMIT 1') && this.templatePath && fs.existsSync(this.templatePath)) {
      const banks = await X.readBankList(this.templatePath);
      this.db.tx(() => { for (const b of banks) this.db.run('INSERT OR IGNORE INTO banks(name, code) VALUES (?,?)', [b.name, b.code]); });
    }
    this.db.tx(() => {
      for (const b of this.db.all('SELECT id, name FROM banks WHERE bin IS NULL')) {
        const bin = binForBank(b.name);
        if (bin) this.db.run('UPDATE banks SET bin=? WHERE id=?', [bin, b.id]);
      }
    });
  }

  // ---------- Cài đặt ----------
  getSettings() {
    const s = this.db.getSettings();
    const rules = {};
    for (const r of this.db.all('SELECT code, name, params_json FROM pay_rules')) rules[r.code] = { name: r.name, params: JSON.parse(r.params_json) };
    const allowances = this.db.all('SELECT * FROM allowance_types ORDER BY sort_order');
    return { ...s, export_folder: s.export_folder || this.defaultExportFolder, rules, allowances };
  }

  saveSettings(input) {
    const { rules, allowances, ...plain } = input;
    this.db.tx(() => {
      this.db.setSettings(plain);
      if (rules) for (const [code, params] of Object.entries(rules)) {
        const cur = this.db.get('SELECT params_json FROM pay_rules WHERE code=?', [code]);
        if (cur) this.db.run('UPDATE pay_rules SET params_json=? WHERE code=?', [JSON.stringify({ ...JSON.parse(cur.params_json), ...params }), code]);
      }
      if (allowances) for (const a of allowances) this.db.run('UPDATE allowance_types SET default_amount=? WHERE code=?', [Math.round(Number(a.default_amount) || 0), a.code]);
    });
    return this.getSettings();
  }

  // ---------- Nhân viên ----------
  listEmployees() {
    const emps = this.db.all('SELECT * FROM employees ORDER BY is_active DESC, sheet_name COLLATE NOCASE');
    const rates = this.db.all('SELECT * FROM employee_rates ORDER BY effective_from');
    const assigns = this.db.all('SELECT * FROM employee_rule_assignments');
    const accounts = this.db.all(`SELECT a.*, b.name AS bank_name, b.code AS bank_code FROM employee_bank_accounts a JOIN banks b ON b.id=a.bank_id WHERE a.is_default=1`);
    return emps.map((e) => {
      const r = rates.filter((x) => x.employee_id === e.id);
      const cur = r.filter((x) => x.effective_from <= todayIso()).pop() || r[r.length - 1] || null;
      const acc = accounts.find((a) => a.employee_id === e.id) || null;
      const rules = {};
      for (const a of assigns.filter((x) => x.employee_id === e.id)) rules[a.rule_code] = { amount_override: a.amount_override };
      return { ...e, hourly_rate: cur ? cur.hourly_rate : null, rate_from: cur ? cur.effective_from : null, rates: r, rules, account: acc };
    });
  }

  saveEmployee(e) {
    const sheetName = String(e.sheet_name || '').trim();
    if (!sheetName) throw new Error('Cần nhập tên đúng như trên sheet');
    return this.db.tx(() => {
      const dup = this.db.get('SELECT id FROM employees WHERE sheet_name=? AND id<>?', [sheetName, e.id || 0]);
      if (dup) throw new Error(`Đã có nhân viên tên "${sheetName}" trên sheet`);
      let id = e.id;
      const vals = [String(e.full_name || sheetName).trim(), sheetName, e.phone || null, e.first_work_date || null, e.is_active === false || e.is_active === 0 ? 0 : 1];
      if (id) this.db.run('UPDATE employees SET full_name=?, sheet_name=?, phone=?, first_work_date=?, is_active=? WHERE id=?', [...vals, id]);
      else id = this.db.run('INSERT INTO employees(full_name, sheet_name, phone, first_work_date, is_active) VALUES (?,?,?,?,?)', vals).lastId;

      if (e.hourly_rate !== undefined && e.hourly_rate !== null && e.hourly_rate !== '') {
        const rate = Math.round(Number(e.hourly_rate));
        if (!(rate >= 0)) throw new Error('Đơn giá giờ không hợp lệ');
        const from = e.rate_from || '2000-01-01';
        const cur = this.db.get('SELECT hourly_rate FROM employee_rates WHERE employee_id=? AND effective_from<=? ORDER BY effective_from DESC LIMIT 1', [id, from]);
        if (!cur || cur.hourly_rate !== rate) {
          this.db.run('INSERT INTO employee_rates(employee_id, hourly_rate, effective_from) VALUES (?,?,?) ON CONFLICT(employee_id, effective_from) DO UPDATE SET hourly_rate=excluded.hourly_rate', [id, rate, from]);
        }
      }
      if (e.rules) {
        this.db.run('DELETE FROM employee_rule_assignments WHERE employee_id=?', [id]);
        for (const [code, v] of Object.entries(e.rules)) {
          if (!v) continue;
          const amt = v.amount_override === '' || v.amount_override === undefined || v.amount_override === null ? null : Math.round(Number(v.amount_override));
          this.db.run('INSERT INTO employee_rule_assignments(employee_id, rule_code, amount_override) VALUES (?,?,?)', [id, code, amt]);
        }
      }
      if (e.account && (e.account.account_number || e.account.account_holder)) this.setAccount(id, e.account);
      return id;
    });
  }

  deleteEmployee(id) {
    const used = this.db.get('SELECT 1 AS x FROM payroll_items WHERE employee_id=? LIMIT 1', [id]);
    if (used) { this.db.run('UPDATE employees SET is_active=0 WHERE id=?', [id]); return { deactivated: true }; }
    this.db.run('DELETE FROM employees WHERE id=?', [id]);
    return { deleted: true };
  }

  listBanks() { return this.db.all('SELECT id, name, code FROM banks ORDER BY name'); }

  setAccount(employeeId, a) {
    const holder = String(a.account_holder || '').trim();
    const number = String(a.account_number || '').replace(/\s+/g, '');
    if (!holder) throw new Error('Thiếu tên người hưởng');
    if (holder.length > 70) throw new Error('Tên người hưởng tối đa 70 ký tự');
    if (!/^[0-9A-Za-z]{1,25}$/.test(number)) throw new Error('Số tài khoản chỉ gồm chữ số/chữ, tối đa 25 ký tự');
    const bank = a.bank_id ? this.db.get('SELECT id FROM banks WHERE id=?', [a.bank_id]) : this.db.get('SELECT id FROM banks WHERE name=?', [String(a.bank_name || '').trim()]);
    if (!bank) throw new Error(`Ngân hàng "${a.bank_name || ''}" không có trong danh sách của mẫu`);
    this.db.tx(() => {
      const cur = this.db.get('SELECT * FROM employee_bank_accounts WHERE employee_id=? AND is_default=1', [employeeId]);
      if (cur && cur.account_holder === holder && cur.account_number === number && cur.bank_id === bank.id) return;
      this.db.run('UPDATE employee_bank_accounts SET is_default=0 WHERE employee_id=?', [employeeId]);
      this.db.run('INSERT INTO employee_bank_accounts(employee_id, account_holder, account_number, bank_id, is_default, effective_from) VALUES (?,?,?,?,1,?)', [employeeId, holder, number, bank.id, todayIso()]);
    });
  }

  async exportAccountTemplate(file) {
    const emps = this.listEmployees().filter((e) => e.is_active).map((e) => ({ sheet_name: e.sheet_name, holder: e.account?.account_holder, account_number: e.account?.account_number, bank_name: e.account?.bank_name }));
    await X.writeAccountImportTemplate(file, emps, this.listBanks());
    return file;
  }

  async importAccounts(file) {
    const rows = await X.readAccountImport(file);
    const emps = this.db.all('SELECT id, sheet_name FROM employees');
    const byName = new Map(emps.map((e) => [keyName(e.sheet_name), e]));
    const ok = []; const failed = [];
    for (const r of rows) {
      const emp = byName.get(keyName(r.sheetName));
      if (!emp) { failed.push({ row: r.row, name: r.sheetName, reason: 'Không có nhân viên tên này' }); continue; }
      try { this.setAccount(emp.id, { account_holder: r.holder, account_number: r.accountNumber, bank_name: r.bankName }); ok.push(r.sheetName); } catch (e) { failed.push({ row: r.row, name: r.sheetName, reason: e.message }); }
    }
    return { ok, failed };
  }

  // ---------- Tuần ----------
  ensureWeek(anyDate) {
    const friday = fridayOf(anyDate);
    let w = this.db.get('SELECT * FROM work_weeks WHERE week_start=?', [friday]);
    if (!w) {
      this.db.run('INSERT INTO work_weeks(week_start, week_end) VALUES (?,?)', [friday, addDays(friday, 2)]);
      w = this.db.get('SELECT * FROM work_weeks WHERE week_start=?', [friday]);
    }
    return w;
  }

  assertEditable(w) {
    if (w.status === 'locked' || w.status === 'paid') throw new Error('Tuần này đã xác nhận lương. Bấm "Mở khoá" nếu cần sửa và tính lại.');
  }

  setWeekClosed(friday, closed) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    this.db.run('UPDATE work_weeks SET is_closed=? WHERE id=?', [closed ? 1 : 0, w.id]);
    this.invalidateDraft(w.id);
    return this.getWeek(friday);
  }

  invalidateDraft(weekId) {
    this.db.run("DELETE FROM payroll_runs WHERE work_week_id=? AND status='draft'", [weekId]);
    this.db.run("UPDATE work_weeks SET status=CASE WHEN EXISTS(SELECT 1 FROM shifts WHERE work_week_id=?) THEN 'synced' ELSE 'draft' END WHERE id=? AND status IN ('calculated','synced','draft')", [weekId, weekId]);
  }

  async syncFromGoogle(friday, link) {
    const s = this.db.getSettings();
    const useLink = String(link || s.sheet_link || '').trim();
    if (!useLink) throw new Error('Chưa có link Google Sheet. Dán link tab của tuần này.');
    const matrix = s.sheet_mode === 'service_account'
      ? await fetchWithServiceAccount(useLink, s.service_account_path, this.fetchImpl)
      : await fetchPublicCsv(useLink, this.fetchImpl);
    this.db.setSettings({ sheet_link: useLink });
    return this.importMatrix(friday, matrix, 'google', useLink);
  }

  async importFile(friday, file) {
    const matrix = await readLocalFile(file);
    return this.importMatrix(friday, matrix, 'file:' + path.basename(file), null);
  }

  importMatrix(friday, matrix, source, link) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    const s = this.db.getSettings();
    const entries = matrixToEntries(matrix, Number(s.first_data_row) || 3);
    if (!entries.length) throw new Error('Không tìm thấy dòng nhân viên nào trong sheet. Kiểm tra lại link đúng tab đăng ký ca.');
    const emps = this.db.all('SELECT id, sheet_name FROM employees');
    const byName = new Map(emps.map((e) => [keyName(e.sheet_name), e]));
    const days = weekDays(w.week_start);
    const unknown = [];
    const tipWarnings = [];
    let count = 0;
    const raw = JSON.stringify(matrix);
    this.db.tx(() => {
      const imp = this.db.run('INSERT INTO sheet_imports(work_week_id, source, raw_json, checksum) VALUES (?,?,?,?)', [w.id, source, raw, crypto.createHash('sha256').update(raw).digest('hex')]);
      for (const en of entries) {
        const emp = byName.get(keyName(en.name));
        if (!emp) { unknown.push(en.name); continue; }
        for (const d of days) {
          const cell = en.days[d.code];
          const n = normalizeShift(cell.in, cell.out);
          const existing = this.db.get('SELECT id, source FROM shifts WHERE employee_id=? AND work_date=?', [emp.id, d.date]);
          if (existing && existing.source === 'manual') continue;
          const vals = [w.id, d.code, n.rawIn, n.rawOut, n.status, n.inMinute, n.outMinute, n.workedMinutes, imp.lastId, n.error || null];
          if (existing) this.db.run('UPDATE shifts SET work_week_id=?, day_code=?, raw_in=?, raw_out=?, status=?, in_minute=?, out_minute=?, worked_minutes=?, source=\'sheet\', import_id=?, error=? WHERE id=?', [...vals, existing.id]);
          else this.db.run('INSERT INTO shifts(employee_id, work_date, work_week_id, day_code, raw_in, raw_out, status, in_minute, out_minute, worked_minutes, import_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [emp.id, d.date, ...vals]);
          count++;
        }
      }
      // Tip từng ngày (ô cấu hình trong Cài đặt); không ghi đè tip đã sửa tay
      const unit = Number(s.tip_unit) || 1000;
      const tips = readTips(matrix, s.tip_cells);
      for (const [code, t] of Object.entries(tips)) {
        const ex = this.db.get('SELECT source FROM week_tips WHERE work_week_id=? AND day_code=?', [w.id, code]);
        if (ex && ex.source === 'manual') continue;
        if (Number.isNaN(t.value)) { tipWarnings.push(`Ô ${t.ref} không phải số: "${t.raw}"`); continue; }
        this.db.run("INSERT INTO week_tips(work_week_id, day_code, amount, raw_value, source) VALUES (?,?,?,?,'sheet') ON CONFLICT(work_week_id, day_code) DO UPDATE SET amount=excluded.amount, raw_value=excluded.raw_value, source='sheet'", [w.id, code, Math.round(t.value * unit), t.raw]);
      }
      if (link) this.db.run('UPDATE work_weeks SET sheet_link=? WHERE id=?', [link, w.id]);
      this.invalidateDraft(w.id);
      this.db.run("UPDATE work_weeks SET status='synced' WHERE id=?", [w.id]);
    });
    return { imported: entries.length - unknown.length, unknown, tipWarnings, week: this.getWeek(friday) };
  }

  /** Sửa tip của 1 ngày (theo đơn vị trên sheet, vd. 500 = 500.000đ); để trống = lấy lại từ sheet ở lần đồng bộ sau. */
  setTip(friday, dayCode, value) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    const unit = Number(this.db.getSettings().tip_unit) || 1000;
    if (value === '' || value === null || value === undefined) {
      this.db.run("UPDATE week_tips SET source='sheet' WHERE work_week_id=? AND day_code=?", [w.id, dayCode]);
    } else {
      const n = parseNumber(value);
      if (Number.isNaN(n) || n < 0) throw new Error('Tip phải là số');
      this.db.run("INSERT INTO week_tips(work_week_id, day_code, amount, raw_value, source) VALUES (?,?,?,?,'manual') ON CONFLICT(work_week_id, day_code) DO UPDATE SET amount=excluded.amount, raw_value=excluded.raw_value, source='manual'", [w.id, dayCode, Math.round(n * unit), String(value)]);
    }
    this.invalidateDraft(w.id);
    return this.getWeek(friday);
  }

  /** Thêm nhân viên từ các tên lạ trên sheet rồi đọc lại lần đồng bộ gần nhất của tuần. */
  addEmployeesAndReimport(friday, names) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    this.db.tx(() => {
      for (const n of names) {
        const name = String(n).trim();
        if (name && !this.db.get('SELECT 1 AS x FROM employees WHERE sheet_name=?', [name])) this.db.run('INSERT INTO employees(full_name, sheet_name) VALUES (?,?)', [name, name]);
      }
    });
    const last = this.db.get('SELECT source, raw_json FROM sheet_imports WHERE work_week_id=? ORDER BY id DESC LIMIT 1', [w.id]);
    if (!last) return { imported: 0, unknown: [], week: this.getWeek(friday) };
    return this.importMatrix(friday, JSON.parse(last.raw_json), last.source, null);
  }

  // ---------- Tiền phạt ----------
  listDeductions(friday) {
    const w = this.ensureWeek(friday);
    return this.db.all('SELECT d.*, e.sheet_name FROM deductions d JOIN employees e ON e.id=d.employee_id WHERE d.work_week_id=? ORDER BY e.sheet_name COLLATE NOCASE, d.id', [w.id]);
  }

  /** d = { id?, employeeId, dayCode ('FRI'|'SAT'|'SUN'|'' = cả tuần), amount (đồng), reason } */
  saveDeduction(friday, d) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    const amount = Math.round(Number(d.amount));
    if (!(amount > 0)) throw new Error('Số tiền phạt phải lớn hơn 0');
    const reason = String(d.reason || '').trim();
    if (!reason) throw new Error('Cần ghi lý do phạt');
    if (!this.db.get('SELECT 1 AS x FROM employees WHERE id=?', [d.employeeId])) throw new Error('Chọn nhân viên');
    const day = d.dayCode ? weekDays(w.week_start).find((x) => x.code === d.dayCode) : null;
    const vals = [d.employeeId, day ? day.date : null, amount, reason];
    if (d.id) this.db.run('UPDATE deductions SET employee_id=?, work_date=?, amount=?, reason=? WHERE id=? AND work_week_id=?', [...vals, d.id, w.id]);
    else this.db.run('INSERT INTO deductions(employee_id, work_date, amount, reason, work_week_id) VALUES (?,?,?,?,?)', [...vals, w.id]);
    this.invalidateDraft(w.id);
    return this.getWeek(friday);
  }

  deleteDeduction(friday, id) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    this.db.run('DELETE FROM deductions WHERE id=? AND work_week_id=?', [id, w.id]);
    this.invalidateDraft(w.id);
    return this.getWeek(friday);
  }

  setShiftManual(friday, employeeId, dayCode, rawIn, rawOut) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    const d = weekDays(w.week_start).find((x) => x.code === dayCode);
    const n = normalizeShift(rawIn, rawOut);
    const ex = this.db.get('SELECT id FROM shifts WHERE employee_id=? AND work_date=?', [employeeId, d.date]);
    const vals = [n.rawIn, n.rawOut, n.status, n.inMinute, n.outMinute, n.workedMinutes, n.error || null];
    if (ex) this.db.run("UPDATE shifts SET raw_in=?, raw_out=?, status=?, in_minute=?, out_minute=?, worked_minutes=?, error=?, source='manual' WHERE id=?", [...vals, ex.id]);
    else this.db.run("INSERT INTO shifts(employee_id, work_date, work_week_id, day_code, raw_in, raw_out, status, in_minute, out_minute, worked_minutes, error, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,'manual')", [employeeId, d.date, w.id, dayCode, ...vals]);
    this.invalidateDraft(w.id);
    if (w.status === 'draft') this.db.run("UPDATE work_weeks SET status='synced' WHERE id=?", [w.id]);
    return this.getWeek(friday);
  }

  setEvent(friday, employeeId, dayCode, code, quantity) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    const d = weekDays(w.week_start).find((x) => x.code === dayCode);
    const shift = this.db.get('SELECT id, status FROM shifts WHERE employee_id=? AND work_date=?', [employeeId, d.date]);
    if (!shift || shift.status !== 'worked') throw new Error('Chỉ ghi phụ cấp cho ngày có đi làm');
    const q = Math.max(0, Math.round(Number(quantity) || 0));
    this.db.tx(() => {
      if (code === 'RAIN_PARTIAL' || code === 'RAIN_FULL') this.db.run("DELETE FROM shift_events WHERE shift_id=? AND code IN ('RAIN_PARTIAL','RAIN_FULL')", [shift.id]);
      else this.db.run('DELETE FROM shift_events WHERE shift_id=? AND code=?', [shift.id, code]);
      if (q > 0 && code) this.db.run('INSERT INTO shift_events(shift_id, code, quantity) VALUES (?,?,?)', [shift.id, code, q]);
      this.invalidateDraft(w.id);
    });
    return this.getWeek(friday);
  }

  weekInfo(friday) {
    const w = this.db.get('SELECT * FROM work_weeks WHERE week_start=?', [friday]);
    return w;
  }

  getWeek(friday) {
    const w = this.ensureWeek(friday);
    const days = weekDays(w.week_start);
    const emps = this.db.all('SELECT id, sheet_name, full_name, is_active FROM employees ORDER BY sheet_name COLLATE NOCASE');
    const shifts = this.db.all('SELECT * FROM shifts WHERE work_week_id=?', [w.id]);
    const events = this.db.all('SELECT e.* FROM shift_events e JOIN shifts s ON s.id=e.shift_id WHERE s.work_week_id=?', [w.id]);
    const rows = [];
    for (const e of emps) {
      const my = shifts.filter((s) => s.employee_id === e.id);
      if (!e.is_active && !my.length) continue;
      const cells = {};
      let minutes = 0;
      for (const d of days) {
        const s = my.find((x) => x.work_date === d.date);
        const evs = s ? events.filter((x) => x.shift_id === s.id) : [];
        const ev = Object.fromEntries(evs.map((x) => [x.code, x.quantity]));
        cells[d.code] = s ? { status: s.status, rawIn: s.raw_in, rawOut: s.raw_out, in: fmt(s.in_minute), out: fmt(s.out_minute), hours: s.worked_minutes / 60, source: s.source, error: s.error, events: ev } : { status: 'none', events: {} };
        if (s) minutes += s.worked_minutes;
      }
      rows.push({ employeeId: e.id, name: e.sheet_name, fullName: e.full_name, cells, hours: minutes / 60 });
    }
    const run = this.db.get("SELECT * FROM payroll_runs WHERE work_week_id=? AND status IN ('draft','final') ORDER BY id DESC LIMIT 1", [w.id]);
    const exports = run ? this.db.all('SELECT * FROM payroll_exports WHERE payroll_run_id=?', [run.id]) : [];
    const lastImport = this.db.get('SELECT source, imported_at FROM sheet_imports WHERE work_week_id=? ORDER BY id DESC LIMIT 1', [w.id]);
    const st = this.db.getSettings();
    const unit = Number(st.tip_unit) || 1000;
    const tipRows = this.db.all('SELECT day_code, amount, source FROM week_tips WHERE work_week_id=?', [w.id]);
    const tips = days.map((d) => {
      const t = tipRows.find((x) => x.day_code === d.code);
      const workers = rows.filter((r) => r.cells[d.code].status === 'worked').length;
      const amount = t ? t.amount : 0;
      return { code: d.code, label: d.label, date: d.date, amount, value: amount / unit, source: t ? t.source : null, workers, share: amount, total: amount * workers };
    });
    const deductions = this.db.all('SELECT d.*, e.sheet_name FROM deductions d JOIN employees e ON e.id=d.employee_id WHERE d.work_week_id=? ORDER BY e.sheet_name COLLATE NOCASE, d.id', [w.id])
      .map((x) => ({ ...x, day_code: (days.find((dd) => dd.date === x.work_date) || {}).code || '' }));
    return { week: w, days, rows, tips, deductions, tipUnit: unit, tipCells: st.tip_cells, run: run ? this.loadRun(run.id) : null, exports, lastImport, settings: { sheet_link: w.sheet_link || st.sheet_link } };
  }

  // ---------- Tính lương ----------
  buildInput(w) {
    const emps = this.db.all('SELECT * FROM employees');
    const shifts = this.db.all('SELECT * FROM shifts WHERE work_week_id=?', [w.id]);
    const withShifts = emps.filter((e) => shifts.some((s) => s.employee_id === e.id));
    const shiftsByEmp = {};
    for (const s of shifts) (shiftsByEmp[s.employee_id] ||= []).push(s);
    const eventsByShift = {};
    for (const e of this.db.all('SELECT e.* FROM shift_events e JOIN shifts s ON s.id=e.shift_id WHERE s.work_week_id=?', [w.id])) (eventsByShift[e.shift_id] ||= []).push(e);
    const rules = {};
    for (const r of this.db.all('SELECT code, params_json FROM pay_rules')) rules[r.code] = JSON.parse(r.params_json);
    const allowanceTypes = {};
    for (const a of this.db.all('SELECT * FROM allowance_types')) allowanceTypes[a.code] = a;
    const assignments = {};
    for (const a of this.db.all('SELECT * FROM employee_rule_assignments')) (assignments[a.employee_id] ||= {})[a.rule_code] = a;
    const ratesByEmp = {};
    for (const r of this.db.all('SELECT * FROM employee_rates ORDER BY effective_from')) (ratesByEmp[r.employee_id] ||= []).push(r);

    const attendanceByEmp = {};
    const cache = {};
    const getWeekInfo = (fri) => {
      if (cache[fri]) return cache[fri];
      const ww = this.db.get('SELECT id, is_closed FROM work_weeks WHERE week_start=?', [fri]);
      const has = ww && this.db.get('SELECT 1 AS x FROM shifts WHERE work_week_id=? LIMIT 1', [ww.id]);
      cache[fri] = { exists: !!has, closed: !!(ww && ww.is_closed), weekId: ww ? ww.id : null };
      return cache[fri];
    };
    for (const e of emps) {
      if (!assignments[e.id] || !assignments[e.id].ATTENDANCE || !e.is_active) continue;
      const params = { ...rules.ATTENDANCE, amount: assignments[e.id].ATTENDANCE.amount_override || rules.ATTENDANCE.amount };
      const statusCache = {};
      const info = (fri) => {
        const base = getWeekInfo(fri);
        if (!statusCache[fri]) {
          const map = {};
          if (base.weekId) for (const s of this.db.all('SELECT work_date, status FROM shifts WHERE work_week_id=? AND employee_id=?', [base.weekId, e.id])) map[s.work_date] = s.status;
          statusCache[fri] = { ...base, statusByDate: map };
        }
        return statusCache[fri];
      };
      const already = this.db.get("SELECT ap.* FROM attendance_periods ap JOIN payroll_runs r ON r.id=ap.paid_in_run_id WHERE ap.employee_id=? AND r.status='final' AND r.work_week_id<>?", [e.id, w.id]);
      const res = attendanceFor(e, w.week_start, params, info);
      if (res.status === 'eligible' && already && already.cycle_start === res.cycleStart) continue;
      attendanceByEmp[e.id] = res;
      if (!withShifts.includes(e) && (res.status === 'eligible' || res.status === 'lost')) withShifts.push(e);
    }
    const unit = Number(this.db.getSettings().tip_unit) || 1000;
    const tips = {};
    for (const t of this.db.all('SELECT day_code, amount FROM week_tips WHERE work_week_id=?', [w.id])) {
      const d = weekDays(w.week_start).find((x) => x.code === t.day_code);
      tips[d.date] = { amount: t.amount, unit };
    }
    const deductionsByEmp = {};
    const wd = weekDays(w.week_start);
    for (const d of this.db.all('SELECT * FROM deductions WHERE work_week_id=? ORDER BY id', [w.id])) {
      (deductionsByEmp[d.employee_id] ||= []).push({ ...d, day_code: (wd.find((x) => x.date === d.work_date) || {}).code });
      const e = emps.find((x) => x.id === d.employee_id);
      if (e && !withShifts.includes(e)) withShifts.push(e);
    }
    return { employees: withShifts.sort((a, b) => a.sheet_name.localeCompare(b.sheet_name, 'vi')), shiftsByEmp, eventsByShift, rules, allowanceTypes, assignments, ratesByEmp, attendanceByEmp, tips, deductionsByEmp };
  }

  calculate(friday) {
    const w = this.ensureWeek(friday); this.assertEditable(w);
    if (w.is_closed) throw new Error('Tuần này đánh dấu quán đóng cửa, không tính lương.');
    const input = this.buildInput(w);
    if (!Object.keys(input.shiftsByEmp).length) throw new Error('Tuần này chưa có dữ liệu ca. Hãy đồng bộ Google Sheet trước.');
    const result = calculateWeek(input);
    const runId = this.db.tx(() => {
      this.db.run("DELETE FROM payroll_runs WHERE work_week_id=? AND status='draft'", [w.id]);
      const run = this.db.run("INSERT INTO payroll_runs(work_week_id, status, rules_snapshot, total_amount) VALUES (?,?,?,?)", [w.id, 'draft', JSON.stringify({ rules: input.rules, allowances: input.allowanceTypes, issues: result.issues }), result.totalAmount]);
      for (const it of result.items) {
        const item = this.db.run('INSERT INTO payroll_items(payroll_run_id, employee_id, worked_minutes, base_amount, allowance_amount, total_amount) VALUES (?,?,?,?,?,?)', [run.lastId, it.employeeId, it.workedMinutes, it.baseAmount, it.allowanceAmount, it.totalAmount]);
        for (const l of it.lines) this.db.run('INSERT INTO payroll_item_lines(payroll_item_id, shift_id, work_date, rule_code, description, quantity, unit_amount, amount) VALUES (?,?,?,?,?,?,?,?)', [item.lastId, l.shiftId, l.date, l.code, l.description, l.quantity, l.unit, l.amount]);
        const a = it.attendance;
        if (a && (a.status === 'eligible' || a.status === 'lost')) {
          this.db.run('INSERT INTO attendance_periods(employee_id, cycle_start, cycle_end, days_absent, eligible, amount) VALUES (?,?,?,?,?,?) ON CONFLICT(employee_id, cycle_start) DO UPDATE SET cycle_end=excluded.cycle_end, days_absent=excluded.days_absent, eligible=excluded.eligible, amount=excluded.amount', [it.employeeId, a.cycleStart, a.cycleEnd, a.absent, a.eligible ? 1 : 0, a.amount || 0]);
        }
      }
      this.db.run("UPDATE work_weeks SET status='calculated' WHERE id=?", [w.id]);
      return run.lastId;
    });
    return this.getWeek(friday);
  }

  loadRun(runId) {
    const run = this.db.get('SELECT * FROM payroll_runs WHERE id=?', [runId]);
    const snap = JSON.parse(run.rules_snapshot);
    const items = this.db.all('SELECT i.*, e.sheet_name, e.full_name FROM payroll_items i JOIN employees e ON e.id=i.employee_id WHERE payroll_run_id=? ORDER BY e.sheet_name COLLATE NOCASE', [runId]);
    const lines = this.db.all('SELECT l.* FROM payroll_item_lines l JOIN payroll_items i ON i.id=l.payroll_item_id WHERE i.payroll_run_id=? ORDER BY l.work_date, l.id', [runId]);
    const accounts = this.db.all('SELECT a.employee_id, a.account_holder, a.account_number, b.name AS bank_name, b.code AS bank_code, b.bin AS bank_bin FROM employee_bank_accounts a JOIN banks b ON b.id=a.bank_id WHERE a.is_default=1');
    return {
      ...run,
      issues: snap.issues || [],
      items: items.map((i) => ({
        employeeId: i.employee_id, name: i.sheet_name, fullName: i.full_name, workedMinutes: i.worked_minutes,
        baseAmount: i.base_amount, allowanceAmount: i.allowance_amount, totalAmount: i.total_amount, paidAt: i.paid_at,
        lines: lines.filter((l) => l.payroll_item_id === i.id).map((l) => ({ shiftId: l.shift_id, date: l.work_date, code: l.rule_code, description: l.description, quantity: l.quantity, unit: l.unit_amount, amount: l.amount })),
        account: accounts.find((a) => a.employee_id === i.employee_id) || null,
      })),
    };
  }

  /**
   * Kiểm tra trước khi xác nhận. errors chặn xuất file.
   * skipped = người có lương nhưng chưa có tài khoản: vẫn có trong bảng lương, không có trong danh sách chuyển khoản.
   */
  preflight(friday) {
    const data = this.getWeek(friday);
    if (!data.run || data.run.status !== 'draft') throw new Error('Hãy bấm "Tính lương" trước khi xác nhận.');
    const errors = data.run.issues.filter((i) => i.level === 'error').map((i) => `${i.name}: ${i.message}`);
    const skipped = [];
    for (const it of data.run.items) {
      if (it.totalAmount <= 0) continue;
      if (!it.account) skipped.push({ employeeId: it.employeeId, name: it.name, amount: it.totalAmount });
      if (String(it.totalAmount).length > 12) errors.push(`${it.name}: số tiền quá 12 chữ số`);
    }
    const transferCount = data.run.items.filter((i) => i.totalAmount > 0 && i.account).length;
    return { data, errors, skipped, transferCount };
  }

  async confirm(friday) {
    const { data, errors } = this.preflight(friday);
    if (errors.length) { const e = new Error('Chưa xuất được file:\n• ' + errors.join('\n• ')); e.details = errors; throw e; }
    const w = data.week;
    const s = this.getSettings();
    const folder = path.join(s.export_folder, w.week_start.slice(0, 4));
    fs.mkdirSync(folder, { recursive: true });
    const run = data.run;
    const result = { items: run.items, shiftRows: this.shiftRowsForExport(w), qrs: await this.buildQrs(run, w, s.remark_format, 'buffer') };
    const payrollFile = await X.writePayrollFile(folder, w, result);
    // Chỉ người có tài khoản và nhận > 0 mới vào danh sách chuyển khoản
    const transferRows = run.items.filter((i) => i.totalAmount > 0 && i.account).map((i) => ({ holder: i.account.account_holder, accountNumber: i.account.account_number, bankName: i.account.bank_name, bankCode: i.account.bank_code, amount: i.totalAmount }));
    let transferFile;
    try {
      transferFile = await X.writeTransferFile(folder, w, transferRows, this.templatePath, s.remark_format);
    } catch (e) { fs.rmSync(payrollFile, { force: true }); throw e; }
    this.db.tx(() => {
      this.db.run("UPDATE payroll_runs SET status='final', locked_at=CURRENT_TIMESTAMP WHERE id=?", [run.id]);
      this.db.run('INSERT INTO payroll_exports(payroll_run_id, kind, file_name, file_path, sha256) VALUES (?,?,?,?,?)', [run.id, 'payroll', path.basename(payrollFile), payrollFile, X.sha256(payrollFile)]);
      this.db.run('INSERT INTO payroll_exports(payroll_run_id, kind, file_name, file_path, sha256) VALUES (?,?,?,?,?)', [run.id, 'bank_transfer', path.basename(transferFile), transferFile, X.sha256(transferFile)]);
      for (const it of run.items) {
        const att = it.lines.find((l) => l.code === 'ATTENDANCE');
        if (att) this.db.run('UPDATE attendance_periods SET paid_in_run_id=? WHERE employee_id=? AND cycle_end=?', [run.id, it.employeeId, att.date]);
      }
      this.db.run("UPDATE work_weeks SET status='locked' WHERE id=?", [w.id]);
    });
    return { payrollFile, transferFile, week: this.getWeek(friday) };
  }

  /** Mã VietQR cho từng người: số tiền và nội dung cố định. format = 'dataUrl' (hiện trên app) | 'buffer' (chèn vào Excel). */
  async buildQrs(run, w, remarkFormat, format = 'dataUrl') {
    const remark = X.remarkFor(remarkFormat, w);
    const out = [];
    for (const it of run.items.filter((i) => i.totalAmount > 0 && i.account)) {
      const a = it.account;
      const row = { employeeId: it.employeeId, name: it.name, amount: it.totalAmount, remark, paidAt: it.paidAt || null, holder: a?.account_holder, accountNumber: a?.account_number, bankName: a?.bank_name, qr: null, error: null };
      try {
        if (!a) throw new Error('Chưa có tài khoản');
        if (!a.bank_bin) throw new Error('Ngân hàng này chưa có mã VietQR');
        const payload = buildPayload({ bin: a.bank_bin, account: a.account_number, amount: it.totalAmount, remark });
        const opt = { errorCorrectionLevel: 'M', margin: 2, width: 320 };
        row.qr = format === 'buffer' ? await QRCode.toBuffer(payload, opt) : await QRCode.toDataURL(payload, opt);
      } catch (e) { row.error = e.message; }
      out.push(row);
    }
    return out;
  }

  async transferQrs(friday) {
    const data = this.getWeek(friday);
    if (!data.run || data.run.status !== 'final') return null;
    const items = await this.buildQrs(data.run, data.week, this.db.getSettings().remark_format, 'dataUrl');
    // Người chưa có tài khoản: trả riêng (tiền mặt…), vẫn đánh dấu đã trả được
    const cash = data.run.items.filter((i) => i.totalAmount > 0 && !i.account).map((i) => ({ employeeId: i.employeeId, name: i.name, amount: i.totalAmount, paidAt: i.paidAt || null }));
    const all = [...items, ...cash];
    return { items, cash, paid: all.filter((i) => i.paidAt).length, total: all.length };
  }

  markPaid(friday, employeeId, paid) {
    const w = this.ensureWeek(friday);
    const run = this.db.get("SELECT id FROM payroll_runs WHERE work_week_id=? AND status='final' ORDER BY id DESC LIMIT 1", [w.id]);
    if (!run) throw new Error('Tuần này chưa xác nhận lương');
    this.db.tx(() => {
      this.db.run(`UPDATE payroll_items SET paid_at=${paid ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE payroll_run_id=? AND total_amount>0${employeeId ? ' AND employee_id=?' : ''}`, employeeId ? [run.id, employeeId] : [run.id]);
      const left = this.db.get('SELECT COUNT(*) AS n FROM payroll_items WHERE payroll_run_id=? AND total_amount>0 AND paid_at IS NULL', [run.id]).n;
      this.db.run(`UPDATE payroll_runs SET paid_at=${left ? 'NULL' : 'CURRENT_TIMESTAMP'} WHERE id=?`, [run.id]);
      this.db.run('UPDATE work_weeks SET status=? WHERE id=?', [left ? 'locked' : 'paid', w.id]);
    });
    return this.transferQrs(friday);
  }

  unlock(friday) {
    const w = this.ensureWeek(friday);
    this.db.tx(() => {
      this.db.run("UPDATE payroll_runs SET status='void' WHERE work_week_id=? AND status='final'", [w.id]);
      this.db.run('UPDATE attendance_periods SET paid_in_run_id=NULL WHERE paid_in_run_id IN (SELECT id FROM payroll_runs WHERE work_week_id=?)', [w.id]);
      this.db.run("UPDATE work_weeks SET status='synced' WHERE id=?", [w.id]);
    });
    return this.getWeek(friday);
  }

  shiftRowsForExport(w) {
    return this.db.all('SELECT e.sheet_name, s.work_date, s.status, s.in_minute, s.out_minute, s.worked_minutes FROM shifts s JOIN employees e ON e.id=s.employee_id WHERE s.work_week_id=? ORDER BY e.sheet_name COLLATE NOCASE, s.work_date', [w.id])
      .map((r) => [r.sheet_name, dmy(r.work_date), STATUS_LABEL[r.status] || r.status, fmt(r.in_minute), fmt(r.out_minute), r.worked_minutes / 60]);
  }

  history() {
    const runs = this.db.all("SELECT r.*, w.week_start, w.week_end FROM payroll_runs r JOIN work_weeks w ON w.id=r.work_week_id WHERE r.status IN ('final','void') ORDER BY w.week_start DESC, r.id DESC");
    const ex = this.db.all('SELECT * FROM payroll_exports');
    return runs.map((r) => ({ ...r, exports: ex.filter((x) => x.payroll_run_id === r.id).map((x) => ({ ...x, exists: fs.existsSync(x.file_path) })), people: this.db.get('SELECT COUNT(*) AS n FROM payroll_items WHERE payroll_run_id=? AND total_amount>0', [r.id]).n }));
  }
}

module.exports = { PayrollService };
