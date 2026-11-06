'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const ExcelJS = require('exceljs');

// Bố cục sheet đăng ký ca: cột A tên; B/C = T6 In/Out; D/E = T7; F/G = CN.
const DAY_COLUMNS = [
  { code: 'FRI', inCol: 1, outCol: 2 },
  { code: 'SAT', inCol: 3, outCol: 4 },
  { code: 'SUN', inCol: 5, outCol: 6 },
];

function parseLink(link) {
  const s = String(link || '').trim();
  const id = (s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1] || (/^[a-zA-Z0-9-_]{30,}$/.test(s) ? s : null);
  const gid = (s.match(/[#?&]gid=(\d+)/) || [])[1] || '0';
  if (!id) throw new Error('Link Google Sheet không hợp lệ. Hãy dán link dạng https://docs.google.com/spreadsheets/d/.../edit#gid=...');
  return { id, gid };
}

/** Tìm dòng dữ liệu đầu tiên: dòng ngay sau dòng có chữ "In"/"out". */
function detectFirstDataRow(matrix, fallback) {
  for (let r = 0; r < Math.min(matrix.length, 10); r++) {
    const row = (matrix[r] || []).map((v) => String(v ?? '').trim().toLowerCase());
    if (row.slice(1, 7).filter((v) => v === 'in' || v === 'out').length >= 4) return r + 1;
  }
  return fallback;
}

/** Chuyển ma trận ô thành danh sách {name, days:{FRI:{in,out},...}, row}. */
function matrixToEntries(matrix, firstDataRow1Based = 3) {
  const start = detectFirstDataRow(matrix, firstDataRow1Based - 1);
  const entries = [];
  for (let r = start; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const name = String(row[0] ?? '').trim();
    if (!name) continue;
    const days = {};
    for (const d of DAY_COLUMNS) days[d.code] = { in: row[d.inCol] ?? '', out: row[d.outCol] ?? '' };
    entries.push({ name, days, row: r + 1 });
  }
  return entries;
}

async function fetchPublicCsv(link, fetchImpl = fetch) {
  const { id, gid } = parseLink(link);
  const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
  let res;
  try { res = await fetchImpl(url, { redirect: 'follow' }); } catch (e) { throw new Error('Không kết nối được Google Sheet. Kiểm tra mạng. (' + e.message + ')'); }
  const text = await res.text();
  if (!res.ok || /^\s*<(!doctype|html)/i.test(text)) {
    throw new Error('Không đọc được sheet. Hãy bật chia sẻ "Bất kỳ ai có đường liên kết – Người xem", hoặc chuyển sang chế độ Service Account trong Cài đặt.');
  }
  return Papa.parse(text, { skipEmptyLines: false }).data;
}

function base64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }

async function serviceAccountToken(keyFile, fetchImpl = fetch) {
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
  const sig = base64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), key.private_key));
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${header}.${claim}.${sig}`,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('Service account không lấy được quyền: ' + (j.error_description || j.error || res.status));
  return { token: j.access_token, email: key.client_email };
}

async function fetchWithServiceAccount(link, keyFile, fetchImpl = fetch) {
  if (!keyFile || !fs.existsSync(keyFile)) throw new Error('Chưa chọn file JSON của service account trong Cài đặt.');
  const { id, gid } = parseLink(link);
  const { token, email } = await serviceAccountToken(keyFile, fetchImpl);
  const auth = { headers: { Authorization: 'Bearer ' + token } };
  const meta = await (await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`, auth)).json();
  if (meta.error) throw new Error(`Google trả lỗi: ${meta.error.message}. Hãy chia sẻ sheet cho ${email} quyền Người xem.`);
  const sheet = meta.sheets.find((s) => String(s.properties.sheetId) === String(gid)) || meta.sheets[0];
  const range = encodeURIComponent(`'${sheet.properties.title.replace(/'/g, "''")}'!A1:I300`);
  const vals = await (await fetchImpl(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?valueRenderOption=FORMATTED_VALUE`, auth)).json();
  if (vals.error) throw new Error('Google trả lỗi: ' + vals.error.message);
  return vals.values || [];
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    return '';
  }
  return v;
}

async function readLocalFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv') return Papa.parse(fs.readFileSync(file, 'utf8'), { skipEmptyLines: false }).data;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets.find((w) => w.state !== 'hidden') || wb.worksheets[0];
  const matrix = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    const arr = [];
    for (let c = 1; c <= 9; c++) arr.push(cellValue(row.getCell(c).value));
    matrix[r - 1] = arr;
  });
  for (let i = 0; i < matrix.length; i++) if (!matrix[i]) matrix[i] = [];
  return matrix;
}

module.exports = { parseLink, matrixToEntries, fetchPublicCsv, fetchWithServiceAccount, readLocalFile, DAY_COLUMNS };
