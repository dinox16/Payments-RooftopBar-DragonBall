'use strict';
/* global api */

// ---------- tiện ích ----------
const $ = (s, el = document) => el.querySelector(s);
const main = $('#main');
const dlg = $('#dlg');
const money = (n) => (Number(n) || 0).toLocaleString('vi-VN');
const hrs = (n) => (Number(n) || 0).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const dm = (iso) => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fridayOf = (iso) => { const dow = new Date(iso + 'T00:00:00Z').getUTCDay(); return addDays(iso, -((dow - 5 + 7) % 7)); };

const CODE_NAME = { TIP: 'Tip', BASE: 'Lương giờ', NIGHT: 'Ca 22h30–24h', MEAL: 'Tiền ăn', FUEL: 'Tiền xăng', FIXED_DAILY: 'Cộng cố định', RAIN_PARTIAL: 'Mưa ướt 1 phần', RAIN_FULL: 'Mưa ướt toàn thân', CARRY: 'Bưng đồ', INJURY: 'Sự cố', PENALTY: 'Tiền phạt', ATTENDANCE: 'Chuyên cần' };
const STATUS = { draft: ['Chưa có dữ liệu', ''], synced: ['Đã đồng bộ', 'warn'], calculated: ['Đã tính, chưa xác nhận', 'warn'], locked: ['Đã xác nhận', 'lock'], paid: ['Đã trả', 'lock'] };

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 9000 : 3500);
}

async function call(method, ...args) {
  const r = await api.call(method, ...args);
  if (!r.ok) { const e = new Error(r.error); e.details = r.details; throw e; }
  return r.value;
}

async function busy(el, fn) {
  el && el.classList.add('busy');
  try { return await fn(); } catch (e) { toast(e.message, true); return undefined; } finally { el && el.classList.remove('busy'); }
}

function openDialog(html, onMount) {
  dlg.innerHTML = html;
  dlg.showModal();
  if (onMount) onMount(dlg);
  return new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue); });
}

// ---------- điều hướng ----------
const state = { view: 'week', friday: fridayOf(todayIso()), hideEmpty: false, openRows: new Set() };
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
function go(view) {
  state.view = view;
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
}
function render() {
  ({ week: renderWeek, employees: renderEmployees, history: renderHistory, settings: renderSettings })[state.view]();
}
api.appInfo().then((i) => { $('#appInfo').textContent = `Phiên bản ${i.version}`; });

// ---------- tự cập nhật ----------
function showUpdate(s) {
  const bar = $('#updateBar');
  if (s.status === 'downloaded') {
    bar.innerHTML = `<span>Đã tải xong bản <b>${esc(s.version)}</b>. Khởi động lại để cập nhật (dữ liệu giữ nguyên).</span><button class="btn primary" id="doUpdate">Khởi động lại & cập nhật</button><button class="btn ghost" id="laterUpdate">Để sau</button>`;
    bar.hidden = false;
    $('#doUpdate').onclick = () => api.installUpdate();
    $('#laterUpdate').onclick = () => { bar.hidden = true; };
  } else if (s.status === 'downloading' && s.version) {
    bar.innerHTML = `<span>Đang tải bản mới ${esc(s.version)}… ${s.percent || 0}%</span>`;
    bar.hidden = false;
  }
  const st = $('#updStatus');
  if (st) st.textContent = updateText(s);
}
function updateText(s) {
  if (s.enabled === false) return 'Tự cập nhật chỉ chạy ở bản đã cài.';
  return ({ idle: 'Chưa kiểm tra.', checking: 'Đang kiểm tra…', none: 'Đang dùng bản mới nhất.', downloading: `Đang tải bản ${s.version || ''}… ${s.percent || 0}%`, downloaded: `Bản ${s.version} đã tải xong, chờ khởi động lại.`, error: 'Không kiểm tra được: ' + (s.error || '') })[s.status] || '';
}
api.onUpdate(showUpdate);
api.updateState().then(showUpdate);

// ================= TUẦN LƯƠNG =================
let weekData = null;

async function renderWeek() {
  try {
    weekData = await call('getWeek', state.friday);
    const st = weekData.week.status;
    if (st === 'locked' || st === 'paid') weekData.qrs = await call('transferQrs', state.friday);
  } catch (e) { toast(e.message, true); return; }
  drawWeek();
}

function drawWeek() {
  const d = weekData;
  const w = d.week;
  const locked = w.status === 'locked' || w.status === 'paid';
  const [stLabel, stCls] = w.is_closed ? ['Quán đóng cửa', ''] : STATUS[w.status] || ['', ''];
  const rows = d.rows.filter((r) => !state.hideEmpty || Object.values(r.cells).some((c) => c.status === 'worked' || c.status === 'error'));
  const run = d.run;

  main.innerHTML = `
    <div class="head">
      <div class="weeknav">
        <button class="btn" id="prevW" title="Tuần trước">‹</button>
        <div class="range">T6 ${dm(w.week_start)} – CN ${dmy(w.week_end)}</div>
        <button class="btn" id="nextW" title="Tuần sau">›</button>
        <input type="date" id="pickW" value="${w.week_start}" title="Chọn ngày bất kỳ trong tuần">
      </div>
      <span class="pill ${stCls}">${stLabel}</span>
      <div class="spacer"></div>
      <label class="toggle"><input type="checkbox" id="closed" ${w.is_closed ? 'checked' : ''} ${locked ? 'disabled' : ''}> Tuần này quán đóng cửa (lễ, Tết)</label>
    </div>

    <div class="card" ${w.is_closed ? 'hidden' : ''}>
      <h2>Lấy dữ liệu ca từ Google Sheet</h2>
      <div class="row">
        <input class="grow" id="link" placeholder="Dán link tab của tuần này: https://docs.google.com/spreadsheets/d/…/edit#gid=…" value="${esc(d.settings.sheet_link || '')}" ${locked ? 'disabled' : ''}>
        <button class="btn primary" id="sync" ${locked ? 'disabled' : ''}>Đồng bộ Google Sheet</button>
        <button class="btn" id="fromFile" ${locked ? 'disabled' : ''}>Nhập từ file…</button>
      </div>
      <div class="hint" style="margin-top:6px">${d.lastImport ? `Lần lấy dữ liệu gần nhất: ${esc(d.lastImport.imported_at)} (UTC) · nguồn ${esc(d.lastImport.source)}` : 'Chưa lấy dữ liệu cho tuần này.'} Giờ trên sheet được hiểu theo buổi chiều: 4:30 → 16:30, 12:00 ở cột out → 24:00.</div>
      <div id="importMsg"></div>
    </div>

    ${w.is_closed ? '' : tipBlock(d, locked)}

    ${w.is_closed ? '' : penaltyBlock(d, locked)}

    ${locked && d.qrs ? qrBlock(d.qrs) : ''}

    ${w.is_closed ? '<div class="card empty">Tuần này được đánh dấu quán đóng cửa: không tính lương và không đếm vào chu kỳ chuyên cần.</div>' : `
    <div class="head" style="margin-bottom:8px">
      <h2 style="margin:0">Ca làm & phụ cấp trong ca</h2>
      <span class="sub">Bấm vào giờ để sửa tay. Mưa, bưng đồ, sự cố ghi theo từng ngày.</span>
      <div class="spacer"></div>
      <label class="toggle"><input type="checkbox" id="hideEmpty" ${state.hideEmpty ? 'checked' : ''}> Ẩn người không đi làm</label>
    </div>
    <div class="tablewrap" style="margin-bottom:18px">
      <table>
        <thead><tr><th style="width:150px">Nhân viên</th>${d.days.map((x) => `<th>${x.label} ${dm(x.date)}</th>`).join('')}<th class="num" style="width:70px">Giờ</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => shiftRow(r, d.days, locked)).join('') : `<tr><td colspan="5" class="empty">Chưa có dữ liệu. Dán link Google Sheet rồi bấm “Đồng bộ”.</td></tr>`}</tbody>
      </table>
    </div>
    ${run ? resultBlock(run, locked) : ''}`}
  `;
  if (!w.is_closed) main.insertAdjacentHTML('beforeend', actionBar(d, locked));
  bindWeek(locked);
}

