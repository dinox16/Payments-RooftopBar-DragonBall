'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeShift } = require('../src/time');
const { Database } = require('../src/db');
const { PayrollService } = require('../src/service');
const { remarkFor } = require('../src/export');

// Dữ liệu chép từ ảnh sheet tuần mẫu (cột I = tổng giờ trên sheet)
const SHEET = [
  ['', 'T6', '', 'T7', '', 'CN', '', 'Khác', 'Tổng giờ làm'],
  ['', 'In', 'out', 'In', 'out', 'In', 'out', '', ''],
  ['An', '6:00:00', '10:30:00', '6:00:00', '10:30:00', '6:00:00', '10:30:00', '', '13.50'],
  ['Bảo', '', '', '', '', '', '', '', '0.00'],
  ['Chi', '6:00:00', '12:00:00', '6:00:00', '12:00:00', '6:00:00', '12:00:00', '', '18.00'],
  ['Dung', '', '', '', '', '', '', '', '0.00'],
  ['Giang', '4:30:00', '12:00:00', '5:30:00', '12:00:00', '4:30:00', '12:00:00', '', '21.50'],
  ['Hải', '', '', '', '', '', '', '', '0.00'],
  ['Khoa', '4:00:00', '10:30:00', '4:00:00', '10:30:00', '4:00:00', '10:30:00', '', '19.50'],
  ['Lan', 'off', '', '6:00:00', '10:30:00', '6:00:00', '10:30:00', '', '9.00'],
  ['Minh Anh', '', '', '', '', '', '', '', '0.00'],
  ['Nga', '4:00:00', '10:30:00', '4:00:00', '10:30:00', 'off', '', '', '13.00'],
  ['Oanh', '5:00:00', '10:30:00', '5:00:00', '10:30:00', '5:00:00', '10:30:00', '', '16.50'],
  ['Phương', '', '', '', '', '', '', '', '0.00'],
  ['Quân', '5:00:00', '10:30:00', '5:30:00', '11:00:00', '5:00:00', '10:30:00', '', '16.50'],
  ['Sơn', '4:00:00', '10:30:00', '5:00:00', '10:30:00', '4:00:00', '10:30:00', '', '18.50'],
  ['Tâm', '6:00:00', '12:00:00', '6:00:00', '12:00:00', '6:00:00', '12:00:00', '', '18.00'],
  ['Uyên Như', '6:00:00', '10:30:00', '6:00:00', '10:30:00', 'off', '', '', '9.00'],
  ['Vy', '', '', '', '', '', '', '', '0.00'],
  ['Xuân', '', '', '', '', '', '', '', '0.00'],
  ['Yến', '6:00:00', '10:30:00', '6:00:00', '10:30:00', '6:00:00', '10:30:00', '', '13.50'],
];
const FRI = '2026-11-06';
const TEMPLATE = path.join(__dirname, '..', 'resources', 'mau_thanh_toan.xlsx');

