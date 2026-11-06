'use strict';
// Tạo chuỗi VietQR (chuẩn EMVCo / NAPAS 247) để chuyển khoản tới số tài khoản, cố định số tiền và nội dung.
// Không cần mạng: app ngân hàng nào hỗ trợ VietQR đều quét được.
const { stripAccents } = require('./time');

// Tên ngân hàng trong mẫu "Danh sách ngân hàng" → mã BIN NAPAS dùng cho VietQR.
const BIN_BY_TEMPLATE_NAME = {
  'BIDV': '970418',
  'NHTNHH MTV HSBC VN': '458761',
  'NH NONGHYUP-CN Hà Nội': '801011',
  'NH Đại Chúng TNHH Kasikornbank- CN HCM': '668888',
  'NH Lộc Phát VN': '970449',
  'NH TNHH MTV United Overseas Bank (Việt Nam)': '970458',
  'NHTMCP Xuất nhập khẩu': '970431',
  'NHTMCP Kiên Long': '970452',
  'CN NH Công nghiệp Hàn Quốc tại Hà Nội': '970455',
  'CN NH Công nghiệp Hàn Quốc tại thành phố HCM': '970456',
  'NHTMCP Bắc Á': '970409',
  'NHTMCP Sài Gòn Hà Nội': '970443',
  'NH TNHH MTV Standard Chartered (Việt Nam)': '970410',
  'Nh TNHH MTV Việt Nam Hiện Đại': '970414',
  'NHTMCP Đại Chúng VN': '970412',
  'NHTMCP Quốc Dân': '970419',
  'NHTMCP Bản Việt': '970454',
  'NH Hợp tác xã VN': '970446',
  'Ngân hàng thương mại cổ phần An Bình': '970425',
  'NHTMCP Đông Nam Á': '970440',
  'NH Nông nghiệp và PTNT Việt Nam': '970405',
  'NHTM TNHH MTV Ngoại thương Công nghệ số': '970444',
  'NHTMCP Sài Gòn': '970429',
  'NHTMCP Phương Đông': '970448',
  'NHTMCP Sài Gòn Công Thương': '970400',
  'NHTMCP Quốc Tế VN': '970441',
  'IndovinaBank': '970434',
  'NHTMCP Hàng Hải VN': '970426',
  'NH Liên Doanh Việt Nga': '970421',
  'NHTMCP Ngoại thương Việt Nam (VCB)': '970436',
  'NHTMCP Á Châu': '970416',
  'NHTMCP Việt Nam Thịnh Vượng': '970432',
  'NH TNHH MTV Hong Leong VN': '970442',
  'NH KooMin-CN Thành phố HCM': '970463',
  'NH KooMin-CN Hà Nội': '970462',
  'DBS Bank LTD-CN Thành phố HCM': '796500',
  'NH TMCP Thịnh vượng và phát triển': '970430',
  'NHTMCP Việt Nam Thương Tín': '970433',
  'NHTMCP Nam Á': '970428',
  'NHTMCP Công Thương VN': '970415',
  'NHTMCP Việt Á': '970427',
  'Ngân hàng số Vikki': '970406',
  'NH TNHH MTV SHINHAN VN': '970424',
  'NHTMCP Tiên Phong': '970423',
  'NH TNHH MTV Public VN': '970439',
  'NHTMCP Sài Gòn Tài Lộc': '970403',
  'NH TNHH MTV Woori VN': '970457',
  'NHTMCP Quân Đội': '970422',
  'NH TNHH MTV CIMB VN': '422589',
  'NHTM TNHH MTV Kỷ Nguyên Thịnh Vượng': '970408',
  'NHTMCP Bảo Việt': '970438',
  'NHTMCP Phát triển Thành phố HCM': '970437',
  'NHTMCP Kỹ Thương Việt Nam (TCB)': '970407',
};

const norm = (s) => stripAccents(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
const BIN_INDEX = new Map(Object.entries(BIN_BY_TEMPLATE_NAME).map(([k, v]) => [norm(k), v]));

function binForBank(name) { return BIN_INDEX.get(norm(name)) || null; }

function tlv(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(str) {
  let crc = 0xffff;
  for (const b of Buffer.from(str, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Nội dung QR chỉ nên gồm chữ không dấu, số và vài ký tự đơn giản. */
function cleanRemark(s) {
  return stripAccents(String(s || '')).replace(/[^A-Za-z0-9 .,\-/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
}

/** Chuỗi VietQR chuyển khoản tới tài khoản, có số tiền cố định. */
function buildPayload({ bin, account, amount, remark }) {
  if (!/^\d{6}$/.test(String(bin || ''))) throw new Error('Thiếu mã BIN ngân hàng');
  const acc = String(account || '').replace(/\s+/g, '');
  if (!acc) throw new Error('Thiếu số tài khoản');
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', bin) + tlv('01', acc)) + tlv('02', 'QRIBFTTA');
  let s = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (amount) s += tlv('54', String(Math.round(amount)));
  s += tlv('58', 'VN');
  const r = cleanRemark(remark);
  if (r) s += tlv('62', tlv('08', r));
  s += '6304';
  return s + crc16(s);
}

module.exports = { buildPayload, binForBank, crc16, cleanRemark, BIN_BY_TEMPLATE_NAME };