function shiftRow(r, days, locked) {
  return `<tr data-emp="${r.employeeId}" ${r.hours ? '' : 'class="dim"'}>
    <td class="name"><b>${esc(r.name)}</b>${r.fullName !== r.name ? `<small>${esc(r.fullName)}</small>` : ''}</td>
    ${days.map((d) => shiftCell(r, d, locked)).join('')}
    <td class="num">${r.hours ? hrs(r.hours) : ''}</td></tr>`;
}

function shiftCell(r, d, locked) {
  const c = r.cells[d.code];
  let t;
  if (c.status === 'worked') t = `<span class="t" data-edit="${d.code}">${c.in}–${c.out} <span class="h">${hrs(c.hours)}h</span>${c.source === 'manual' ? '<span class="m">sửa tay</span>' : ''}</span>`;
  else if (c.status === 'off') t = `<span class="t off" data-edit="${d.code}">off${c.source === 'manual' ? ' <span class="m">sửa tay</span>' : ''}</span>`;
  else if (c.status === 'error') t = `<span class="t error" data-edit="${d.code}">⚠ ${esc(c.error)} <span class="h">(${esc(c.rawIn || '–')} / ${esc(c.rawOut || '–')})</span></span>`;
  else t = `<span class="t none" data-edit="${d.code}">—</span>`;
  let ev = '';
  if (c.status === 'worked') {
    const e = c.events || {};
    const rain = e.RAIN_FULL ? 'RAIN_FULL' : e.RAIN_PARTIAL ? 'RAIN_PARTIAL' : '';
    ev = `<div class="ev" data-day="${d.code}">
      <select data-rain class="${rain ? 'on' : ''}" ${locked ? 'disabled' : ''} title="Mưa">
        <option value="">☂ không mưa</option>
        <option value="RAIN_PARTIAL" ${rain === 'RAIN_PARTIAL' ? 'selected' : ''}>☂ ướt 1 phần</option>
        <option value="RAIN_FULL" ${rain === 'RAIN_FULL' ? 'selected' : ''}>☂ ướt hết</option>
      </select>
      ${stepper('CARRY', 'Bưng', e.CARRY || 0, locked)}
      ${stepper('INJURY', 'Sự cố', e.INJURY || 0, locked)}
    </div>`;
  }
  return `<td class="shift" data-day="${d.code}">${t}${ev}</td>`;
}

function stepper(code, label, n, locked) {
  return `<span class="step ${n ? 'on' : ''}" data-code="${code}" title="${label}: số lần"><span>${label}</span>${locked ? '' : '<button data-d="-1">−</button>'}<b>${n}</b>${locked ? '' : '<button data-d="1">+</button>'}</span>`;
}

function resultBlock(run, locked) {
  const issues = run.issues || [];
  const items = run.items.filter((i) => i.totalAmount > 0 || issues.some((x) => x.employeeId === i.employeeId));
  const by = (it) => it.lines.reduce((o, l) => ((o[l.code] = (o[l.code] || 0) + l.amount), o), {});
  const other = (b) => (b.RAIN_PARTIAL || 0) + (b.RAIN_FULL || 0) + (b.CARRY || 0) + (b.INJURY || 0);
  const tot = { BASE: 0, NIGHT: 0, MEAL: 0, FUEL: 0, FIXED_DAILY: 0, OTHER: 0, TIP: 0, ATTENDANCE: 0, PENALTY: 0, total: 0, hours: 0 };
  const body = items.map((it) => {
    const b = by(it);
    tot.BASE += b.BASE || 0; tot.NIGHT += b.NIGHT || 0; tot.MEAL += b.MEAL || 0; tot.FUEL += b.FUEL || 0; tot.FIXED_DAILY += b.FIXED_DAILY || 0; tot.OTHER += other(b); tot.TIP += b.TIP || 0; tot.PENALTY += b.PENALTY || 0; tot.ATTENDANCE += b.ATTENDANCE || 0; tot.total += it.totalAmount; tot.hours += it.workedMinutes / 60;
    const open = state.openRows.has(it.employeeId);
    const acc = it.totalAmount > 0 && !it.account ? '<div class="note-warn">Chưa có tài khoản: không có trong danh sách chuyển</div>' : '';
    return `<tr class="clickable ${it.totalAmount ? '' : 'dim'}" data-item="${it.employeeId}">
      <td class="name"><b>${open ? '▾' : '▸'} ${esc(it.name)}</b>${acc}</td>
      <td class="num">${hrs(it.workedMinutes / 60)}</td><td class="num">${money(b.BASE)}</td><td class="num">${money(b.NIGHT)}</td>
      <td class="num">${money(b.MEAL)}</td><td class="num">${money(b.FUEL)}</td><td class="num">${money(b.FIXED_DAILY)}</td>
      <td class="num">${money(other(b))}</td><td class="num">${money(b.TIP)}</td><td class="num">${money(b.ATTENDANCE)}</td><td class="num ${b.PENALTY ? 'neg' : ''}">${b.PENALTY ? '−' + money(-b.PENALTY) : '0'}</td><td class="num"><b>${money(it.totalAmount)}</b></td></tr>
      ${open ? `<tr class="detail"><td colspan="12"><table class="lines">${it.lines.map((l) => `<tr><td style="width:120px">${CODE_NAME[l.code] || l.code}</td><td>${esc(l.description)}</td><td class="num ${l.amount < 0 ? 'neg' : ''}" style="width:110px">${l.amount < 0 ? '−' + money(-l.amount) : money(l.amount)}</td></tr>`).join('')}</table></td></tr>` : ''}`;
  }).join('');
  return `
    <div class="head" style="margin-bottom:8px"><h2 style="margin:0">Bảng lương tuần</h2><span class="sub">Tính lúc ${esc(run.run_at)} (UTC). Bấm vào tên để xem từng dòng tiền.</span></div>
    ${issues.length ? `<ul class="issues">${issues.map((i) => `<li class="${i.level}">${esc(i.name)}: ${esc(i.message)}</li>`).join('')}</ul>` : ''}
    <div class="tablewrap">
      <table>
        <thead><tr><th>Nhân viên</th><th class="num">Giờ</th><th class="num">Lương giờ</th><th class="num">Ca 22h30–24h</th><th class="num">Tiền ăn</th><th class="num">Xăng</th><th class="num">Cộng cố định</th><th class="num">Mưa / bưng / sự cố</th><th class="num">Tip</th><th class="num">Chuyên cần</th><th class="num">Phạt</th><th class="num">Tổng nhận</th></tr></thead>
        <tbody>${body}
          <tr class="total"><td>Tổng (${items.filter((i) => i.totalAmount > 0).length} người)</td><td class="num">${hrs(tot.hours)}</td><td class="num">${money(tot.BASE)}</td><td class="num">${money(tot.NIGHT)}</td><td class="num">${money(tot.MEAL)}</td><td class="num">${money(tot.FUEL)}</td><td class="num">${money(tot.FIXED_DAILY)}</td><td class="num">${money(tot.OTHER)}</td><td class="num">${money(tot.TIP)}</td><td class="num">${money(tot.ATTENDANCE)}</td><td class="num ${tot.PENALTY ? 'neg' : ''}">${tot.PENALTY ? '−' + money(-tot.PENALTY) : '0'}</td><td class="num">${money(tot.total)}</td></tr>
        </tbody>
      </table>
    </div>`;
}

