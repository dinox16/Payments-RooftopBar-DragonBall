'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { dmy, dm } = require('./dates');
const { stripAccents } = require('./time');
const { sumByCode } = require('./engine');

const COLUMNS = [
  ['BASE', 'Lương giờ'], ['NIGHT', 'Ca 22h30–24h'], ['MEAL', 'Tiền ăn'], ['FUEL', 'Tiền xăng'],
  ['FIXED_DAILY', 'Cộng cố định'], ['RAIN_PARTIAL', 'Mưa ướt 1 phần'], ['RAIN_FULL', 'Mưa ướt toàn thân'],
  ['CARRY', 'Bưng đồ'], ['INJURY', 'Tai nạn nhỏ'], ['ATTENDANCE', 'Chuyên cần'],
];
const MONEY = '#,##0';

function weekLabel(week) { return `${dmy(week.week_start, '-')}_${dmy(week.week_end, '-')}`; }

/** Tên file không trùng: thêm _v2, _v3… nếu đã có. */
function uniquePath(folder, base) {
  let p = path.join(folder, base + '.xlsx');
  let v = 2;
  while (fs.existsSync(p)) { p = path.join(folder, `${base}_v${v}.xlsx`); v++; }
  return p;
}

function styleHeader(row, fill = 'FF1F4E79') {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });
  row.height = 32;
}

