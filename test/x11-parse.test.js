import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWindowList,
  parseXrandrMonitors,
  parseXrandrCurrent,
} from '../lib/x11.js'

test('解析 wmctrl -l -G -p 输出（含主机名剥离）', () => {
  const text = [
    '0x01400004  0 186227 0    33   1882 1007 xdev 登录 - Minas - Chromium',
    '0x00c08233  0 1702   0    89   1882 979  xdev dsh-linux-desktop-use - Thunar',
  ].join('\n')
  const windows = parseWindowList(text, { host: 'xdev' })
  assert.equal(windows.length, 2)
  assert.equal(windows[0].id, '0x01400004')
  assert.equal(windows[0].pid, 186227)
  assert.equal(windows[0].x, 0)
  assert.equal(windows[0].y, 33)
  assert.equal(windows[0].width, 1882)
  assert.equal(windows[0].height, 1007)
  assert.equal(windows[0].title, '登录 - Minas - Chromium')
  assert.equal(windows[1].title, 'dsh-linux-desktop-use - Thunar')
})

test('解析 wmctrl -lx -G -p 输出（含 WM_CLASS）', () => {
  const text = [
    '0x01400004  0 186227 0    33   1882 1007 chromium.Chromium     xdev 登录 - Minas - Chromium',
    '0x00c08233  0 1702   0    89   1882 979  Thunar.Thunar         xdev dsh-linux-desktop-use - Thunar',
  ].join('\n')
  const windows = parseWindowList(text, { host: 'xdev', withClass: true })
  assert.equal(windows.length, 2)
  assert.equal(windows[0].wmClass, 'chromium.Chromium')
  assert.equal(windows[0].title, '登录 - Minas - Chromium')
  assert.equal(windows[1].wmClass, 'Thunar.Thunar')
})

test('主机名不匹配时保留为标题一部分', () => {
  const text = '0x1 0 10 0 0 100 100 other-host My Title'
  const windows = parseWindowList(text, { host: 'xdev' })
  assert.equal(windows[0].title, 'other-host My Title')
})

test('解析 xrandr --listmonitors 输出', () => {
  const text = [
    'Monitors: 1',
    ' 0: +VNC-0 1882/498x1040/275+0+0  VNC-0',
    '',
  ].join('\n')
  const monitors = parseXrandrMonitors(text)
  assert.equal(monitors.length, 1)
  assert.equal(monitors[0].name, 'VNC-0')
  assert.equal(monitors[0].primary, true)
  assert.equal(monitors[0].x, 0)
  assert.equal(monitors[0].y, 0)
  assert.equal(monitors[0].width, 1882)
  assert.equal(monitors[0].height, 1040)
  assert.equal(monitors[0].widthMm, 498)
  assert.equal(monitors[0].heightMm, 275)
})

test('解析 xrandr --listmonitors 多显示器与非主屏', () => {
  const text = [
    'Monitors: 2',
    ' 0: +VNC-0 1882/498x1040/275+0+0  VNC-0',
    ' 1: HDMI-1 1920/530x1080/300+1882+0  HDMI-1',
  ].join('\n')
  const monitors = parseXrandrMonitors(text)
  assert.equal(monitors.length, 2)
  assert.equal(monitors[1].name, 'HDMI-1')
  assert.equal(monitors[1].primary, false)
  assert.equal(monitors[1].x, 1882)
  assert.equal(monitors[1].width, 1920)
})

test('解析 xrandr --current 输出获取连接状态', () => {
  const text = [
    'Screen 0: minimum 1 x 1, current 1882 x 1040, maximum 32767 x 32767',
    'VNC-0 connected primary 1882x1040+0+0 (normal left inverted right x axis y axis) 0mm x 0mm',
    '   1882x1040     60.00*+',
    '   1600x1200     60.00+',
    'HDMI-1 disconnected (normal left inverted right x axis y axis)',
  ].join('\n')
  const outputs = parseXrandrCurrent(text)
  assert.equal(outputs.length, 2)
  const vnc = outputs.find((o) => o.name === 'VNC-0')
  assert.equal(vnc.connected, true)
  assert.equal(vnc.primary, true)
  assert.equal(vnc.width, 1882)
  assert.equal(vnc.height, 1040)
  assert.ok(vnc.modes.includes('1600x1200'))
  const hdmi = outputs.find((o) => o.name === 'HDMI-1')
  assert.equal(hdmi.connected, false)
})
