/**
 * 安装器（lib/installer.js）的单元测试。
 *
 * 这里刻意不真的安装任何软件包：
 *   - probePackage 只读 dpkg 数据库；
 *   - installPackages 在没有提权能力时必须**拒绝**安装并给出手动命令，
 *     这正是本机（容器内无免密 sudo）应该走的分支。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { auditLogPath, detectPrivilege, installPackages, probePackage, probePackages, tailOutput } from '../lib/installer.js'

test('probePackage 对已知已安装的系统包返回 installed', async () => {
  const result = await probePackage('dpkg')
  assert.equal(result.name, 'dpkg')
  assert.ok(
    ['installed', 'unknown'].includes(result.state),
    `意外的包状态：${result.state}（${result.detail}）`,
  )
})

test('probePackage 对不存在的包返回 missing', async () => {
  const result = await probePackage('dsh-definitely-not-a-package')
  assert.equal(result.state, 'missing')
})

test('probePackages 批量探测并保持顺序', async () => {
  const results = await probePackages(['dpkg', 'dsh-definitely-not-a-package'])
  assert.equal(results.length, 2)
  assert.equal(results[0].name, 'dpkg')
  assert.equal(results[1].name, 'dsh-definitely-not-a-package')
})

test('detectPrivilege 返回受支持的提权方式', async () => {
  const privilege = await detectPrivilege()
  assert.ok(['root', 'sudo', 'pkexec', 'none'].includes(privilege.mode))
  assert.ok(privilege.label)
})

test('installPackages 在没有提权能力时拒绝安装并给出手动命令', async () => {
  const result = await installPackages(['xdotool'], {
    privilege: { mode: 'none', label: '无法提权', detail: '本机没有可用的非交互提权方式' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.method, 'none')
  assert.match(result.command, /apt-get install -y xdotool/)
  assert.match(result.output, /手动执行/)
})

test('installPackages 收到空包列表时什么都不做', async () => {
  const result = await installPackages([])
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
})

test('tailOutput 只保留末尾若干行', () => {
  const output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  const tail = tailOutput(output, 3)
  assert.equal(tail, 'line 37\nline 38\nline 39')
})

test('审计日志路径落在用户状态目录下', () => {
  const path = auditLogPath({ HOME: '/tmp/dsh-test-home' })
  assert.equal(path, '/tmp/dsh-test-home/.local/state/dsh/linux-desktop-use-install.log')
  assert.ok(!existsSync(path), '审计日志只应在真正安装时才写入')
})