async function writePayrollFile(folder, week, result) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Tinh Luong';
  const title = `BẢNG LƯƠNG TUẦN ${dmy(week.week_start)} – ${dmy(week.week_end)}`;

  // Sheet tổng hợp
  const ws = wb.addWorksheet('Tổng hợp', { views: [{ state: 'frozen', ySplit: 3, xSplit: 2 }] });
  ws.mergeCells(1, 1, 1, 5 + COLUMNS.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  const header = ['STT', 'Tên', 'Họ tên', 'Giờ làm', ...COLUMNS.map((c) => c[1]), 'Tổng nhận'];
  const hr = ws.getRow(3); hr.values = header; styleHeader(hr);
  const paid = result.items.filter((i) => i.totalAmount > 0);
  paid.forEach((it, idx) => {
    const by = sumByCode(it);
    const r = ws.getRow(4 + idx);
    r.values = [idx + 1, it.name, it.fullName, it.workedMinutes / 60, ...COLUMNS.map((c) => by[c[0]] || 0), it.totalAmount];
  });
  const last = 3 + paid.length;
  const tr = ws.getRow(last + 1);
  tr.getCell(2).value = 'TỔNG';
  for (let c = 4; c <= header.length; c++) {
    const col = ws.getColumn(c).letter;
    tr.getCell(c).value = paid.length ? { formula: `SUM(${col}4:${col}${last})` } : 0;
  }
  tr.font = { bold: true };
  tr.eachCell((c) => { c.border = { top: { style: 'thin' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; });
  ws.getColumn(1).width = 5; ws.getColumn(2).width = 13; ws.getColumn(3).width = 24; ws.getColumn(4).width = 9;
  ws.getColumn(4).numFmt = '0.0#';
  for (let c = 5; c <= header.length; c++) { ws.getColumn(c).width = 13; ws.getColumn(c).numFmt = MONEY; }
  ws.getColumn(header.length).font = { bold: true };

  // Sheet chi tiết
  const wd = wb.addWorksheet('Chi tiết', { views: [{ state: 'frozen', ySplit: 1 }] });
  const dh = wd.getRow(1); dh.values = ['Tên', 'Ngày', 'Khoản', 'Diễn giải', 'Số lượng', 'Đơn giá', 'Thành tiền']; styleHeader(dh);
  const codeName = Object.fromEntries(COLUMNS);
  for (const it of paid) {
    for (const l of it.lines) {
      wd.addRow([it.name, l.date ? dmy(l.date) : '', codeName[l.code] || l.code, l.description, l.quantity, l.unit, l.amount]);
    }
  }
  wd.columns.forEach((c, i) => { c.width = [13, 12, 16, 46, 10, 12, 14][i]; });
  wd.getColumn(5).numFmt = '0.0#'; wd.getColumn(6).numFmt = MONEY; wd.getColumn(7).numFmt = MONEY;
  wd.autoFilter = { from: 'A1', to: 'G1' };

  // Sheet ca làm
  const wc = wb.addWorksheet('Ca làm');
  const ch = wc.getRow(1); ch.values = ['Tên', 'Ngày', 'Trạng thái', 'Vào', 'Ra', 'Giờ']; styleHeader(ch);
  for (const s of result.shiftRows || []) wc.addRow(s);
  wc.columns.forEach((c, i) => { c.width = [13, 12, 14, 8, 8, 8][i]; });

  // Sheet mã QR chuyển khoản (không đụng vào file DanhSachThanhToan để ngân hàng vẫn nhận file)
  if (result.qrs && result.qrs.length) {
    const wq = wb.addWorksheet('QR chuyển khoản');
    const qh = wq.getRow(1); qh.values = ['Tên', 'Người hưởng', 'Ngân hàng', 'Số tài khoản', 'Số tiền', 'Nội dung', 'Mã QR']; styleHeader(qh);
    wq.columns.forEach((c, i) => { c.width = [12, 26, 30, 18, 13, 28, 24][i]; });
    result.qrs.forEach((q, i) => {
      const r = wq.getRow(i + 2);
      r.values = [q.name, q.holder || '', q.bankName || '', q.accountNumber || '', q.amount, q.remark, q.error || ''];
      r.getCell(4).numFmt = '@'; r.getCell(5).numFmt = MONEY;
      r.height = 135;
      r.alignment = { vertical: 'middle', wrapText: true };
      if (q.qr) wq.addImage(wb.addImage({ buffer: q.qr, extension: 'png' }), { tl: { col: 6.1, row: i + 1.05 }, ext: { width: 170, height: 170 } });
    });
  }

  const file = uniquePath(folder, `BangLuong_${weekLabel(week)}`);
  await wb.xlsx.writeFile(file);
  return file;
}

/** ExcelJS tách validation theo từng ô rồi gộp lại sai; gom lại thành đúng các vùng gốc của mẫu. */
function fixValidations(ws) {
  const m = ws.dataValidations.model;
  const groups = {};
  for (const [addr, v] of Object.entries(m)) {
    const mm = addr.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (!mm) continue;
    const col = mm[1]; const r1 = +mm[2]; const r2 = mm[4] ? +mm[4] : r1;
    const k = col + JSON.stringify(v);
    const g = groups[k] || (groups[k] = { col, v, min: r1, max: r2 });
    g.min = Math.min(g.min, r1); g.max = Math.max(g.max, r2);
  }
  ws.dataValidations.model = {};
  for (const g of Object.values(groups)) ws.dataValidations.model[`${g.col}${g.min}:${g.col}${g.max}`] = g.v;
}

function remarkFor(format, week) {
  const text = String(format || 'Luong tuan {tu}-{den}')
    .replace(/\{tu\}/g, dm(week.week_start))
    .replace(/\{den\}/g, dmy(week.week_end))
    .replace(/\{nam\}/g, week.week_end.slice(0, 4));
  return stripAccents(text).slice(0, 50);
}

/** rows: [{holder, accountNumber, bankName, amount}] */
async function writeTransferFile(folder, week, rows, templatePath, remarkFormat) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.getWorksheet('Sheet1') || wb.worksheets[0];
  fixValidations(ws);
  const remark = remarkFor(remarkFormat, week);
  for (let r = 2; r <= Math.max(ws.rowCount, rows.length + 1); r++) {
    for (const c of ['A', 'B', 'C', 'D', 'F', 'G', 'H']) ws.getCell(c + r).value = null;
  }
  rows.forEach((x, i) => {
    const r = i + 2;
    ws.getCell('A' + r).value = i + 1;
    ws.getCell('B' + r).value = x.holder;
    const c = ws.getCell('C' + r); c.value = String(x.accountNumber); c.numFmt = '@';
    ws.getCell('D' + r).value = x.bankName;
    ws.getCell('E' + r).value = { formula: `IFERROR(VLOOKUP(D${r},'Danh sách ngân hàng'!$A:$B,2,FALSE),"")`, result: x.bankCode || '' };
    ws.getCell('F' + r).value = x.amount;
    ws.getCell('G' + r).value = 'VND';
    ws.getCell('H' + r).value = remark;
  });
  const file = uniquePath(folder, `DanhSachThanhToan_${weekLabel(week)}`);
  await wb.xlsx.writeFile(file);
  return file;
}

/** Đọc danh sách ngân hàng từ sheet "Danh sách ngân hàng" của file mẫu. */
async function readBankList(templatePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath);
  const ws = wb.getWorksheet('Danh sách ngân hàng');
  const out = new Map();
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const name = String(row.getCell(1).value ?? '').trim();
    const code = String(row.getCell(2).value ?? '').trim();
    if (name && !out.has(name)) out.set(name, code);
  });
  return [...out].map(([name, code]) => ({ name, code }));
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** File mẫu để bạn điền tài khoản nhân viên rồi nhập vào app. */
async function writeAccountImportTemplate(file, employees, banks) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Tài khoản');
  const hr = ws.getRow(1); hr.values = ['Tên trên sheet', 'Tên người hưởng', 'Số tài khoản', 'Ngân hàng']; styleHeader(hr);
  employees.forEach((e, i) => {
    const r = ws.getRow(i + 2);
    r.values = [e.sheet_name, e.holder || '', e.account_number || '', e.bank_name || ''];
    r.getCell(3).numFmt = '@';
  });
  ws.columns.forEach((c, i) => { c.width = [16, 30, 22, 44][i]; });
  ws.getColumn(3).numFmt = '@';
  const wl = wb.addWorksheet('Danh sách ngân hàng');
  wl.addRow(['TÊN NGÂN HÀNG', 'MÃ']);
  banks.forEach((b) => wl.addRow([b.name, b.code]));
  wl.getColumn(1).width = 60;
  for (let r = 2; r <= Math.max(employees.length + 40, 100); r++) {
    ws.getCell('D' + r).dataValidation = { type: 'list', allowBlank: true, formulae: [`'Danh sách ngân hàng'!$A$2:$A$${banks.length + 1}`] };
  }
  await wb.xlsx.writeFile(file);
}

async function readAccountImport(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const rows = [];
  const val = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return String(v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : ''));
    return String(v);
  };
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const x = { row: r, sheetName: val(row.getCell(1).value).trim(), holder: val(row.getCell(2).value).trim(), accountNumber: val(row.getCell(3).value).replace(/\s+/g, ''), bankName: val(row.getCell(4).value).trim() };
    if (x.sheetName || x.holder || x.accountNumber) rows.push(x);
  });
  return rows;
}

module.exports = { writePayrollFile, writeTransferFile, readBankList, sha256, remarkFor, writeAccountImportTemplate, readAccountImport, COLUMNS };