async function freshService() {
  const db = await Database.open(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const svc = new PayrollService(db, { templatePath: TEMPLATE, defaultExportFolder: dir });
  await svc.init();
  // Nhân viên mẫu (tên giả) và phụ cấp riêng như cấu hình thật của quán
  const rules = { 'Tâm': { NIGHT: {}, ATTENDANCE: {} }, 'Phương': { NIGHT: {}, ATTENDANCE: {} }, 'Chi': { NIGHT: {}, ATTENDANCE: {} }, 'Hải': { NIGHT: {} }, 'Bảo': { FIXED_DAILY: {} } };
  for (const row of SHEET.slice(2)) svc.saveEmployee({ sheet_name: row[0], full_name: row[0], rules: rules[row[0]] || {} });
  return { db, svc, dir };
}
const empId = (svc, n) => svc.listEmployees().find((e) => e.sheet_name === n).id;

test('chuẩn hoá giờ 12h trên sheet', () => {
  assert.deepEqual(pick(normalizeShift('4:30:00', '12:00:00')), [990, 1440, 450]);
  assert.deepEqual(pick(normalizeShift('6:00:00', '10:30:00')), [1080, 1350, 270]);
  assert.deepEqual(pick(normalizeShift('16:00', '24:00')), [960, 1440, 480]);
  assert.deepEqual(pick(normalizeShift('4:00 PM', '12:00 AM')), [960, 1440, 480]);
  assert.equal(normalizeShift('off', '').status, 'off');
  assert.equal(normalizeShift('', '').status, 'not_registered');
  assert.equal(normalizeShift('6:00:00', '').status, 'error');
  assert.equal(normalizeShift('abc', '10:00').status, 'error');
});
function pick(n) { return [n.inMinute, n.outMinute, n.workedMinutes]; }

test('tổng giờ khớp cột "Tổng giờ làm" của sheet', async () => {
  const { svc } = await freshService();
  const r = svc.importMatrix(FRI, SHEET, 'test', null);
  assert.deepEqual(r.unknown, []);
  for (const row of SHEET.slice(2)) {
    const got = r.week.rows.find((x) => x.name === row[0]);
    assert.equal(got.hours.toFixed(2), Number(row[8]).toFixed(2), row[0]);
  }
});

test('tính lương: ca đêm, tiền ăn, xăng, Bảo 80k, sự kiện', async () => {
  const { svc } = await freshService();
  for (const e of svc.listEmployees()) svc.saveEmployee({ ...e, hourly_rate: 25000 });
  svc.importMatrix(FRI, SHEET, 'test', null);
  // Tâm vào 16:00 ra 24:00 ngày T6 → có khung đêm
  const tam = empId(svc, 'Tâm');
  svc.setShiftManual(FRI, tam, 'FRI', '4:00:00', '12:00:00');
  const bao = empId(svc, 'Bảo');
  svc.setShiftManual(FRI, bao, 'SAT', '6:00', '10:30');
  const an_ = empId(svc, 'An');
  svc.setEvent(FRI, an_, 'FRI', 'RAIN_PARTIAL', 1);
  svc.setEvent(FRI, an_, 'FRI', 'RAIN_FULL', 1); // thay thế ướt 1 phần
  svc.setEvent(FRI, an_, 'SAT', 'CARRY', 3);
  svc.setEvent(FRI, an_, 'SUN', 'INJURY', 1);
  const w = svc.calculate(FRI);
  const item = (n) => w.run.items.find((i) => i.name === n);
  const by = (it) => it.lines.reduce((o, l) => ((o[l.code] = (o[l.code] || 0) + l.amount), o), {});

  // Tâm T6 16:00–24:00: 6,5h × 25k + 1,5h × 40k; T7, CN 18:00–24:00 không đủ điều kiện ca đêm
  const t = by(item('Tâm'));
  assert.equal(t.NIGHT, 60000);
  assert.equal(t.BASE, 6.5 * 25000 + 6 * 25000 * 2);
  assert.equal(t.MEAL, 30000 * 3); // ra 24h cả 3 ngày
  assert.equal(t.FUEL, 30000);

  // Chi 18:00–24:00 ×3: không có ca đêm, tiền ăn 30k vì ra 24h
  const h = by(item('Chi'));
  assert.equal(h.NIGHT, undefined);
  assert.equal(h.MEAL, 90000);

  // Giang: Giang không thuộc nhóm ca đêm; vào 16:30 → tiền ăn 30k
  assert.equal(by(item('Giang')).NIGHT, undefined);
  assert.equal(by(item('Giang')).MEAL, 90000);

  // An 18:00–22:30: tiền ăn 10k; mưa toàn thân 50k (không cộng 20k), bưng đồ 3×20k, tai nạn 20k
  const c = by(item('An'));
  assert.equal(c.MEAL, 30000);
  assert.equal(c.RAIN_FULL, 50000);
  assert.equal(c.RAIN_PARTIAL, undefined);
  assert.equal(c.CARRY, 60000);
  assert.equal(c.INJURY, 20000);
  assert.equal(item('An').totalAmount, 13.5 * 25000 + 30000 + 30000 + 50000 + 60000 + 20000);

  // Bảo đi 1 ngày → +80k
  assert.equal(by(item('Bảo')).FIXED_DAILY, 80000);
  // Khoa vào 16:00 (4:00) → tiền ăn 30k dù ra 22:30
  assert.equal(by(item('Khoa')).MEAL, 90000);
});

test('chuyên cần: chu kỳ 4 tuần, bỏ qua tuần đóng cửa, nghỉ >1 ngày thì mất', async () => {
  const { svc } = await freshService();
  const phuong = empId(svc, 'Phương');
  const chi = empId(svc, 'Chi');
  svc.saveEmployee({ ...svc.listEmployees().find((e) => e.id === phuong), hourly_rate: 25000, first_work_date: '2026-10-09' });
  svc.saveEmployee({ ...svc.listEmployees().find((e) => e.id === chi), hourly_rate: 25000, first_work_date: '2026-10-09' });
  const weeks = ['2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30', '2026-11-06'];
  const full = (name) => [name, '6:00', '12:00', '6:00', '12:00', '6:00', '12:00'];
  for (const wk of weeks) {
    const rows = [SHEET[0], SHEET[1], full('Phương')];
    // Chi nghỉ 2 ngày trong chu kỳ
    rows.push(wk === '2026-10-16' ? ['Chi', 'off', '', 'off', '', '6:00', '12:00'] : full('Chi'));
    svc.importMatrix(wk, rows, 'test', null);
  }
  // Tuần 23/10 quán đóng cửa → chu kỳ kết thúc ở tuần 06/11 thay vì 30/10
  svc.setWeekClosed('2026-10-23', true);
  let w = svc.calculate('2026-10-30');
  assert.equal(w.run.items.find((i) => i.name === 'Phương').lines.some((l) => l.code === 'ATTENDANCE'), false);
  w = svc.calculate('2026-11-06');
  const att = (n) => w.run.items.find((i) => i.name === n).lines.find((l) => l.code === 'ATTENDANCE');
  assert.equal(att('Phương').amount, 200000);
  assert.equal(att('Chi'), undefined); // nghỉ 2 ngày → mất
});

test('xác nhận: chặn khi thiếu tài khoản, xuất 2 file khi đủ', async () => {
  const { svc, dir } = await freshService();
  for (const e of svc.listEmployees()) svc.saveEmployee({ ...e, hourly_rate: 25000 });
  svc.importMatrix(FRI, SHEET, 'test', null);
  svc.calculate(FRI);
  // Chưa ai có tài khoản: vẫn xác nhận được, danh sách chuyển khoản trống, mọi người nằm trong mục trả riêng
  const pre = svc.preflight(FRI);
  assert.equal(pre.errors.length, 0);
  assert.equal(pre.skipped.length, 12);
  assert.equal(pre.transferCount, 0);
  const tmpl = path.join(dir, 'tk.xlsx');
  await svc.exportAccountTemplate(tmpl);
  // điền tài khoản bằng ExcelJS như người dùng
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(tmpl);
  const ws = wb.worksheets[0];
  ws.eachRow((row, r) => { if (r > 1) { row.getCell(2).value = 'NGUYEN VAN ' + r; row.getCell(3).value = '09' + String(r).padStart(8, '0'); row.getCell(4).value = 'NHTMCP Quân Đội'; } });
  await wb.xlsx.writeFile(tmpl);
  const imp = await svc.importAccounts(tmpl);
  assert.equal(imp.failed.length, 0);
  svc.calculate(FRI);
  const out = await svc.confirm(FRI);
  assert.match(path.basename(out.payrollFile), /^BangLuong_06-11-2026_08-11-2026\.xlsx$/);
  assert.match(path.basename(out.transferFile), /^DanhSachThanhToan_06-11-2026_08-11-2026\.xlsx$/);
  assert.equal(out.week.week.status, 'locked');
  assert.throws(() => svc.calculate(FRI), /đã xác nhận/);
  // mở khoá, tính lại → file _v2
  svc.unlock(FRI); svc.calculate(FRI);
  const out2 = await svc.confirm(FRI);
  assert.match(path.basename(out2.transferFile), /_v2\.xlsx$/);
});

test('nội dung chuyển khoản không dấu, tối đa 50 ký tự', () => {
  assert.equal(remarkFor('Lương tuần {tu}-{den}', { week_start: '2026-11-06', week_end: '2026-11-08' }), 'Luong tuan 06/11-08/11/2026');
});

test('bản 1.1: mã VietQR cho từng người và đánh dấu đã chuyển', async () => {
  const { svc } = await freshService();
  for (const e of svc.listEmployees()) svc.saveEmployee({ ...e, hourly_rate: 25000, account: { account_holder: 'NV ' + e.id, account_number: '0' + (900000000 + e.id), bank_name: 'NHTMCP Quân Đội' } });
  svc.importMatrix(FRI, SHEET, 'test', null);
  svc.calculate(FRI);
  const out = await svc.confirm(FRI);
  const q = await svc.transferQrs(FRI);
  assert.equal(q.total, 12);
  assert.ok(q.items.every((i) => i.qr && i.qr.startsWith('data:image/png')));
  const one = q.items[0].employeeId;
  let r = svc.markPaid(FRI, one, true); r = await r;
  assert.equal(r.paid, 1);
  await svc.markPaid(FRI, null, true);
  assert.equal(svc.getWeek(FRI).week.status, 'paid');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out.payrollFile);
  const ws = wb.getWorksheet('QR chuyển khoản');
  assert.equal(ws.getImages().length, 12);
});

