'use strict';
// 生成自检面板的离线预览页（仅用于开发期截图核对，不参与打包）
// 用法：node scripts/make-preview.js <check.json> <out.html>
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const jsonPath = process.argv[2] || path.join(root, 'build', 'check-sample.json');
const outPath = process.argv[3] || path.join(root, 'build', 'preview.html');

const sample = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

let html = fs.readFileSync(path.join(root, 'app', 'renderer', 'index.html'), 'utf8');
html = html
  .replace('href="styles.css"', 'href="../app/renderer/styles.css"')
  .replace('src="renderer.js"', 'src="../app/renderer/renderer.js"');

const inject = `
<script>
  const SAMPLE = ${JSON.stringify(sample)};
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('view').hidden = true;
    document.querySelector('.placeholder').hidden = true;
    document.getElementById('status').textContent = '运行中';
    document.getElementById('status').className = 'status ok';
    if (SAMPLE.regionLabel === 'Asia/Tokyo') document.getElementById('region').value = 'jp';
    document.getElementById('checkPanel').hidden = false;   // 预览时直接展开面板
    window.__renderCheck({ ok: true, data: SAMPLE, raw: '（原始输出示例，已折叠）' });
    if (location.search.includes('all')) window.__setShowAll(true);
  });
</script>
`;

html = html.replace('</body>', inject + '</body>');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log('preview →', outPath);
