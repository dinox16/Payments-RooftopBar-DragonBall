'use strict';
const { fmt } = require('./time');
const { addDays, fridayOf, dm } = require('./dates');

const DAY_LABEL = { FRI: 'T6', SAT: 'T7', SUN: 'CN' };
const money = (n) => Math.round(n).toLocaleString('vi-VN');
const hours = (min) => (min / 60).toLocaleString('vi-VN', { maximumFractionDigits: 2 });

function overlap(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }

function rateOn(rates, date) {
  // rates: [{hourly_rate, effective_from}] tăng dần theo ngày
  let r = null;
  for (const x of rates) if (x.effective_from <= date) r = x.hourly_rate;
  return r;
}

/**
 * Xét chuyên cần cho 1 nhân viên ở tuần `friday`.
 * getWeekInfo(friday) → { exists, closed, statusByDate: { 'YYYY-MM-DD': 'worked'|'off'|... } }
 * Chu kỳ = 4 tuần quán mở cửa liên tiếp tính từ tuần có ngày đầu đi làm; tuần đóng cửa không đếm.
 */
function attendanceFor(employee, friday, params, getWeekInfo) {
  const cycleWeeks = params.cycle_weeks || 4;
  const maxAbsent = params.max_absent_days ?? 1;
  if (!employee.first_work_date) return { status: 'no_start', note: 'Chưa nhập ngày bắt đầu đi làm nên chưa xét chuyên cần' };
  const anchor = fridayOf(employee.first_work_date);
  if (friday < anchor) return { status: 'not_started' };
  const current = getWeekInfo(friday);
  if (current.closed) return { status: 'closed_week' };
  const openWeeks = [];
  for (let w = anchor; w <= friday; w = addDays(w, 7)) {
    const info = w === friday ? current : getWeekInfo(w);
    if (!info.closed) openWeeks.push(w);
  }
  const idx = openWeeks.length - 1;
  const pos = idx % cycleWeeks;
  if (pos !== cycleWeeks - 1) return { status: 'not_due', weekInCycle: pos + 1, cycleWeeks };
  const cycle = openWeeks.slice(idx - cycleWeeks + 1, idx + 1);
  let absent = 0;
  const missing = [];
  const absentDates = [];
  for (const w of cycle) {
    const info = w === friday ? current : getWeekInfo(w);
    if (!info.exists) { missing.push(w); continue; }
    for (let i = 0; i < 3; i++) {
      const d = addDays(w, i);
      if (d < employee.first_work_date) continue;
      if ((info.statusByDate[d] || 'not_registered') !== 'worked') { absent++; absentDates.push(d); }
    }
  }
  const cycleStart = cycle[0];
  const cycleEnd = addDays(cycle[cycle.length - 1], 2);
  if (missing.length) {
    return { status: 'missing', weekInCycle: cycleWeeks, cycleWeeks, cycleStart, cycleEnd, missing, note: `Thiếu dữ liệu tuần ${missing.map(dm).join(', ')} nên chưa xét được chuyên cần` };
  }
  const eligible = absent <= maxAbsent;
  return { status: eligible ? 'eligible' : 'lost', weekInCycle: cycleWeeks, cycleWeeks, cycleStart, cycleEnd, absent, absentDates, eligible, amount: eligible ? params.amount : 0 };
}

/**
 * Tính lương 1 tuần.
 * input = { employees:[{id, sheet_name, full_name, first_work_date}], shiftsByEmp: {empId:[shift]}, eventsByShift:{shiftId:[{code,quantity}]},
 *           rules:{CODE:params}, allowanceTypes:{CODE:{name,default_amount,exclusive_group,max_per_day}},
 *           assignments:{empId:{CODE:{amount_override}}}, ratesByEmp:{empId:[{hourly_rate,effective_from}]}, attendanceByEmp:{empId:result} }
 * shift = { id, work_date, day_code, status, in_minute, out_minute, worked_minutes, error }
 */