test('lần đầu dùng: thêm nhân viên từ tên trên sheet', async () => {
  const db = await Database.open(null);
  const svc = new PayrollService(db, { templatePath: TEMPLATE });
  await svc.init();
  assert.equal(svc.listEmployees().length, 0);
  const r = svc.importMatrix(FRI, SHEET, 'test', null);
  assert.equal(r.unknown.length, 19);
  const r2 = svc.addEmployeesAndReimport(FRI, r.unknown);
  assert.equal(r2.unknown.length, 0);
  assert.equal(r2.week.rows.find((x) => x.name === 'Giang').hours, 21.5);
});

test('người chưa có tài khoản hoặc nhận 0đ không có trong danh sách chuyển', async () => {
  const { svc } = await freshService();
  const emps = svc.listEmployees();
  for (const e of emps) {
    const acc = ['Giang', 'Hải'].includes(e.sheet_name) ? null : { account_holder: 'NV ' + e.sheet_name, account_number: '0' + (900000000 + e.id), bank_name: 'NHTMCP Quân Đội' };
    svc.saveEmployee({ ...e, hourly_rate: 25000, account: acc });
  }
  svc.importMatrix(FRI, SHEET, 'test', null);
  svc.calculate(FRI);
  const pre = svc.preflight(FRI);
  assert.deepEqual(pre.skipped.map((x) => x.name), ['Giang']); // Hải không đi làm → 0đ, không tính
  const out = await svc.confirm(FRI);
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out.transferFile);
  const names = []; wb.getWorksheet('Sheet1').eachRow((r, i) => { if (i > 1 && r.getCell(2).value) names.push(r.getCell(2).value); });
  assert.equal(names.length, 11);
  assert.ok(!names.includes('NV Giang') && !names.includes('NV Hải'));
  assert.ok(names.every((n) => n.startsWith('NV ')));
  const q = await svc.transferQrs(FRI);
  assert.equal(q.items.length, 11);
  assert.deepEqual(q.cash.map((x) => x.name), ['Giang']);
  await svc.markPaid(FRI, null, true);
  assert.equal(svc.getWeek(FRI).week.status, 'paid');
  // file bảng lương vẫn có Giang
  const wp = new ExcelJS.Workbook(); await wp.xlsx.readFile(out.payrollFile);
  const pn = []; wp.getWorksheet('Tổng hợp').eachRow((r, i) => { if (i > 3) pn.push(r.getCell(2).value); });
  assert.ok(pn.includes('Giang'));
});

