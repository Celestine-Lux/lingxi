'use strict';
/**
 * 启动包装器（由 start.bat 调用）：负责找 Node、给出中文提示、必要时暂停窗口。
 *
 *   node tools/launch.js                  启动服务（等价于 node server.js）
 *   node tools/launch.js --port 6000      换端口
 *   node tools/launch.js --no-open        不自动打开浏览器
 *   node tools/launch.js --selftest       只跑离线自检
 *   node tools/launch.js --selftest --pause  自检完暂停，方便看结果
 *
 * 之所以多这一层：cmd.exe 按系统 OEM 代码页读取 .bat 文件，写中文会变乱码，
 * 所以 .bat 保持纯 ASCII，所有中文提示都由 Node 打印（Node 写的是 UTF-8）。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const NO_PAUSE = argv.includes('--no-pause') || process.env.LINGXI_NO_PAUSE === '1';
const IS_TTY = !!(process.stdin && process.stdin.isTTY);

function pause(message) {
  if (NO_PAUSE || !IS_TTY) return Promise.resolve();
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
    process.stdin.once('end', resolve);
  });
}

function box(lines) {
  const width = Math.max(...lines.map((l) => displayWidth(l))) + 2;
  console.log('');
  console.log('  ' + '─'.repeat(width));
  for (const l of lines) console.log('  ' + l);
  console.log('  ' + '─'.repeat(width));
  console.log('');
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`\n  [x] 当前 Node 版本是 ${process.version}，本工具需要 18 或更高版本。\n      请到 https://nodejs.org 升级后重试。\n`);
    return false;
  }
  return true;
}

function checkFiles() {
  const need = ['server.js', 'src/analyzer.js', 'public/index.html', 'public/app.js', 'public/style.css'];
  const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('\n  [x] 文件不完整，缺少：' + missing.join('、'));
    console.error('      请确认整个文件夹是一起复制过来的（server.js、src、public、samples、tools 都要在）。\n');
    return false;
  }
  return true;
}

function runNode(args, label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false });
    child.on('error', (err) => {
      console.error(`\n  [x] ${label} 启动失败：${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : code == null ? 0 : code));
  });
}

async function main() {
  if (!checkNode()) {
    await pause('  按回车键关闭…');
    process.exit(1);
  }
  if (!checkFiles()) {
    await pause('  按回车键关闭…');
    process.exit(1);
  }

  if (argv.includes('--selftest')) {
    const rest = argv.filter((a) => a !== '--selftest' && a !== '--pause' && a !== '--no-pause');
    const code = await runNode([path.join('tools', 'selftest.js'), ...rest], '自检');
    if (code !== 0) {
      console.log('\n  自检没有全部通过，把上面的 FAIL 行复制给我即可。');
    } else {
      console.log('\n  自检全部通过。');
    }
    await pause('  按回车键关闭…');
    process.exit(code);
  }

  box([
    '灵犀 · 聊天解读小工具',
    '',
    `Node 版本：${process.version}`,
    '启动后浏览器会自动打开 http://127.0.0.1:5178/',
    '数据只在本机流转；关掉这个窗口就能停止服务（或按 Ctrl+C）。',
  ]);

  const code = await runNode(['server.js', ...argv], '服务');
  if (code !== 0) {
    console.log(`\n  服务已退出，退出码 ${code}。`);
    console.log('  如果上面有报错信息，把它复制给我就能排查。');
    await pause('  按回车键关闭…');
  }
  process.exit(code);
}

main().catch(async (err) => {
  console.error('\n  [x] 启动器出错：' + (err && err.message ? err.message : String(err)));
  await pause('  按回车键关闭…');
  process.exit(1);
});
