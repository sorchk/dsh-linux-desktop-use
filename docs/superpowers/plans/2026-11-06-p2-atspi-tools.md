# P2：AT-SPI 无障碍树与控件赋值 工具

## Goal

在插件 `dsh-linux-desktop-use`（当前 v1.6.1）上补齐「读懂界面语义」这一层能力。
此前所有工具都停留在**像素层**（截图 + 坐标点击），模型无法知道屏幕上那个按钮叫什么、
输入框里现在是什么内容。接入 AT-SPI 后，模型可以直接拿到控件树与控件内容：

| 工具名 | 作用 | 对标参考工具 |
| --- | --- | --- |
| `linux_app_state` | 读取目标应用的无障碍树：角色、名称、描述、状态、屏幕坐标、文本内容 | `computer_app_state` |
| `linux_set_value` | 直接给某个可编辑控件写入文本（不走逐键模拟） | `computer_set_value` |

`linux_app_state` 的每个节点自带 **屏幕坐标** 与 **文本内容**，因此顺带解决两个此前缺失的能力：

- **元素级定位**：点击目标不再靠截图猜像素，而是从 AX 树取控件外接矩形再换算坐标；
- **控件文本直读**：不需要 OCR 或截图识别，直接读 `Text` 接口。

约束：
- **零新 npm 依赖**（只用 Node 内置模块 + 本机 `python3`）；
- Python 侧只用系统自带的 `python3-gi` + `gir1.2-atspi-2.0`（本机已装），不引入 PyPI 包；
- 不做 `select_text`（GTK3 的 `Selection` 接口缺失，实测不可行）与原生右键菜单（AX 树里没有
  `menu` / `menu item` 角色）。

## Architecture

```
lib/
  atspi.py          ← 新增：AT-SPI 采集脚本（gi/Atspi），stdin 收 JSON，stdout 出 JSON
  atspi.js          ← 新增：Node 侧封装（环境拼装、spawn 脚本、响应解析、树裁剪/筛选、错误映射）
  tools.js          ← 扩展：注册 linux_app_state / linux_set_value
  guard.js          ← 扩展：linux_set_value 进 WRITE_TOOLS + 风险信号 + describeAction 文案
  diagnostics.js    ← 扩展：体检新增「AT-SPI 能力」一段（python3 / gi / Atspi / a11y 总线）
test/
  atspi.test.js     ← 新增：Node 侧纯逻辑单测（不需要 X 会话，也不需要 python3）
  integration.test.js ← 扩展：真实 AT-SPI 会话下的冒烟（检测不到条件时自动跳过）
```

分层原则：**Python 只做「遍历 + 调接口」，一切可测试的判定逻辑放 JS。**

- `atspi.py` 输出**原始**的节点 JSON（不做筛选、不做裁剪）；
- `atspi.js` 负责环境拼装、请求构造、响应解析、树的深度裁剪与角色/名称筛选、控件匹配、
  错误映射——这些全是纯函数，可以在没有 X 会话、没有 python3 的环境里单测；
- Python 侧只保留不可替代的一步：用 `Atspi` 绑定真正走 AT-SPI 总线。

### 为什么必须经 Python 子进程

裸 D-Bus 拿不到应用清单：实测 `gdbus` / `busctl` 对 `org.a11y.atspi.Registry` 调
`org.a11y.atspi.Accessible.GetChildren` 恒返回空数组（`a(so) 0`），而同一时刻 Python 绑定
能列出应用——应用清单只在 libatspi 的内部路径暴露。因此 Node 侧不自己实现 AT-SPI 协议，
而是 `spawn` 一个 `python3` 辅助脚本，用 JSON 交换数据。

## Tech Stack

- Node.js ≥ 20（ESM），内置 `node:test` + `node:assert/strict`、`node:child_process`
- Python 3（系统自带）+ `python3-gi` + `gir1.2-atspi-2.0`（本机已装）
- 系统包：`at-spi2-core`（a11y 总线）、`libatk-adaptor`（GTK3 桥接）
- 无新增 npm 依赖

## Spec

### S1 `lib/atspi.py`（采集脚本）

协议：**stdin 收一个 JSON 请求，stdout 回一个 JSON 响应**（不打印任何其他内容到 stdout）。

请求：

```jsonc
{ "op": "ping" }                                   // 探活 + 列出总线上应用数
{ "op": "tree", "maxDepth": 8 }                    // 采集全部应用的原始节点树
{ "op": "setValue", "value": "文本" }               // 由 JS 侧下发的定位参数一并带上
```

响应：

```jsonc
{ "ok": true, "apps": [ { "name": "...", "pid": 123, "nodes": [ /* 节点 */ ] } ] }
{ "ok": false, "error": "错误说明" }
```

节点结构：

