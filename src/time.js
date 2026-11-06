'use strict';
// Chuẩn hoá giờ trên Google Sheet.
// Sheet ghi giờ kiểu 12 giờ không có AM/PM: "4:30:00" nghĩa là 16:30, "12:00:00" ở cột out là 24:00.
// Mọi giờ được quy về số phút tính từ 00:00 của ngày làm (24:00 = 1440).

const OFF_WORDS = ['off', 'nghi', 'nghỉ', 'x'];

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Đọc một giá trị ô thành {kind:'empty'|'off'|'time'|'invalid', minutes?, raw} (minutes là giờ thô, chưa cộng 12). */
function parseCell(value) {
  if (value === null || value === undefined) return { kind: 'empty', raw: '' };
  if (value instanceof Date) {
    // Excel lưu giờ dạng ngày 1899-12-30 + phân số; ExcelJS trả về Date theo UTC.
    return { kind: 'time', minutes: value.getUTCHours() * 60 + value.getUTCMinutes(), raw: fmt(value.getUTCHours() * 60 + value.getUTCMinutes()) };
  }
  if (typeof value === 'number') {
    if (value >= 0 && value < 1.0001) {
      const m = Math.round(value * 1440);
      return { kind: 'time', minutes: m, raw: fmt(m) };
    }
    if (value >= 0 && value <= 24) return { kind: 'time', minutes: Math.round(value * 60), raw: String(value) };
    return { kind: 'invalid', raw: String(value) };
  }
  const raw = String(value).trim();
  if (raw === '' || raw === '-' || raw === '—') return { kind: 'empty', raw: '' };
  const low = stripAccents(raw.toLowerCase());
  if (OFF_WORDS.includes(low)) return { kind: 'off', raw };

  // 6:00:00, 6:00, 06:00, 6:00:00 PM, 16h, 16h30, 16.30
  const m = low.replace(/\s+/g, '').match(/^(\d{1,2})(?:[:h.](\d{1,2})?)?(?::(\d{1,2}))?(am|pm|sa|ch)?$/);
  if (!m) return { kind: 'invalid', raw };
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const suffix = m[4];
  if (min > 59 || h > 24) return { kind: 'invalid', raw };
  if (suffix === 'pm' || suffix === 'ch') { if (h < 12) h += 12; }
  if (suffix === 'am' || suffix === 'sa') { if (h === 12) h = 0; }
  return { kind: 'time', minutes: h * 60 + min, raw, hasSuffix: !!suffix };
}

/** Giờ vào: quán chỉ mở buổi chiều tối, nên giờ < 12h được hiểu là buổi chiều (+12h). */
function normalizeIn(minutes) {
  if (minutes < 12 * 60) return minutes + 12 * 60;
  return minutes;
}

/** Giờ ra: 12:00 hoặc 0:00 = 24:00; giờ < 12 được +12; nếu vẫn trước giờ vào thì coi là qua nửa đêm. */
function normalizeOut(minutes, inMinutes) {
  let out = minutes;
  if (out === 12 * 60 || out === 0 || out === 24 * 60) out = 24 * 60;
  else if (out < 12 * 60) out += 12 * 60;
  if (inMinutes !== null && inMinutes !== undefined && out <= inMinutes) out += 12 * 60;
  return out;
}

/**
 * Chuẩn hoá một cặp ô In/Out của một ngày.
 * Trả về { status: 'worked'|'off'|'not_registered'|'error', inMinute, outMinute, workedMinutes, rawIn, rawOut, error? }
 */
function normalizeShift(rawIn, rawOut) {
  const a = parseCell(rawIn);
  const b = parseCell(rawOut);
  const base = { rawIn: a.raw, rawOut: b.raw, inMinute: null, outMinute: null, workedMinutes: 0 };
  if (a.kind === 'off' || b.kind === 'off') return { ...base, status: 'off' };
  if (a.kind === 'empty' && b.kind === 'empty') return { ...base, status: 'not_registered' };
  if (a.kind === 'invalid' || b.kind === 'invalid') return { ...base, status: 'error', error: `Giờ không đọc được: "${a.kind === 'invalid' ? a.raw : b.raw}"` };
  if (a.kind === 'empty') return { ...base, status: 'error', error: 'Thiếu giờ vào' };
  if (b.kind === 'empty') return { ...base, status: 'error', error: 'Thiếu giờ ra' };
  const inMinute = a.hasSuffix ? a.minutes : normalizeIn(a.minutes);
  const outMinute = normalizeOut(b.minutes, inMinute);
  const worked = outMinute - inMinute;
  if (worked <= 0 || worked > 16 * 60) return { ...base, status: 'error', error: `Giờ vào/ra không hợp lệ (${fmt(inMinute)}–${fmt(outMinute)})` };
  return { ...base, status: 'worked', inMinute, outMinute, workedMinutes: worked };
}

function fmt(minutes) {
  if (minutes === null || minutes === undefined) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

module.exports = { parseCell, normalizeShift, normalizeIn, normalizeOut, fmt, stripAccents };
