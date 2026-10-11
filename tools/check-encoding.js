'use strict';
/**
 * 检查项目里文本文件的编码，避免 Windows 上「乱码把命令解析坏」这类问题。
 *
 * 规则：
 *   - start.bat / *.cmd / *.ini 这类会被 cmd.exe 按 OEM 代码页解析的文件：不允许有任何非 ASCII 字符。
 *   - 其它 .js / .json / .md / .txt / .css / .html：UTF-8 编码即可（Node 与浏览器都按 UTF-8 读）。
 *
 * 用法： node tools/check-encoding.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const CMD_LIKE = /\.(bat|cmd|ini|inf)$/i;

let problems = 0;
let checked = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(js|json|md|txt|css|html|bat|cmd|example)$/i.test(entry.name) && !CMD_LIKE.test(entry.name)) continue;
    checkFile(full);
  }
}

function checkFile(full) {
  const rel = path.relative(ROOT, full);
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch (err) {
    console.log(`  ?    ${rel} 读取失败：${err.message}`);
    return;
  }
  checked += 1;

  // BOM 检查：UTF-8 BOM 在 JS/JSON 里不会出错，但没必要，最好没有
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const body = hasBom ? buf.slice(3) : buf;
  const text = body.toString('utf8');

  if (text.includes('\uFFFD')) {
    console.log(`  FAIL ${rel}：不是合法的 UTF-8（出现替换字符），请另存为 UTF-8。`);
    problems += 1;
    return;
  }

  if (CMD_LIKE.test(rel)) {
    const bad = text.split(/\r?\n/).findIndex((line) => /[^\x00-\x7F]/.test(line));
    if (bad !== -1) {
      const line = text.split(/\r?\n/)[bad];
      console.log(`  FAIL ${rel}：第 ${bad + 1} 行有非 ASCII 字符（cmd.exe 会读成乱码）→ ${line.trim().slice(0, 60)}`);
      problems += 1;
      return;
    }
    console.log(`  ok   ${rel}（纯 ASCII，cmd.exe 安全）`);
    return;
  }

  if (hasBom && /\.(json|html|css)$/i.test(rel)) {
    console.log(`  warn ${rel}：带 UTF-8 BOM，浏览器/Node 能读，但建议去掉。`);
  } else {
    console.log(`  ok   ${rel}（UTF-8${hasBom ? ' + BOM' : ''}）`);
  }
}

console.log('检查文件编码…\n');
walk(ROOT);
console.log(`\n共检查 ${checked} 个文件，问题 ${problems} 个。`);
if (problems) process.exitCode = 1;