function tipBlock(d, locked) {
  const unitLabel = d.tipUnit === 1000 ? 'nghìn đồng' : d.tipUnit === 1 ? 'đồng' : `× ${money(d.tipUnit)}đ`;
  return `<div class="card"><div class="head" style="margin-bottom:8px"><h2 style="margin:0">Tiền tip</h2>
    <span class="sub">Đọc từ ô ${esc(d.tipCells)} trên sheet (đơn vị ${unitLabel}), chia đều cho người đi làm trong ngày, làm tròn: 38,5 → 39.</span></div>
    <div class="tips">${d.tips.map((t) => `<div class="tip">
      <label class="f"><span>${t.label} ${dm(t.date)}${t.source === 'manual' ? ' <span class="m">sửa tay</span>' : ''}</span>
        <input type="number" step="0.5" min="0" data-tip="${t.code}" value="${t.amount ? t.value : ''}" placeholder="0" ${locked ? 'disabled' : ''}></label>
      <div class="hint">${t.amount ? `${money(t.amount)} ₫ ÷ ${t.workers} người = <b>${money(t.share)} ₫</b>/người` : 'Không có tip'}</div></div>`).join('')}</div></div>`;
}

function penaltyBlock(d, locked) {
  const list = d.deductions || [];
  const dayLabel = (x) => (x.day_code ? `${d.days.find((dd) => dd.code === x.day_code).label} ${dm(x.work_date)}` : 'Cả tuần');
  const total = list.reduce((a, x) => a + x.amount, 0);
  return `<div class="card"><div class="head" style="margin-bottom:${list.length ? 8 : 0}px"><h2 style="margin:0">Tiền phạt</h2>
    <span class="sub">${list.length ? `${list.length} khoản · trừ ${money(total)} ₫ vào tổng nhận` : 'Chưa có khoản phạt nào trong tuần này.'}</span>
    <div class="spacer"></div>${locked ? '' : '<button class="btn" id="addPenalty">+ Thêm tiền phạt</button>'}</div>
    ${list.length ? `<table><thead><tr><th>Nhân viên</th><th>Ngày</th><th>Lý do</th><th class="num">Số tiền</th><th style="width:130px"></th></tr></thead><tbody>
      ${list.map((x) => `<tr><td><b>${esc(x.sheet_name)}</b></td><td>${dayLabel(x)}</td><td>${esc(x.reason)}</td><td class="num neg">−${money(x.amount)}</td>
        <td>${locked ? '' : `<button class="btn ghost" data-pen-edit="${x.id}">Sửa</button><button class="btn ghost danger" data-pen-del="${x.id}">Xoá</button>`}</td></tr>`).join('')}
    </tbody></table>` : ''}</div>`;
}

