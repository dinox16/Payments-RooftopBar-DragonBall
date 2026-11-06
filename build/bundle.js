// Gộp main process + src/ thành app/main.js để bản đóng gói không cần node_modules
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({ entryPoints: [path.join(root, 'main.js')], bundle: true, platform: 'node', target: 'node20', external: ['electron'], outfile: path.join(out, 'main.js'), logLevel: 'warning' });
fs.copyFileSync(path.join(root, 'preload.js'), path.join(out, 'preload.js'));
fs.cpSync(path.join(root, 'renderer'), path.join(out, 'renderer'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'), path.join(out, 'sql-wasm.wasm'));
fs.copyFileSync(path.join(__dirname, 'icon.png'), path.join(out, 'icon.png'));
console.log('bundled', (fs.statSync(path.join(out, 'main.js')).size / 1024).toFixed(0) + ' KB');
