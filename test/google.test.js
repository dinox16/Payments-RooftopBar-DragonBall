'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const { parseLink, fetchPublicCsv, fetchWithServiceAccount } = require('../src/sheet');

const LINK = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=123456';
const resp = (body, ok = true, status = 200) => ({ ok, status, text: async () => body, json: async () => JSON.parse(body) });

test('đọc link', () => {
  assert.deepEqual(parseLink(LINK), { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', gid: '123456' });
  assert.throws(() => parseLink('abc'), /không hợp lệ/);
});

test('link công khai: tải CSV đúng tab, báo lỗi khi chưa chia sẻ', async () => {
  let url;
  const m = await fetchPublicCsv(LINK, async (u) => { url = u; return resp(',T6\n,In,out\nAn,6:00:00,10:30:00'); });
  assert.match(url, /export\?format=csv&gid=123456$/);
  assert.equal(m[2][0], 'An');
  await assert.rejects(fetchPublicCsv(LINK, async () => resp('<!DOCTYPE html><html>login')), /chia sẻ/);
});

test('service account: ký JWT, chọn đúng tab theo gid', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')), 'k.json');
  fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  const calls = [];
  const f = async (u, o) => {
    calls.push(u);
    if (u.includes('oauth2')) { assert.match(o.body, /assertion=[\w-]+\.[\w-]+\.[\w-]+$/); return resp('{"access_token":"T"}'); }
    if (u.includes('fields=sheets')) return resp(JSON.stringify({ sheets: [{ properties: { sheetId: 0, title: 'Tuần cũ' } }, { properties: { sheetId: 123456, title: "Tuần 06/11" } }] }));
    return resp(JSON.stringify({ values: [['', 'T6'], ['', 'In', 'out'], ['Chi', '6:00:00', '12:00:00']] }));
  };
  const m = await fetchWithServiceAccount(LINK, keyFile, f);
  assert.equal(m[2][0], 'Chi');
  assert.match(decodeURIComponent(calls[2]), /'Tuần 06\/11'!A1:I300/);
});