async function editPenalty(x) {
  const d = weekData;
  x = x || { employee_id: '', day_code: '', amount: '', reason: '' };
  const emps = d.rows.slice().sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  const res = await openDialog(`<form method="dialog">
    <div class="dlg-head"><h2>${x.id ? 'Sửa tiền phạt' : 'Thêm tiền phạt'}</h2><div class="sub">Số tiền được trừ vào tổng nhận của tuần này.</div></div>
    <div class="dlg-body">
      <label class="f"><span>Nhân viên</span><select name="emp" required><option value="">— chọn —</option>
        ${emps.map((r) => `<option value="${r.employeeId}" ${r.employeeId === x.employee_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <label class="f"><span>Ngày</span><select name="day"><option value="">Cả tuần</option>
        ${d.days.map((dd) => `<option value="${dd.code}" ${dd.code === x.day_code ? 'selected' : ''}>${dd.label} ${dm(dd.date)}</option>`).join('')}</select></label>
      <label class="f"><span>Số tiền (₫)</span><input name="amount" type="number" min="1000" step="1000" value="${x.amount || ''}" placeholder="vd. 50000"></label>
      <label class="f"><span>Lý do</span><input name="reason" maxlength="120" value="${esc(x.reason || '')}" placeholder="vd. đi trễ 30 phút"></label>
      <div class="full err-text" id="penErr"></div>
    </div>
    <div class="dlg-foot"><button class="btn" value="cancel" formnovalidate>Huỷ</button><button class="btn primary" id="savePen">Lưu</button></div></form>`, (dl) => {
    dl.querySelector('#savePen').onclick = async (ev) => {
      ev.preventDefault();
      const f = dl.querySelector('form');
      try {
        weekData = await call('saveDeduction', state.friday, { id: x.id, employeeId: Number(f.emp.value), dayCode: f.day.value, amount: Number(f.amount.value), reason: f.reason.value });
        dl.close('saved');
      } catch (err) { dl.querySelector('#penErr').textContent = err.message; }
    };
  });
  if (res === 'saved') { drawWeek(); toast('Đã lưu tiền phạt. Bấm Tính lại để cập nhật bảng lương.'); }
}

function qrBlock(q) {
  return `<div class="head" style="margin-bottom:8px"><h2 style="margin:0">Chuyển khoản bằng mã QR</h2>
      <span class="pill ${q.paid === q.total ? 'ok' : 'warn'}">Đã chuyển ${q.paid}/${q.total}</span>
      <span class="sub">Mở app ngân hàng, quét mã: số tiền và nội dung đã điền sẵn. Kiểm tra tên người nhận trước khi xác nhận.</span>
      <div class="spacer"></div>${q.paid < q.total ? '<button class="btn" id="paidAll">Đánh dấu tất cả đã chuyển</button>' : ''}</div>
    <div class="qrgrid">${q.items.map((x) => `<div class="qrcard ${x.paidAt ? 'paid' : ''}">
      ${x.qr ? `<img src="${x.qr}" alt="QR ${esc(x.name)}" data-zoom="${x.employeeId}">` : `<div class="qrerr">${esc(x.error)}</div>`}
      <div class="qrinfo"><b>${esc(x.name)}</b><span class="amt">${money(x.amount)} ₫</span>
        <small>${esc(x.holder || '')}</small><small class="mono">${esc(x.accountNumber || '')}</small><small>${esc(x.bankName || '')}</small>
        <button class="btn ${x.paidAt ? '' : 'primary'}" data-paid="${x.employeeId}" data-v="${x.paidAt ? 0 : 1}">${x.paidAt ? '✓ Đã chuyển' : 'Đánh dấu đã chuyển'}</button></div></div>`).join('')}</div>
    ${q.cash && q.cash.length ? `<div class="card"><h2>Trả riêng (chưa có tài khoản ngân hàng)</h2><table><tbody>${q.cash.map((x) => `<tr class="${x.paidAt ? 'dim' : ''}"><td><b>${esc(x.name)}</b></td><td class="num">${money(x.amount)} ₫</td><td style="width:170px"><button class="btn ${x.paidAt ? '' : 'primary'}" data-paid="${x.employeeId}" data-v="${x.paidAt ? 0 : 1}">${x.paidAt ? '✓ Đã trả' : 'Đánh dấu đã trả'}</button></td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function actionBar(d, locked) {
  const run = d.run;
  if (locked) {
    return `<div class="actionbar">
      <span class="pill ${d.week.status === 'paid' ? 'ok' : 'lock'}">${d.week.status === 'paid' ? '✓ Đã trả đủ' : '✓ Đã xác nhận'}</span>
      <div class="files">${d.exports.map((x) => `<span class="file" data-open="${esc(x.file_path)}"><span class="x">X</span>${esc(x.file_name)}</span>`).join('')}</div>
      ${d.exports[0] ? `<button class="btn" data-folder="${esc(d.exports[0].file_path)}">Mở thư mục</button>` : ''}
      <div class="spacer"></div>
      <span class="sum">Chuyển khoản<b>${money(d.qrs ? d.qrs.items.reduce((a, x) => a + x.amount, 0) : run && run.total_amount)} ₫</b>${d.qrs && d.qrs.cash.length ? ` · trả riêng ${money(d.qrs.cash.reduce((a, x) => a + x.amount, 0))} ₫` : ''}</span>
      <button class="btn" id="unlock">Mở khoá để tính lại</button></div>`;
  }
  const hasData = d.rows.some((r) => Object.values(r.cells).some((c) => c.status !== 'none'));
  return `<div class="actionbar">
    <button class="btn big" id="calc" ${hasData ? '' : 'disabled'}>${run ? 'Tính lại' : 'Tính lương'}</button>
    ${run ? `<span class="sum">Tổng<b>${money(run.total_amount)} ₫</b></span>` : '<span class="sub">Đồng bộ dữ liệu, ghi phụ cấp trong ca, rồi bấm Tính lương.</span>'}
    <div class="spacer"></div>
    <button class="btn primary big" id="confirm" ${run ? '' : 'disabled'}>Xác nhận lương & xuất 2 file Excel</button></div>`;
}

function bindWeek(locked) {
  const move = (n) => { state.friday = addDays(weekData.week.week_start, n); state.openRows.clear(); renderWeek(); };
  $('#prevW').onclick = () => move(-7);
  $('#nextW').onclick = () => move(7);
  $('#pickW').onchange = (e) => { if (e.target.value) { state.friday = fridayOf(e.target.value); renderWeek(); } };
  $('#closed').onchange = (e) => busy(main, async () => { weekData = await call('setWeekClosed', state.friday, e.target.checked); drawWeek(); });
  const hide = $('#hideEmpty'); if (hide) hide.onchange = (e) => { state.hideEmpty = e.target.checked; drawWeek(); };

  const sync = $('#sync');
  if (sync) sync.onclick = () => busy(main, async () => {
    const r = await call('syncFromGoogle', state.friday, $('#link').value);
    weekData = r.week; drawWeek(); showImport(r);
  });
  const ff = $('#fromFile');
  if (ff) ff.onclick = async () => {
    const f = await api.pickFile({ title: 'Chọn file đăng ký ca', filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'csv'] }] });
    if (!f) return;
    busy(main, async () => { const r = await call('importFile', state.friday, f); weekData = r.week; drawWeek(); showImport(r); });
  };

  main.querySelectorAll('[data-edit]').forEach((el) => {
    if (locked) return;
    el.onclick = () => editShift(Number(el.closest('tr').dataset.emp), el.dataset.edit);
  });
  main.querySelectorAll('select[data-rain]').forEach((s) => {
    s.onchange = () => {
      const emp = Number(s.closest('tr').dataset.emp); const day = s.closest('.ev').dataset.day;
      busy(null, async () => { weekData = await call('setEvent', state.friday, emp, day, s.value || 'RAIN_FULL', s.value ? 1 : 0); drawWeek(); });
    };
  });
  main.querySelectorAll('.step button').forEach((b) => {
    b.onclick = () => {
      const st = b.closest('.step'); const emp = Number(b.closest('tr').dataset.emp); const day = b.closest('.ev').dataset.day;
      const n = Math.max(0, Number(st.querySelector('b').textContent) + Number(b.dataset.d));
      busy(null, async () => { weekData = await call('setEvent', state.friday, emp, day, st.dataset.code, n); drawWeek(); });
    };
  });
  main.querySelectorAll('tr[data-item]').forEach((tr) => {
    tr.onclick = () => { const id = Number(tr.dataset.item); state.openRows.has(id) ? state.openRows.delete(id) : state.openRows.add(id); drawWeek(); };
  });
  const calc = $('#calc');
  if (calc) calc.onclick = () => busy(main, async () => { weekData = await call('calculate', state.friday); drawWeek(); toast('Đã tính lương. Kiểm tra rồi bấm Xác nhận.'); });
  const conf = $('#confirm');
  if (conf) conf.onclick = () => confirmPayroll();
  const un = $('#unlock');
  if (un) un.onclick = async () => {
    const ok = await openDialog(`<form method="dialog"><div class="dlg-head"><h2>Mở khoá tuần này?</h2></div>
      <div class="dlg-body"><p class="full" style="margin:0">Bảng lương đã xác nhận sẽ bị huỷ để bạn sửa và tính lại. Hai file Excel cũ vẫn giữ nguyên trong thư mục; lần xác nhận sau sẽ xuất file mới có hậu tố _v2.</p></div>
      <div class="dlg-foot"><button class="btn" value="no">Thôi</button><button class="btn primary" value="yes">Mở khoá</button></div></form>`);
    if (ok === 'yes') busy(main, async () => { await call('unlock', state.friday); await renderWeek(); });
  };
  const ap = $('#addPenalty');
  if (ap) ap.onclick = () => editPenalty(null);
  main.querySelectorAll('[data-pen-edit]').forEach((b) => { b.onclick = () => editPenalty(weekData.deductions.find((x) => x.id === Number(b.dataset.penEdit))); });
  main.querySelectorAll('[data-pen-del]').forEach((b) => {
    b.onclick = async () => {
      const x = weekData.deductions.find((y) => y.id === Number(b.dataset.penDel));
      const ok = await openDialog(`<form method="dialog"><div class="dlg-head"><h2>Xoá khoản phạt?</h2></div><div class="dlg-body"><p class="full" style="margin:0">${esc(x.sheet_name)}: −${money(x.amount)} ₫ (${esc(x.reason)})</p></div><div class="dlg-foot"><button class="btn" value="no">Thôi</button><button class="btn primary" value="yes">Xoá</button></div></form>`);
      if (ok === 'yes') busy(main, async () => { weekData = await call('deleteDeduction', state.friday, x.id); drawWeek(); });
    };
  });
  main.querySelectorAll('input[data-tip]').forEach((inp) => {
    inp.onchange = () => busy(main, async () => { weekData = await call('setTip', state.friday, inp.dataset.tip, inp.value); drawWeek(); });
  });
  main.querySelectorAll('[data-paid]').forEach((b) => {
    b.onclick = () => busy(null, async () => { weekData.qrs = await call('markPaid', state.friday, Number(b.dataset.paid), b.dataset.v === '1'); await renderWeek(); });
  });
  const pa = $('#paidAll');
  if (pa) pa.onclick = () => busy(main, async () => { await call('markPaid', state.friday, null, true); await renderWeek(); });
  main.querySelectorAll('[data-zoom]').forEach((img) => {
    img.onclick = () => {
      const x = weekData.qrs.items.find((i) => i.employeeId === Number(img.dataset.zoom));
      openDialog(`<form method="dialog"><div class="dlg-head"><h2>${esc(x.name)} · ${money(x.amount)} ₫</h2><div class="sub">${esc(x.holder)} · ${esc(x.accountNumber)} · ${esc(x.bankName)} · ${esc(x.remark)}</div></div>
        <div class="dlg-body"><img class="full" style="width:100%;max-width:420px;margin:auto;image-rendering:pixelated" src="${x.qr}"></div>
        <div class="dlg-foot"><button class="btn primary" value="ok">Đóng</button></div></form>`);
    };
  });
  main.querySelectorAll('[data-open]').forEach((el) => { el.onclick = () => api.openPath(el.dataset.open); });
  main.querySelectorAll('[data-folder]').forEach((el) => { el.onclick = () => api.showInFolder(el.dataset.folder); });
}

function showImport(r) {
  const box = $('#importMsg');
  const msgs = [`<li class="info">Đã đọc ${r.imported} nhân viên từ sheet.</li>`];
  for (const t of r.tipWarnings || []) msgs.push(`<li class="warning">Tip: ${esc(t)}</li>`);
  if (r.unknown.length) msgs.push(`<li class="warning">Tên chưa có trong danh sách nhân viên, chưa được tính: <b>${r.unknown.map(esc).join(', ')}</b>.
    <button class="btn" id="addUnknown" style="margin-left:8px">Thêm các tên này</button></li>`);
  box.innerHTML = `<ul class="issues" style="margin:10px 0 0">${msgs.join('')}</ul>`;
  const add = $('#addUnknown');
  if (add) add.onclick = () => busy(main, async () => {
    const r2 = await call('addEmployeesAndReimport', state.friday, r.unknown);
    weekData = r2.week; drawWeek(); showImport(r2);
    toast(`Đã thêm ${r.unknown.length} nhân viên. Vào trang Nhân viên nhập đơn giá giờ, tài khoản và phụ cấp riêng.`);
  });
}

async function editShift(empId, dayCode) {
  const r = weekData.rows.find((x) => x.employeeId === empId);
  const c = r.cells[dayCode];
  const day = weekData.days.find((x) => x.code === dayCode);
  const res = await openDialog(`<form method="dialog">
    <div class="dlg-head"><h2>Sửa ca: ${esc(r.name)} · ${day.label} ${dmy(day.date)}</h2><div class="sub">Ghi giống trên sheet (vd. 4:30 và 12:00) hoặc kiểu 24h (16:30 và 24:00). Gõ "off" nếu nghỉ, để trống cả hai nếu không đăng ký.</div></div>
    <div class="dlg-body">
      <label class="f"><span>Giờ vào</span><input name="in" value="${esc(c.status === 'worked' ? c.in : c.rawIn || '')}" autofocus></label>
      <label class="f"><span>Giờ ra</span><input name="out" value="${esc(c.status === 'worked' ? c.out : c.rawOut || '')}"></label>
      <div class="full hint">Ca sửa tay sẽ không bị ghi đè khi đồng bộ lại Google Sheet.</div>
    </div>
    <div class="dlg-foot"><button class="btn" value="cancel">Huỷ</button><button class="btn primary" value="ok">Lưu</button></div></form>`);
  if (res !== 'ok') return;
  const f = dlg.querySelector('form');
  busy(main, async () => { weekData = await call('setShiftManual', state.friday, empId, dayCode, f.in.value, f.out.value); drawWeek(); });
}

async function confirmPayroll() {
  let pre;
  try { pre = await call('preflight', state.friday); } catch (e) { toast(e.message, true); return; }
  if (pre.errors.length) {
    await openDialog(`<form method="dialog"><div class="dlg-head"><h2>Chưa xuất được file</h2><div class="sub">Sửa các mục sau rồi bấm Tính lại:</div></div>
      <div class="dlg-body"><ul class="issues full">${pre.errors.map((e) => `<li class="error">${esc(e)}</li>`).join('')}</ul></div>
      <div class="dlg-foot"><button class="btn" value="emp" id="toEmp">Mở trang Nhân viên</button><button class="btn primary" value="ok">Đóng</button></div></form>`);
    if (dlg.returnValue === 'emp') go('employees');
    return;
  }
  const run = pre.data.run;
  const n = pre.transferCount;
  const skipTotal = pre.skipped.reduce((a, x) => a + x.amount, 0);
  const ok = await openDialog(`<form method="dialog"><div class="dlg-head"><h2>Xác nhận lương tuần ${dm(pre.data.week.week_start)} – ${dmy(pre.data.week.week_end)}</h2></div>
    <div class="dlg-body"><div class="full">
      <p style="margin-top:0">Chuyển khoản cho <b>${n} người</b> · <b>${money(run.total_amount - skipTotal)} ₫</b>. App sẽ khoá tuần này và xuất 2 file:</p>
      <ul><li>BangLuong_${pre.data.week.week_start.split('-').reverse().join('-')}_${pre.data.week.week_end.split('-').reverse().join('-')}.xlsx</li>
      <li>DanhSachThanhToan_${pre.data.week.week_start.split('-').reverse().join('-')}_${pre.data.week.week_end.split('-').reverse().join('-')}.xlsx</li></ul>
      ${pre.skipped.length ? `<ul class="issues"><li class="warning">Không có trong danh sách chuyển vì chưa có tài khoản ngân hàng, cần trả riêng: ${pre.skipped.map((x) => `<b>${esc(x.name)}</b> ${money(x.amount)} ₫`).join(', ')}.</li></ul>` : ''}
    </div></div>
    <div class="dlg-foot"><button class="btn" value="no">Huỷ</button><button class="btn primary" value="yes">Xác nhận & xuất</button></div></form>`);
  if (ok !== 'yes') return;
  busy(main, async () => {
    const r = await call('confirm', state.friday);
    await renderWeek();
    toast('Đã xuất 2 file Excel. Mã QR chuyển khoản hiện ngay trên trang này.');
    api.showInFolder(r.transferFile);
  });
}

// ================= NHÂN VIÊN =================
let banks = [];
async function renderEmployees() {
  let emps;
  try { [emps, banks] = await Promise.all([call('listEmployees'), call('listBanks')]); } catch (e) { toast(e.message, true); return; }
  const active = emps.filter((e) => e.is_active);
  const missingRate = active.filter((e) => e.hourly_rate === null).length;
  const missingAcc = active.filter((e) => !e.account).length;
  main.innerHTML = `
    <div class="head"><h1>Nhân viên</h1><span class="sub">${active.length} đang làm${missingRate ? ` · <span class="missing">${missingRate} chưa có đơn giá</span>` : ''}${missingAcc ? ` · <span class="missing">${missingAcc} chưa có tài khoản</span>` : ''}</span>
      <div class="spacer"></div>
      <button class="btn" id="tplAcc">Xuất file mẫu tài khoản</button>
      <button class="btn" id="impAcc">Nhập tài khoản từ Excel…</button>
      <button class="btn primary" id="addEmp">+ Thêm nhân viên</button></div>
    <div id="accMsg"></div>
    <div class="tablewrap"><table>
      <thead><tr><th>Tên trên sheet</th><th>Họ tên</th><th class="num">Đơn giá/giờ</th><th>Bắt đầu làm</th><th>Phụ cấp riêng</th><th>Tài khoản nhận lương</th><th></th></tr></thead>
      <tbody>${emps.map((e) => `<tr class="${e.is_active ? '' : 'dim'}">
        <td><b>${esc(e.sheet_name)}</b>${e.is_active ? '' : ' <span class="tag">đã nghỉ</span>'}</td>
        <td>${esc(e.full_name)}</td>
        <td class="num">${e.hourly_rate === null ? '<span class="missing">chưa nhập</span>' : money(e.hourly_rate)}</td>
        <td>${e.first_work_date ? dmy(e.first_work_date) : (e.rules.ATTENDANCE ? '<span class="missing">cần cho chuyên cần</span>' : '')}</td>
        <td>${e.rules.NIGHT ? '<span class="tag">22h30–24h</span>' : ''}${e.rules.ATTENDANCE ? '<span class="tag">Chuyên cần</span>' : ''}${e.rules.FIXED_DAILY ? `<span class="tag">+${money(e.rules.FIXED_DAILY.amount_override || 80000)}/ngày</span>` : ''}</td>
        <td>${e.account ? `${esc(e.account.account_holder)}<br><span class="mono">${esc(e.account.account_number)}</span> · <span class="sub">${esc(e.account.bank_name)}</span>` : '<span class="missing">chưa có</span>'}</td>
        <td><button class="btn ghost" data-edit="${e.id}">Sửa</button></td></tr>`).join('')}</tbody></table></div>`;
  $('#addEmp').onclick = () => editEmployee(null);
  main.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editEmployee(emps.find((x) => x.id === Number(b.dataset.edit))); });
  $('#tplAcc').onclick = async () => {
    const f = await api.saveFile({ defaultPath: 'TaiKhoanNhanVien.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (f) busy(main, async () => { await call('exportAccountTemplate', f); toast('Đã tạo file mẫu. Điền tài khoản rồi bấm "Nhập tài khoản từ Excel".'); api.showInFolder(f); });
  };
  $('#impAcc').onclick = async () => {
    const f = await api.pickFile({ title: 'Chọn file tài khoản', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
    if (!f) return;
    busy(main, async () => {
      const r = await call('importAccounts', f);
      await renderEmployees();
      $('#accMsg').innerHTML = `<ul class="issues"><li class="info">Đã cập nhật ${r.ok.length} tài khoản.</li>${r.failed.map((x) => `<li class="error">Dòng ${x.row} (${esc(x.name)}): ${esc(x.reason)}</li>`).join('')}</ul>`;
    });
  };
}

async function editEmployee(e) {
  const isNew = !e;
  e = e || { sheet_name: '', full_name: '', rules: {}, is_active: 1, hourly_rate: null, account: null };
  const acc = e.account || {};
  const res = await openDialog(`<form method="dialog" id="empForm">
    <div class="dlg-head"><h2>${isNew ? 'Thêm nhân viên' : 'Sửa: ' + esc(e.sheet_name)}</h2></div>
    <div class="dlg-body">
      <label class="f"><span>Tên trên sheet *</span><input name="sheet_name" value="${esc(e.sheet_name)}" required><small>Phải giống hệt cột A của Google Sheet</small></label>
      <label class="f"><span>Họ tên đầy đủ</span><input name="full_name" value="${esc(e.full_name)}"></label>
      <label class="f"><span>Đơn giá giờ (₫)</span><input name="hourly_rate" type="number" min="0" step="500" value="${e.hourly_rate ?? ''}"></label>
      <label class="f"><span>Áp dụng từ ngày</span><input name="rate_from" type="date" value="${e.hourly_rate === null ? '' : todayIso()}"><small>${e.hourly_rate === null ? 'Để trống = áp dụng cho mọi tuần' : `Đang dùng ${money(e.hourly_rate)} từ ${e.rate_from === '2000-01-01' ? 'đầu' : dmy(e.rate_from)}`}</small></label>
      <label class="f"><span>Ngày bắt đầu đi làm</span><input name="first_work_date" type="date" value="${e.first_work_date || ''}"><small>Mốc tính chu kỳ chuyên cần 4 tuần</small></label>
      <label class="f"><span>Số điện thoại</span><input name="phone" value="${esc(e.phone || '')}"></label>
      <fieldset class="full"><legend>Phụ cấp riêng</legend>
        <label class="check"><input type="checkbox" name="r_night" ${e.rules.NIGHT ? 'checked' : ''}> Ca 22h30–24h tính 40.000/giờ (khi vào 16h–17h và ra 24h)</label>
        <label class="check"><input type="checkbox" name="r_att" ${e.rules.ATTENDANCE ? 'checked' : ''}> Chuyên cần 200.000 mỗi chu kỳ 4 tuần (nghỉ tối đa 1 ngày)</label>
        <label class="check"><input type="checkbox" name="r_fixed" ${e.rules.FIXED_DAILY ? 'checked' : ''}> Cộng cố định mỗi ngày đi làm:
          <input name="fixed_amt" type="number" step="1000" style="width:110px" value="${e.rules.FIXED_DAILY ? e.rules.FIXED_DAILY.amount_override || 80000 : 80000}"> ₫</label>
      </fieldset>
      <fieldset class="full"><legend>Tài khoản nhận lương</legend>
        <div class="dlg-body" style="padding:0">
          <label class="f"><span>Tên người hưởng</span><input name="holder" maxlength="70" value="${esc(acc.account_holder || '')}" placeholder="Như trên tài khoản ngân hàng"></label>
          <label class="f"><span>Số tài khoản</span><input name="number" maxlength="25" class="mono" value="${esc(acc.account_number || '')}"></label>
          <label class="f full"><span>Ngân hàng</span><input name="bank" list="bankList" value="${esc(acc.bank_name || '')}" placeholder="Gõ để tìm, vd. Quân Đội, VCB, TCB"></label>
          <datalist id="bankList">${banks.map((b) => `<option value="${esc(b.name)}">`).join('')}</datalist>
        </div>
      </fieldset>
      <label class="check full"><input type="checkbox" name="is_active" ${e.is_active ? 'checked' : ''}> Đang làm</label>
      <div class="full err-text" id="empErr"></div>
    </div>
    <div class="dlg-foot">${isNew ? '' : '<button class="btn danger left" value="delete" formnovalidate>Xoá</button>'}<button class="btn" value="cancel" formnovalidate>Huỷ</button><button class="btn primary" value="save" id="saveEmp">Lưu</button></div></form>`, (d) => {
    d.querySelector('#saveEmp').onclick = async (ev) => {
      ev.preventDefault();
      const f = d.querySelector('form');
      if (!f.sheet_name.value.trim()) { d.querySelector('#empErr').textContent = 'Cần nhập tên trên sheet'; return; }
      const rules = {};
      if (f.r_night.checked) rules.NIGHT = {};
      if (f.r_att.checked) rules.ATTENDANCE = {};
      if (f.r_fixed.checked) rules.FIXED_DAILY = { amount_override: Number(f.fixed_amt.value) || null };
      const hasAcc = f.holder.value.trim() || f.number.value.trim() || f.bank.value.trim();
      if (hasAcc && !banks.some((b) => b.name === f.bank.value.trim())) { d.querySelector('#empErr').textContent = 'Chọn ngân hàng đúng theo danh sách gợi ý (danh sách của mẫu chuyển khoản).'; return; }
      const payload = {
        id: e.id, sheet_name: f.sheet_name.value, full_name: f.full_name.value || f.sheet_name.value, phone: f.phone.value,
        first_work_date: f.first_work_date.value || null, is_active: f.is_active.checked,
        hourly_rate: f.hourly_rate.value === '' ? null : Number(f.hourly_rate.value), rate_from: f.rate_from.value || '2000-01-01', rules,
        account: hasAcc ? { account_holder: f.holder.value, account_number: f.number.value, bank_name: f.bank.value } : null,
      };
      try { await call('saveEmployee', payload); d.close('saved'); } catch (err) { d.querySelector('#empErr').textContent = err.message; }
    };
  });
  if (res === 'delete') {
    const sure = await openDialog(`<form method="dialog"><div class="dlg-head"><h2>Xoá ${esc(e.sheet_name)}?</h2></div><div class="dlg-body"><p class="full" style="margin:0">Nếu nhân viên đã có trong bảng lương cũ, app chỉ chuyển sang "đã nghỉ" để giữ lịch sử.</p></div><div class="dlg-foot"><button class="btn" value="no">Thôi</button><button class="btn primary" value="yes">Xoá</button></div></form>`);
    if (sure !== 'yes') return;
    const r = await busy(main, () => call('deleteEmployee', e.id));
    if (r && r.deactivated) toast('Nhân viên đã có trong bảng lương cũ nên chỉ chuyển sang "đã nghỉ".');
  }
  if (res === 'saved' || res === 'delete') renderEmployees();
}

// ================= LỊCH SỬ =================
async function renderHistory() {
  let runs;
  try { runs = await call('history'); } catch (e) { toast(e.message, true); return; }
  main.innerHTML = `<div class="head"><h1>Lịch sử bảng lương</h1></div>
    ${runs.length ? `<div class="tablewrap"><table><thead><tr><th>Tuần</th><th>Trạng thái</th><th class="num">Số người</th><th class="num">Tổng tiền</th><th>Xác nhận lúc</th><th>File</th></tr></thead><tbody>
    ${runs.map((r) => `<tr class="${r.status === 'void' ? 'dim' : ''}"><td><a href="#" data-week="${r.week_start}">T6 ${dm(r.week_start)} – CN ${dmy(r.week_end)}</a></td>
      <td>${r.status === 'final' ? '<span class="pill ok">Đã xác nhận</span>' : '<span class="pill">Đã huỷ</span>'}</td>
      <td class="num">${r.people}</td><td class="num">${money(r.total_amount)}</td><td>${esc(r.locked_at || '')}</td>
      <td><div class="files">${r.exports.map((x) => `<span class="file" data-open="${esc(x.file_path)}" title="${esc(x.file_path)}"><span class="x">X</span>${esc(x.file_name)}${x.exists ? '' : ' <span class="missing">(đã bị xoá)</span>'}</span>`).join('')}</div></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="card empty">Chưa có tuần nào được xác nhận.</div>'}`;
  main.querySelectorAll('[data-open]').forEach((el) => { el.onclick = () => api.openPath(el.dataset.open); });
  main.querySelectorAll('[data-week]').forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); state.friday = a.dataset.week; go('week'); }; });
}

// ================= CÀI ĐẶT =================
async function renderSettings() {
  let s;
  try { s = await call('getSettings'); } catch (e) { toast(e.message, true); return; }
  const R = s.rules;
  const amt = (label, name, val) => `<label>${label}</label><input type="number" step="1000" name="${name}" value="${val}">`;
  main.innerHTML = `<div class="head"><h1>Cài đặt</h1><div class="spacer"></div><button class="btn primary" id="saveSet">Lưu cài đặt</button></div>
  <form id="setForm">
  <div class="grid2">
    <div class="card"><h2>Google Sheet</h2>
      <label class="f"><span>Link mặc định</span><input name="sheet_link" value="${esc(s.sheet_link)}" placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…"></label>
      <p class="hint">Mỗi tuần có thể dán link tab khác ở trang Tuần lương; app nhớ link dùng gần nhất.</p>
      <label class="check"><input type="radio" name="sheet_mode" value="public" ${s.sheet_mode !== 'service_account' ? 'checked' : ''}> Link chia sẻ "Bất kỳ ai có đường liên kết – Người xem" (đơn giản nhất)</label>
      <label class="check"><input type="radio" name="sheet_mode" value="service_account" ${s.sheet_mode === 'service_account' ? 'checked' : ''}> Service account Google (sheet để riêng tư)</label>
      <div class="row" style="margin-top:6px"><input class="grow" name="service_account_path" value="${esc(s.service_account_path)}" placeholder="File JSON của service account" readonly><button type="button" class="btn" id="pickSa">Chọn file…</button></div>
      <p class="hint">Với service account: chia sẻ sheet cho email trong file JSON (client_email) quyền Người xem.</p>
      <h2 style="margin-top:16px">Tiền tip trên sheet</h2>
      <div class="row">
        <label class="f grow"><span>Ô tổng tip T6, T7, CN</span><input name="tip_cells" value="${esc(s.tip_cells || 'K15,L15,M15')}"></label>
        <label class="f"><span>1 trên sheet bằng</span><select name="tip_unit">
          <option value="1000" ${String(s.tip_unit) !== '1' ? 'selected' : ''}>1.000đ (nghìn đồng)</option>
          <option value="1" ${String(s.tip_unit) === '1' ? 'selected' : ''}>1đ (ghi đủ số)</option></select></label>
      </div>
      <p class="hint">Vd. ô K15 ghi 500 → 500.000đ tip ngày T6, chia đều cho người đi làm T6.</p>
    </div>
    <div class="card"><h2>Xuất file</h2>
      <label class="f"><span>Thư mục lưu file Excel</span><div class="row"><input class="grow" name="export_folder" value="${esc(s.export_folder)}" readonly><button type="button" class="btn" id="pickFolder">Chọn…</button></div></label>
      <p class="hint">File được lưu trong thư mục con theo năm, vd. TinhLuong\\2026\\BangLuong_06-11-2026_08-11-2026.xlsx</p>
      <label class="f"><span>Nội dung chuyển khoản</span><input name="remark_format" value="${esc(s.remark_format)}"></label>
      <p class="hint">{tu} = ngày đầu tuần (06/11), {den} = ngày cuối tuần (08/11/2026). Tự bỏ dấu, tối đa 50 ký tự theo mẫu ngân hàng.</p>
      <h2 style="margin-top:16px">Cập nhật phần mềm</h2>
      <div class="row"><button type="button" class="btn" id="checkUpd">Kiểm tra bản mới</button><span class="hint" id="updStatus"></span></div>
      <p class="hint">App tự kiểm tra khi mở và mỗi 6 giờ; bản mới tải ngầm, tắt app hoặc bấm "Khởi động lại" là cài.</p>
      <h2 style="margin-top:16px">Dữ liệu</h2>
      <div class="row"><button type="button" class="btn" id="openData">Mở thư mục dữ liệu</button><span class="hint">payroll.db và bản sao lưu hằng ngày (giữ 30 bản).</span></div>
    </div>
  </div>
  <div class="card"><h2>Mức tiền (₫)</h2>
    <div class="grid2">
      <div class="amounts">
        ${amt('Ca 22h30–24h (mỗi giờ)', 'NIGHT.rate', R.NIGHT.params.rate)}
        ${amt('Tiền ăn khi vào 16h–17h hoặc ra 24h', 'MEAL.long_amount', R.MEAL.params.long_amount)}
        ${amt('Tiền ăn các ca khác', 'MEAL.short_amount', R.MEAL.params.short_amount)}
        ${amt('Tiền xăng mỗi ngày', 'FUEL.amount', R.FUEL.params.amount)}
        ${amt('Cộng cố định mặc định mỗi ngày', 'FIXED_DAILY.amount', R.FIXED_DAILY.params.amount)}
        ${amt('Chuyên cần mỗi chu kỳ 4 tuần', 'ATTENDANCE.amount', R.ATTENDANCE.params.amount)}
      </div>
      <div class="amounts">
        ${s.allowances.map((a) => amt(esc(a.name) + (a.max_per_day ? ' (tối đa 1 lần/ngày)' : ' (mỗi lần)'), 'AL.' + a.code, a.default_amount)).join('')}
      </div>
    </div>
  </div>
  </form>`;
  const f = $('#setForm');
  $('#pickSa').onclick = async () => { const p = await api.pickFile({ filters: [{ name: 'JSON', extensions: ['json'] }] }); if (p) f.service_account_path.value = p; };
  $('#pickFolder').onclick = async () => { const p = await api.pickFolder({ defaultPath: f.export_folder.value }); if (p) f.export_folder.value = p; };
  $('#openData').onclick = () => api.openDataFolder();
  api.updateState().then((u) => { $('#updStatus').textContent = updateText(u); });
  $('#checkUpd').onclick = async () => { $('#updStatus').textContent = 'Đang kiểm tra…'; const u = await api.checkUpdate(); $('#updStatus').textContent = updateText(u); };
  $('#saveSet').onclick = () => busy(main, async () => {
    const rules = {}; const allowances = [];
    f.querySelectorAll('input[type=number]').forEach((i) => {
      const [k, p] = i.name.split('.');
      if (k === 'AL') allowances.push({ code: p, default_amount: Number(i.value) });
      else (rules[k] ||= {})[p] = Number(i.value);
    });
    await call('saveSettings', { sheet_link: f.sheet_link.value, sheet_mode: f.sheet_mode.value, service_account_path: f.service_account_path.value, tip_cells: f.tip_cells.value, tip_unit: f.tip_unit.value, export_folder: f.export_folder.value, remark_format: f.remark_format.value, rules, allowances });
    toast('Đã lưu cài đặt. Các tuần chưa xác nhận cần bấm Tính lại.');
  });
}

render();