```jsonc
{
  "role": "push button",
  "name": "Click Me",
  "description": "",
  "states": ["enabled", "focusable", "sensitive", "showing", "visible"],
  "box": { "x": 741, "y": 484, "width": 400, "height": 26 },  // 屏幕绝对坐标，取不到时为 null
  "text": null,        // Text 接口读到的内容（超长截断），无则 null
  "editable": false,   // 是否实现 EditableText
  "actions": [ { "name": "click", "description": "Clicks the button" } ],
  "children": [ /* 递归 */ ]
}
```

硬性要求：
- 任何异常都必须被捕获并转成 `{"ok": false, "error": "..."}`，不能让脚本以非零码退出而丢上下文；
- `setValue` 操作：`EditableText.set_text_contents(value)`，返回是否成功；
- `maxDepth` 默认 8，最大 20，避免在超大树上卡住。

### S2 `lib/atspi.js`（Node 侧封装）

```js
export function buildA11yEnv(env, { dbusAddress, display, xauthority }) -> Record<string,string>
export function buildA11yRequest(op, params) -> string            // 请求 JSON 文本
export function parseA11yResponse(text) -> object                  // 解析响应，非法 JSON 抛可读错误
export function trimTree(node, maxDepth) -> node                   // 深度裁剪
export function collectNodes(tree, { role, nameContains, maxDepth }) -> node[]   // 扁平化 + 筛选
export function pickEditableNode(nodes, { role, nameContains }) -> node | null
export function nodeBox(node) -> { x, y, width, height } | null
export function nodeCenter(node) -> { x, y } | null
export function isA11yUnavailable(text) -> boolean                 // 识别「AT-SPI 未就绪」类错误
export async function runA11y(env, request, { timeoutMs }) -> object // spawn python3 执行脚本
```

规则：
- `buildA11yEnv` 必须在环境里带上 `DISPLAY`、`XAUTHORITY`、`DBUS_SESSION_BUS_ADDRESS`；
  `DBUS_SESSION_BUS_ADDRESS` 优先用传入值，其次用调用方从运行中窗口 `/proc/<pid>/environ`
  反查到的值（复用 `lib/apps.js` 的 `findSessionBusAddress`）。
- `parseA11yResponse` 对非法 JSON 抛 `AT-SPI 脚本返回了无法解析的内容`；
  对 `ok: false` 抛脚本给出的错误文本。
- `isA11yUnavailable` 识别这些关键字：`Couldn't connect to accessibility bus`、
  `No module named 'gi'`、`ModuleNotFoundError`、`at-spi-bus-launcher`，
  用于把「依赖没装 / 总线没起来」翻译成中文可操作提示。
- `runA11y` 用 `spawn('python3', [scriptPath])`，不经过 shell；超时（默认 15s）后 kill；
  脚本路径由 `import.meta.url` 定位到 `lib/atspi.py`。

### S3 工具定义

#### `linux_app_state`（只读）

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `app` | string | 应用名关键字（不区分大小写，匹配 AX 应用名或窗口标题） |
| `role` | string | 只保留该角色的节点（不区分大小写） |
| `name_contains` | string | 只保留名称包含该关键字的节点 |
| `max_depth` | number | 树深度上限，默认 8，最大 20 |

输出：`{ apps: [{ name, pid, nodes }], counts: { apps, nodes } }`。

行为：
- 不传 `app` 时返回总线上全部应用；
- 传 `app` 时只返回匹配的应用；一个都不匹配时**返回空列表而不是报错**（应用可能还没注册）；
- 节点里的 `box` 是屏幕绝对坐标，可直接喂给 `linux_click`。

#### `linux_set_value`（写）

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `value` | string | 要写入的文本（必填，允许空串以外的任意内容） |
| `app` | string | 应用名关键字 |
| `role` | string | 目标控件角色，如 `text` / `entry` |
| `name_contains` | string | 目标控件名称关键字 |

输出：`{ app, role, name, before, after, changed, risks }`。

行为：
- 属于写操作：**必须先有新鲜的 `linux_screenshot`**，走 `guardAction`（作用域白名单 + 危险语义 + 分级审批），
  动作后 `invalidateObservation()`；
- 定位不到目标控件时抛可读错误：
  `没有找到可编辑的控件（role=..., name 包含 "..."）：先用 linux_app_state 看看有哪些控件。`；
- 找到多个候选时取第一个，并在输出里回报命中的那个（role / name），让模型能确认没写错地方。

### S4 `lib/guard.js` 扩展

- `WRITE_TOOLS` 增加 `linux_set_value`；
- `collectRiskSignals`：`linux_set_value` 的 `args.value` 作为 `set-value` 来源参与危险语义识别
  （与 `linux_type` 的 `typed-text` 同等对待）；
- `describeAction` 增加一条：`设置控件 ${role/name} 的值为 N 个字符`。

### S5 `lib/diagnostics.js` 扩展

体检报告新增 `a11y` 段：

| 字段 | 含义 |
| --- | --- |
| `python3` | 是否找到 python3 可执行文件 |
| `gi` | `python3-gi` + `gir1.2-atspi-2.0` 是否就绪 |
| `bus` | a11y 总线 socket 是否存在（`/run/user/<uid>/at-spi/bus`） |
| `available` | 上面三项都满足才为 true |
| `detail` | 不可用时的中文原因 |

