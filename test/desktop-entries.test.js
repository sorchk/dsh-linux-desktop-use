import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDesktopEntry,
  parseExecLine,
  desktopEntryBasename,
} from '../lib/desktop-entries.js'

test('解析中文本地化名称与常用字段', () => {
  const entry = parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Thunar File Manager
Name[zh_CN]=Thunar 文件管理器
Name[zh]=Thunar 文件管理
Exec=thunar %U
Icon=org.xfce.thunar
Terminal=false
NoDisplay=false
Hidden=false
Categories=System;FileTools;
StartupWMClass=Thunar
TryExec=thunar
`, 'thunar.desktop', { locale: 'zh_CN.UTF-8' })

  assert.equal(entry.id, 'thunar')
  assert.equal(entry.name, 'Thunar File Manager')
  assert.equal(entry.nameLocal, 'Thunar 文件管理器')
  assert.equal(entry.exec, 'thunar %U')
  assert.equal(entry.icon, 'org.xfce.thunar')
  assert.equal(entry.terminal, false)
  assert.equal(entry.noDisplay, false)
  assert.equal(entry.hidden, false)
  assert.deepEqual(entry.categories, ['System', 'FileTools'])
  assert.equal(entry.startupWmClass, 'Thunar')
  assert.equal(entry.tryExec, 'thunar')
  assert.equal(entry.type, 'Application')
})

test('没有本地化名称时 nameLocal 回落为 Name', () => {
  const entry = parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Plain App
Exec=plainapp
`, 'plain.desktop')
  assert.equal(entry.nameLocal, 'Plain App')
})

test('本地化名称按语言前缀降序匹配 zh_CN 优先于 zh', () => {
  const entry = parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Fallback
Name[zh]=中文通用
Name[zh_CN]=中文简体
Exec=x
`, 'x.desktop')
  assert.equal(entry.nameLocal, '中文简体')
})

test('Desktop Action 子组不覆盖主条目，只统计数量', () => {
  const entry = parseDesktopEntry(`[Desktop Entry]
Type=Application
Name=Editor
Exec=editor %U

[Desktop Action new-window]
Name=New Window
Exec=editor --new-window
`, 'editor.desktop')
  assert.equal(entry.name, 'Editor')
  assert.equal(entry.actionCount, 1)
})

test('缺少 Desktop Entry 组时返回 null', () => {
  assert.equal(parseDesktopEntry('[Other]\nType=Application\n', 'x.desktop'), null)
})

test('Exec 字段码被剥离并保留引号内的空格', () => {
  assert.deepEqual(parseExecLine('thunar %U'), ['thunar'])
  assert.deepEqual(parseExecLine('/usr/bin/tilda --dbus'), ['/usr/bin/tilda', '--dbus'])
  assert.deepEqual(parseExecLine('code --new-window %F'), ['code', '--new-window'])
  assert.deepEqual(parseExecLine('app "%F" %u'), ['app'])
  assert.deepEqual(parseExecLine('app "hello world"'), ['app', 'hello world'])
  assert.deepEqual(parseExecLine('app %i %c %k'), ['app'])
})

test('Exec 可执行文件名提取', () => {
  assert.equal(desktopEntryBasename('/home/sorc/.local/vscode/code %F'), 'code')
  assert.equal(desktopEntryBasename('thunar %U'), 'thunar')
  assert.equal(desktopEntryBasename('/usr/bin/tilda --dbus'), 'tilda')
  assert.equal(desktopEntryBasename(''), '')
})