function calculateWeek(input) {
  const { employees, shiftsByEmp, eventsByShift, rules, allowanceTypes, assignments, ratesByEmp, attendanceByEmp } = input;
  const items = [];
  const issues = [];
  for (const emp of employees) {
    const shifts = (shiftsByEmp[emp.id] || []).slice().sort((a, b) => a.work_date.localeCompare(b.work_date));
    const assigned = assignments[emp.id] || {};
    const lines = [];
    let workedMinutes = 0;
    for (const s of shifts) {
      const day = `${DAY_LABEL[s.day_code]} ${dm(s.work_date)}`;
      if (s.status === 'error') { issues.push({ level: 'error', employeeId: emp.id, name: emp.sheet_name, message: `${day}: ${s.error || 'giờ không hợp lệ'}` }); continue; }
      if (s.status !== 'worked') continue;
      workedMinutes += s.worked_minutes;
      const span = `${fmt(s.in_minute)}–${fmt(s.out_minute)}`;
      const rate = rateOn(ratesByEmp[emp.id] || [], s.work_date);
      if (rate === null || rate === undefined) issues.push({ level: 'error', employeeId: emp.id, name: emp.sheet_name, message: 'Chưa có đơn giá giờ' });

      // Ca đêm 22h30–24h
      let nightMin = 0;
      const N = rules.NIGHT;
      if (N && assigned.NIGHT && s.in_minute >= N.in_from && s.in_minute <= N.in_to && s.out_minute === N.out_at) {
        nightMin = overlap(s.in_minute, s.out_minute, N.window_start, N.window_end);
      }
      const baseMin = s.worked_minutes - nightMin;
      const r = rate || 0;
      lines.push({ shiftId: s.id, date: s.work_date, code: 'BASE', description: `${day} ${span}: ${hours(baseMin)}h × ${money(r)}`, quantity: baseMin / 60, unit: r, amount: Math.round(baseMin * r / 60) });
      if (nightMin > 0) {
        const rateN = assigned.NIGHT.amount_override || N.rate;
        lines.push({ shiftId: s.id, date: s.work_date, code: 'NIGHT', description: `${day} khung ${fmt(N.window_start)}–${fmt(N.window_end)}: ${hours(nightMin)}h × ${money(rateN)}`, quantity: nightMin / 60, unit: rateN, amount: Math.round(nightMin * rateN / 60) });
      }
      // Tiền ăn
      const M = rules.MEAL;
      if (M) {
        const long = (s.in_minute >= M.in_from && s.in_minute <= M.in_to) || s.out_minute === M.out_at;
        const amt = long ? M.long_amount : M.short_amount;
        lines.push({ shiftId: s.id, date: s.work_date, code: 'MEAL', description: `${day} tiền ăn${long ? ' (vào 16h–17h hoặc ra 24h)' : ''}`, quantity: 1, unit: amt, amount: amt });
      }
      if (rules.FUEL) lines.push({ shiftId: s.id, date: s.work_date, code: 'FUEL', description: `${day} tiền xăng`, quantity: 1, unit: rules.FUEL.amount, amount: rules.FUEL.amount });
      if (rules.FIXED_DAILY && assigned.FIXED_DAILY) {
        const amt = assigned.FIXED_DAILY.amount_override || rules.FIXED_DAILY.amount;
        lines.push({ shiftId: s.id, date: s.work_date, code: 'FIXED_DAILY', description: `${day} cộng cố định`, quantity: 1, unit: amt, amount: amt });
      }
      // Sự kiện trong ca
      const evs = (eventsByShift[s.id] || []).filter((e) => e.quantity > 0 && allowanceTypes[e.code]);
      const hasFullRain = evs.some((e) => e.code === 'RAIN_FULL');
      for (const e of evs) {
        const t = allowanceTypes[e.code];
        if (e.code === 'RAIN_PARTIAL' && hasFullRain) continue;
        const qty = t.max_per_day ? Math.min(e.quantity, t.max_per_day) : e.quantity;
        lines.push({ shiftId: s.id, date: s.work_date, code: e.code, description: `${day} ${t.name.toLowerCase()}${qty > 1 ? ` × ${qty}` : ''}`, quantity: qty, unit: t.default_amount, amount: qty * t.default_amount });
      }
    }
    const att = attendanceByEmp && attendanceByEmp[emp.id];
    if (att) {
      if (att.status === 'eligible') lines.push({ shiftId: null, date: att.cycleEnd, code: 'ATTENDANCE', description: `Chuyên cần chu kỳ ${dm(att.cycleStart)}–${dm(att.cycleEnd)} (nghỉ ${att.absent} ngày)`, quantity: 1, unit: att.amount, amount: att.amount });
      else if (att.status === 'missing' || att.status === 'no_start') issues.push({ level: 'warning', employeeId: emp.id, name: emp.sheet_name, message: att.note });
    }
    const base = lines.filter((l) => l.code === 'BASE' || l.code === 'NIGHT').reduce((a, l) => a + l.amount, 0);
    const total = lines.reduce((a, l) => a + l.amount, 0);
    items.push({ employeeId: emp.id, name: emp.sheet_name, fullName: emp.full_name, workedMinutes, baseAmount: base, allowanceAmount: total - base, totalAmount: total, lines, attendance: att || null });
  }
  // gộp cảnh báo trùng
  const seen = new Set();
  const uniq = issues.filter((i) => { const k = i.employeeId + i.message; if (seen.has(k)) return false; seen.add(k); return true; });
  return { items, issues: uniq, totalAmount: items.reduce((a, i) => a + i.totalAmount, 0) };
}

/** Cộng dồn theo mã khoản cho bảng tổng hợp. */
function sumByCode(item) {
  const o = {};
  for (const l of item.lines) o[l.code] = (o[l.code] || 0) + l.amount;
  return o;
}

module.exports = { calculateWeek, attendanceFor, sumByCode, rateOn };