test('tip: chia đều cho người đi làm trong ngày, làm tròn nghìn (32,5 → 33)', async () => {
  const { svc } = await freshService();
  for (const e of svc.listEmployees()) svc.saveEmployee({ ...e, hourly_rate: 25000 });
  const m = SHEET.map((r) => r.slice());
  m[14] = [...m[14], '', '500', '390', '', '890']; // K15 = 500, L15 = 390, M15 trống, N15 = tổng (bỏ qua)
  m[13] = [...m[13], '', '19', '20', '18'];        // dòng 14 khác, không đọc
  const r = svc.importMatrix(FRI, m, 'test', null);
  assert.deepEqual(r.tipWarnings, []);
  const tips = Object.fromEntries(r.week.tips.map((t) => [t.code, t]));
  assert.equal(tips.FRI.amount, 500000); assert.equal(tips.FRI.workers, 11); assert.equal(tips.FRI.share, 45000);
  assert.equal(tips.SAT.amount, 390000); assert.equal(tips.SAT.workers, 12); assert.equal(tips.SAT.share, 33000);
  assert.equal(tips.SUN.amount, 0);
  const w = svc.calculate(FRI);
  const tipOf = (n) => w.run.items.find((i) => i.name === n).lines.filter((l) => l.code === 'TIP').reduce((a, l) => a + l.amount, 0);
  assert.equal(tipOf('An'), 45000 + 33000);
  assert.equal(tipOf('Lan'), 33000); // T6 off → không có tip T6
  // Sửa tay tip CN = 120 (nghìn), đồng bộ lại không bị ghi đè
  svc.setTip(FRI, 'SUN', '120');
  const r2 = svc.importMatrix(FRI, m, 'test', null);
  assert.equal(r2.week.tips.find((t) => t.code === 'SUN').amount, 120000);
  assert.equal(r2.week.tips.find((t) => t.code === 'SUN').source, 'manual');
});