不可用时记一条 **info 级** issue（不是 error）：AT-SPI 是可选增强，缺失不应让体检判失败。

## Global Constraints

- 中文文案与注释；工具 description 用英文、参数 description 用中文（沿用现有约定）。
- 零新 npm 依赖；不新增 PyPI 依赖。
- 不改安全模型语义：新的写工具照旧走 `guardAction`，只读工具不触发审批。
- AT-SPI 是**可选增强**：依赖缺失时工具报可读错误，其余工具完全不受影响。
- Python 脚本不打印任何非 JSON 内容到 stdout（否则 Node 侧解析会失败）。
- 版本号：`1.6.1` → `1.7.0`（新增完整模块 → 次版本号），升版打同名 tag `v1.7.0`。
- 同步 `README.md`、`CHANGELOG.md`、`PERMISSIONS.md`、`VERIFICATION.md`、`package.json`。

## Review Focus

1. **可读性**：Python 报上来的错误是否被翻译成人能看懂的中文（尤其是依赖缺失 / 总线没起）。
2. **安全边界**：`linux_set_value` 是否严格走观察门禁 + 审批；写后观察是否作废；
   写入的文本内容是否参与危险语义识别。
3. **失败边界**：python3 不存在、脚本不存在、脚本超时、返回非法 JSON、`ok:false`——
   每一条都要有明确错误文案，不能静默返回空结果。
4. **不误伤**：AX 总线上没有匹配应用时，`linux_app_state` 返回空列表而不是抛错。
5. **数据最小化**：节点文本默认截断，避免把整屏文本一次性灌进模型上下文。

## Tasks

### Task 1：`lib/atspi.js` 纯逻辑 + 单测

- [ ] 写失败测试 `test/atspi.test.js`：`buildA11yEnv`（带 DISPLAY/XAUTHORITY/DBUS 地址）、
      `buildA11yRequest`、`parseA11yResponse`（合法 / 非法 JSON / ok:false）、
      `trimTree`（深度裁剪）、`collectNodes`（扁平化 + role/name 筛选）、
      `pickEditableNode`（优先可编辑节点）、`nodeBox` / `nodeCenter`、
      `isA11yUnavailable`（识别依赖缺失类错误）
- [ ] 跑测试确认失败（模块不存在）
- [ ] 实现 `lib/atspi.js`
- [ ] 跑测试确认通过
- [ ] commit：`新增 AT-SPI 桥接模块与单元测试`

### Task 2：`lib/atspi.py` 采集脚本

- [ ] 写脚本（ping / tree / setValue 三个 op，异常一律转 JSON 错误）
- [ ] 用临时 python 脚本本地验证脚本能返回正确 JSON（不进单元测试）
- [ ] commit：`新增 AT-SPI 采集脚本`

### Task 3：注册两个工具 + guard 接入

- [ ] 扩展 `test/tools.test.js`：`linux_app_state` / `linux_set_value` 已注册、
      各自具备参数与输出 schema、`linux_set_value` 在 `WRITE_TOOLS` 内
- [ ] 跑测试确认失败
- [ ] `lib/guard.js`：WRITE_TOOLS + 风险信号 + describeAction
- [ ] `lib/tools.js`：实现两个工具
- [ ] 跑测试确认通过
- [ ] commit：`新增无障碍树读取与控件赋值工具`

### Task 4：依赖体检扩展

- [ ] 扩展 `test/diagnostics.test.js`（若无则新建）：`a11y` 段字段与 `available` 判定
- [ ] 跑测试确认失败
- [ ] `lib/diagnostics.js`：新增 a11y 段与 info 级 issue
- [ ] 跑测试确认通过
- [ ] commit：`依赖体检新增 AT-SPI 能力检查`

### Task 5：集成冒烟

- [ ] 扩展 `test/integration.test.js`：真实 AT-SPI 会话下 `linux_app_state` 能列出应用、
      `linux_set_value` 能写入并还原控件内容；条件不满足时自动跳过
- [ ] 在本机跑通
- [ ] commit：`补充 AT-SPI 集成冒烟测试`

### Task 6：文档与版本

- [ ] `README.md`：工具表补 2 行 + 新增「AT-SPI 无障碍能力」小节 + 依赖说明补 python3/at-spi2-core
- [ ] `CHANGELOG.md`：新增 `v1.7.0` 条目
- [ ] `PERMISSIONS.md`：补 python3 子进程、AT-SPI 总线读取路径、失败边界
- [ ] `VERIFICATION.md`：补第 10 节实机验证记录
- [ ] `package.json`：版本 `1.7.0`、`files` 加 `lib/atspi.py`（已被 `lib/` 覆盖则无需改）、
      permissions.commands 补 `python3 <script>`、readPaths 补 a11y 总线 socket
- [ ] commit：`同步文档并将版本升至 1.7.0`
- [ ] 打 tag `v1.7.0` 并提交
