'use strict';
// Ngày luôn ở dạng chuỗi 'YYYY-MM-DD', tính theo UTC để không lệch múi giờ.

function toDate(iso) { return new Date(iso + 'T00:00:00Z'); }
function toIso(d) { return d.toISOString().slice(0, 10); }
function addDays(iso, n) { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); }
function dayOfWeek(iso) { return toDate(iso).getUTCDay(); } // 0 = CN, 5 = T6

/** Thứ 6 của tuần làm chứa ngày iso (tuần làm = T6, T7, CN; các ngày T2–T5 lùi về T6 trước đó). */
function fridayOf(iso) {
  const dow = dayOfWeek(iso);
  const back = (dow - 5 + 7) % 7;
  return addDays(iso, -back);
}

function weekDays(friday) {
  return [
    { code: 'FRI', label: 'T6', date: friday },
    { code: 'SAT', label: 'T7', date: addDays(friday, 1) },
    { code: 'SUN', label: 'CN', date: addDays(friday, 2) },
  ];
}

function dmy(iso, sep = '/') { const [y, m, d] = iso.split('-'); return `${d}${sep}${m}${sep}${y}`; }
function dm(iso) { const [, m, d] = iso.split('-'); return `${d}/${m}`; }
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { addDays, dayOfWeek, fridayOf, weekDays, dmy, dm, todayIso, toIso };
