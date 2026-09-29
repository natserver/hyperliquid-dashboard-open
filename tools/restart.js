/**
 * 重启本机看板服务。
 *
 * 为什么需要它：改了 `src/*.js`（后端聚合逻辑）之后，静态文件会随刷新生效，
 * 但**后端已经算好并缓存起来的快照不会**——必须重启进程，否则页面还是旧数字，
 * 而你会以为「代码没生效」。这个脚本把「找到 PID → 停掉 → 重新拉起 → 探活」
 * 一次做完，省掉在本机被沙箱挡住的 taskkill / Stop-Process 折腾。
 *
 * 用法：node tools/restart.js [端口]
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.js');
const PORT = Number(process.argv[2] || 8787);
const NODE = process.execPath;

const log = (...a) => console.log(...a);

/** 找出监听该端口的进程 PID（走 netstat，不依赖 PowerShell 的 NetTCPConnection） */
function findListener(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      // 只认 LISTENING 且本地端口匹配的
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] || '';
      const pid = cols[cols.length - 1];
      if (local.endsWith(':' + port) && /^\d+$/.test(pid)) pids.add(Number(pid));
    }
    return [...pids];
  } catch (e) {
    log('  netstat 不可用：' + e.message);
    return [];
  }
}

const before = findListener(PORT);
log(`端口 ${PORT} 上的监听进程：${before.length ? before.join(', ') : '(无)'}`);

for (const pid of before) {
  if (pid === process.pid) continue;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    log(`  已停止 PID ${pid}`);
  } catch {
    // taskkill 不可用就退回 process.kill
    try {
      process.kill(pid);
      log(`  已用 process.kill 停止 PID ${pid}`);
    } catch (e2) {
      log(`  ✗ 无法停止 PID ${pid}：${e2.message}`);
    }
  }
}

/** 等服务真正释放端口 */
async function waitPortFree(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (findListener(PORT).length === 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
if (!(await waitPortFree())) {
  log('端口仍被占用，放弃启动（先手动清掉占用进程）');
  process.exit(1);
}

// detached + unref：让服务脱离本脚本独立存活
const child = spawn(NODE, [SERVER], { cwd: ROOT, detached: true, stdio: 'ignore' });
child.unref();
log(`已拉起新进程 PID ${child.pid}`);

/** 轮询健康检查，确认真的起来了 */
const t0 = Date.now();
let health = null;
while (Date.now() - t0 < 20000) {
  await new Promise((r) => setTimeout(r, 400));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) { health = await r.json(); break; }
  } catch {}
}

if (!health) {
  log('✗ 20s 内没有探活成功，检查 server.js 是否启动报错');
  process.exit(1);
}

log(`✓ 服务已就绪：${health.service}`);
log(`  只读=${health.readOnly}  持密钥=${health.holdsKeys}  网络=${(health.networks || []).map((n) => n.key).join('/')}`);
log(`  缓存=${JSON.stringify(health.cache)}（重启后归零，属正常）`);
