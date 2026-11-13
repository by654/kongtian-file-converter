// 本地静态服务器：模拟 GitHub Pages 环境（不设置 COOP/COEP，不启用缓存）
// 默认绑定 0.0.0.0，启动后打印所有可用的局域网 IPv4 地址，手机/其他电脑可直接访问。
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8788);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';

  // 仅本地开发：收集测试页结果（tests/last-*.json），便于在终端查看
  if (req.method === 'POST' && pathname.startsWith('/__')) {
    const map = { '/__result': 'last-result.json', '/__ui-result': 'last-ui.json' };
    const safe = pathname.replace(/[^a-z0-9_-]/gi, '').replace(/^[-_]+/, '') || 'result';
    const file = map[pathname] || `last-${safe}.json`;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        await writeFile(join(ROOT, 'tests', file), body, 'utf8');
        res.writeHead(204).end();
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    return;
  }

  const target = normalize(join(ROOT, pathname));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + pathname);
    return;
  }

  const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
  const size = statSync(target).size;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    // 刻意不设置 Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy，
    // 以便与 GitHub Pages 环境一致，验证单线程 ffmpeg.wasm 可用。
  });
  createReadStream(target).pipe(res);
});

function lanAddresses() {
  const list = [];
  const nets = networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  }
  return list;
}

function printReady() {
  const local = `http://127.0.0.1:${PORT}/`;
  const lans = lanAddresses();
  console.log('');
  console.log('  空天文件转换 · 本地服务已启动');
  console.log('  ────────────────────────────────────────');
  console.log(`  本机访问：  ${local}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    if (lans.length) {
      for (const item of lans) {
        console.log(`  局域网访问：http://${item.address}:${PORT}/   [${item.name}]`);
      }
      console.log('');
      console.log('  手机 / 其他电脑请连接同一 Wi-Fi，输入上面的「局域网访问」地址。');
    } else {
      console.log('  未检测到可用的局域网 IPv4 地址，请检查网络连接。');
    }
  } else {
    console.log(`  仅绑定 ${HOST}，局域网设备无法访问（可用 HOST=0.0.0.0 启动）。`);
  }
  console.log('  ────────────────────────────────────────');
  console.log(`  测试页：    ${local}tests/test.html`);
  console.log(`  界面测试：  ${local}tests/ui-flow.html`);
  console.log('');
  console.log('  防火墙提示（Windows）：');
  console.log('  · 首次启动若弹出“Windows Defender 防火墙”提示，请勾选“专用网络”并允许访问。');
  console.log(`  · 若已误点拒绝或无法连接，用管理员 PowerShell 执行：`);
  console.log(`      New-NetFirewallRule -DisplayName "KongTian ${PORT}" -Direction Inbound -Protocol TCP -LocalPort ${PORT} -Action Allow`);
  console.log('  · 手机与电脑需在同一网段；部分路由器开启“AP 隔离”时设备间无法互访。');
  console.log('');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用。可换端口启动：$env:PORT=8789; node dev/serve.mjs`);
  } else if (err.code === 'EACCES') {
    console.error(`没有权限绑定 ${HOST}:${PORT}，请换一个大于 1024 的端口。`);
  } else {
    console.error('服务启动失败：', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, printReady);
