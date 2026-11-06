/**
 * Model-facing tools for controlling the local Linux desktop.
 *
 * Every tool is a plain object shaped like a `ToolDefinition`: raw JSON Schema
 * for `parameters` and `output.schema`, a `render` projection for the
 * model-facing content blocks, and an `execute` implementation.
 */
import {
  activateWindow,
  activeWindow,
  binaryStatus,
  buildEnv,
  captureScreen,
  click,
  displayGeometry,
  drag,
  listWindows,
  moveMouse,
  pointerLocation,
  pressKey,
  scaleImage,
  scroll,
  typeText,
  windowGeometry,
} from './x11.js'
import { resolveSettings } from './settings.js'
import { checkEnvironment } from './diagnostics.js'
import { guardAction, WRITE_TOOLS } from './guard.js'
import {
  getObservation,
  invalidateObservation,
  recordObservation,
  toScreenPoint,
} from './observe.js'

const BUTTONS = { left: 1, middle: 2, right: 3 }

/** Require an integer argument inside an inclusive range. */
function requireInt(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是数字`)
  }
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) {
    throw new Error(`${name} 超出范围（${min}..${max}）`)
  }
  return rounded
}

/** Require a non-empty string argument. */
function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} 必须是非空字符串`)
  }
  return value
}

/** Parse a `x,y,width,height` region string. */
function parseRegion(value) {
  if (typeof value !== 'string') throw new Error('region 必须是 "x,y,width,height" 字符串')
  const parts = value.split(',').map(part => Number(part.trim()))
  if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
    throw new Error('region 必须是 "x,y,width,height" 字符串')
  }
  const [x, y, width, height] = parts
  if (width <= 0 || height <= 0) throw new Error('region 的宽高必须大于 0')
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** 审批与观察门禁统一走 guard.js（见该文件的分级审批说明）。 */

/**
 * 把一组坐标解析成屏幕绝对坐标。
 * - space="screen"（默认）：x/y 就是屏幕绝对像素。
 * - space="local"：x/y 是"最近一次观察截图"里的像素，由插件加上区域原点。
 * @param {object} current 生效配置。
 * @param {string} toolName 工具名（用于报错文案）。
 * @param {number} x X 像素。
 * @param {number} y Y 像素。
 * @param {string} space 坐标空间。
 * @param {object|null} observation 最近一次观察（local 空间必须存在）。
 */
function resolvePoint(toolName, x, y, space, observation) {
  if (space !== 'local') return { x, y }
  if (!observation) {
    throw new Error(`${toolName} 使用 local 坐标，但没有观察记录：请先调用 linux_screenshot。`)
  }
  return toScreenPoint(x, y, observation.origin, observation.scale)
}

/** 读取坐标空间参数，非法值直接报错。 */
function resolveSpace(value, toolName) {
  if (value === undefined || value === null || value === '') return 'screen'
  if (value === 'screen' || value === 'local') return value
  throw new Error(`${toolName} 的 space 只能是 "screen"（屏幕绝对像素）或 "local"（观察截图内像素）`)
}

const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

/** Rebuild the attachment reference an image block carries. */
function imageRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Build every desktop tool.
 * @param ctx - the plugin context, used for the `tools`, `attachments` and `approval` services.
 * @param config - the configuration object handed to `apply(ctx, config)`.
 * @returns the tool definitions to register.
 */
export function createTools(ctx, config = {}) {
  const settings = () => resolveSettings(config)

  return [
    {
      name: 'linux_screenshot',
      description: [
        'Capture the local Linux desktop and return the image itself.',
        'target=screen captures the whole screen; target=active_window captures the focused window;',
        'target=window captures one window by id; target=region captures "x,y,width,height".',
        'Coordinates in later mouse tools refer to the full screen, so prefer target=screen before clicking.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['screen', 'active_window', 'window', 'region'],
            description: '截图目标，默认 screen。',
          },
          window_id: {
            type: 'string',
            description: '窗口 id（十六进制字符串，如 0x01400004），target=window 时必填。',
          },
          region: {
            type: 'string',
            description: '区域 "x,y,width,height"，target=region 时必填。',
          },
          max_width: {
            type: 'integer',
            description: '可选：把截图缩放到该像素宽度（正整数），用于降低视觉上下文开销；省略则保持原分辨率。',
          },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            target: { type: 'string' },
            label: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            bytes: { type: 'integer' },
            captureTool: { type: 'string' },
            origin_x: { type: 'integer' },
            origin_y: { type: 'integer' },
            coordinate_space: { type: 'string' },
            scale: { type: 'number' },
            image: IMAGE_VALUE_SCHEMA,
          },
          required: [
            'target',
            'label',
            'width',
            'height',
            'bytes',
            'captureTool',
            'origin_x',
            'origin_y',
            'coordinate_space',
            'scale',
            'image',
          ],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              '<target>linux-desktop</target>',
              `<scope>${value.target} · ${value.label}</scope>`,
              `<origin>${value.origin_x},${value.origin_y}</origin>`,
              '<coordinate_space>screen</coordinate_space>',
              '<content>',
              `${value.image.mediaType} image, ${value.width}x${value.height} px, ${value.bytes} bytes (captured with ${value.captureTool})`,
              '</content>',
              '<coordinate_mapping>',
              `图中像素 (px,py) 对应屏幕绝对像素 (${value.origin_x}+px*${value.scale}, ${value.origin_y}+py*${value.scale})；`,
              '动作工具的坐标一律是屏幕绝对像素，也可直接传 space="local" 由插件按上图换算。',
              '</coordinate_mapping>',
            ].join('\n'),
          },
          { type: 'image', attachment: imageRef(value.image) },
        ],
      },
      async execute(args) {
        const current = settings()
        const env = buildEnv(current)
        const target = typeof args.target === 'string' ? args.target : 'screen'
        let region
        let label = 'entire screen'
        if (target === 'active_window') {
          const win = await activeWindow(env, { timeoutMs: current.timeoutMs })
          region = { x: win.x, y: win.y, width: win.width, height: win.height }
          label = win.title || win.id
        } else if (target === 'window') {
          const windowId = requireText(args.window_id, 'window_id')
          const geometry = await windowGeometry(env, windowId, { timeoutMs: current.timeoutMs })
          region = geometry
          label = windowId
        } else if (target === 'region') {
          region = parseRegion(args.region)
          label = `${region.x},${region.y} ${region.width}x${region.height}`
        }
        const shot = await captureScreen(env, { region, timeoutMs: current.timeoutMs })
        let data = shot.data
        if (typeof args.max_width === 'number' && args.max_width > 0) {
          data = await scaleImage(env, data, args.max_width, { timeoutMs: current.timeoutMs })
        }
        const attachments = ctx.get('attachments')
        if (!attachments) {
          throw new Error('没有挂载 attachments 服务，无法把截图交给模型')
        }
        const ref = await attachments.saveImage({
          data,
          mediaType: 'image/png',
          name: 'linux-screenshot.png',
        })
        // 记录这次观察：区域原点 + 图上像素→屏幕像素的倍率。
        const origin = { x: region?.x ?? 0, y: region?.y ?? 0 }
        const capturedWidth = region?.width ?? ref.width
        const scale = ref.width > 0 ? capturedWidth / ref.width : 1
        recordObservation({
          target,
          label,
          origin,
          width: ref.width,
          height: ref.height,
          scale,
        })
        return {
          target,
          label,
          width: ref.width,
          height: ref.height,
          bytes: ref.bytes,
          captureTool: shot.tool,
          origin_x: origin.x,
          origin_y: origin.y,
          coordinate_space: 'screen',
          scale: Number(scale.toFixed(4)),
          image: {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            name: ref.name ?? 'linux-screenshot.png',
          },
        }
      },
    },

    {
      name: 'linux_click',
      description:
        'Click a position on the Linux desktop. Coordinates are absolute screen pixels (origin at the top-left of the full screen) unless space="local" is given, in which case they are pixels inside the most recent screenshot. Requires a fresh linux_screenshot first.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'X 坐标（screen=屏幕绝对像素；local=观察截图内像素）。' },
          y: { type: 'integer', description: 'Y 坐标（screen=屏幕绝对像素；local=观察截图内像素）。' },
          space: {
            type: 'string',
            enum: ['screen', 'local'],
            description: '坐标空间，默认 screen（屏幕绝对像素）；local 表示按最近一次截图的像素给坐标。',
          },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: '鼠标键，默认 left。',
          },
          clicks: {
            type: 'integer',
            description: '点击次数（1..3），默认 1；2 表示双击。',
          },
        },
        required: ['x', 'y'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            button: { type: 'string' },
            clicks: { type: 'integer' },
            space: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['x', 'y', 'button', 'clicks', 'space', 'risks'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已在 (${value.x}, ${value.y}) 完成 ${value.button} 键点击（${value.clicks} 次）。`,
          },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        const space = resolveSpace(args.space, 'linux_click')
        const rawX = requireInt(args.x, 'x', -100000, 100000)
        const rawY = requireInt(args.y, 'y', -100000, 100000)
        const button = typeof args.button === 'string' ? args.button : 'left'
        if (!BUTTONS[button]) throw new Error(`未知鼠标键：${button}`)
        const clicks = args.clicks === undefined ? 1 : requireInt(args.clicks, 'clicks', 1, 3)
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_click',
          args: { ...args, x: rawX, y: rawY },
        })
        const { x, y } = resolvePoint('linux_click', rawX, rawY, space, guarded.observation)
        await moveMouse(env, x, y, { timeoutMs: current.timeoutMs })
        await click(env, BUTTONS[button], clicks, { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return {
          x,
          y,
          button,
          clicks,
          space,
          risks: guarded.risks.map(risk => risk.id),
        }
      },
    },

    {
      name: 'linux_move_mouse',
      description:
        'Move the mouse pointer without clicking. Useful for hover menus. Coordinates are absolute screen pixels unless space="local" is given. This tool never changes what is on screen, so it needs no approval.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'X 坐标（screen=屏幕绝对像素；local=观察截图内像素）。' },
          y: { type: 'integer', description: 'Y 坐标（screen=屏幕绝对像素；local=观察截图内像素）。' },
          space: {
            type: 'string',
            enum: ['screen', 'local'],
            description: '坐标空间，默认 screen（屏幕绝对像素）。',
          },
        },
        required: ['x', 'y'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            space: { type: 'string' },
          },
          required: ['x', 'y', 'space'],
        },
        render: (_args, value) => [
          { type: 'text', text: `鼠标已移动到 (${value.x}, ${value.y})。` },
        ],
      },
      async execute(args) {
        const current = settings()
        const env = buildEnv(current)
        const space = resolveSpace(args.space, 'linux_move_mouse')
        const rawX = requireInt(args.x, 'x', -100000, 100000)
        const rawY = requireInt(args.y, 'y', -100000, 100000)
        let observation = getObservation()
        if (space === 'local') {
          observation = await guardAction(ctx, current, null, {
            toolName: 'linux_move_mouse',
            args: { ...args, x: rawX, y: rawY },
            requireObservation: true,
          }).then(guarded => guarded.observation)
        }
        const { x, y } = resolvePoint('linux_move_mouse', rawX, rawY, space, observation)
        await moveMouse(env, x, y, { timeoutMs: current.timeoutMs })
        return { x, y, space }
      },
    },

    {
      name: 'linux_drag',
      description:
        'Drag from one screen position to another (press, move, release). Coordinates are absolute screen pixels unless space="local" is given. Requires a fresh linux_screenshot first.',
      parameters: {
        type: 'object',
        properties: {
          from_x: { type: 'integer', description: '起始 X 坐标（screen=屏幕绝对像素；local=观察截图内像素）。' },
          from_y: { type: 'integer', description: '起始 Y 坐标。' },
          to_x: { type: 'integer', description: '终点 X 坐标。' },
          to_y: { type: 'integer', description: '终点 Y 坐标。' },
          space: {
            type: 'string',
            enum: ['screen', 'local'],
            description: '坐标空间，默认 screen（屏幕绝对像素）。',
          },
          button: {
            type: 'string',
            enum: ['left', 'right', 'middle'],
            description: '鼠标键，默认 left。',
          },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            from_x: { type: 'integer' },
            from_y: { type: 'integer' },
            to_x: { type: 'integer' },
            to_y: { type: 'integer' },
            button: { type: 'string' },
            space: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['from_x', 'from_y', 'to_x', 'to_y', 'button', 'space', 'risks'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已把 ${value.button} 键从 (${value.from_x}, ${value.from_y}) 拖到 (${value.to_x}, ${value.to_y})。`,
          },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        const space = resolveSpace(args.space, 'linux_drag')
        const rawFromX = requireInt(args.from_x, 'from_x', -100000, 100000)
        const rawFromY = requireInt(args.from_y, 'from_y', -100000, 100000)
        const rawToX = requireInt(args.to_x, 'to_x', -100000, 100000)
        const rawToY = requireInt(args.to_y, 'to_y', -100000, 100000)
        const button = typeof args.button === 'string' ? args.button : 'left'
        if (!BUTTONS[button]) throw new Error(`未知鼠标键：${button}`)
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_drag',
          args: { ...args, from_x: rawFromX, from_y: rawFromY, to_x: rawToX, to_y: rawToY },
        })
        const from = resolvePoint('linux_drag', rawFromX, rawFromY, space, guarded.observation)
        const to = resolvePoint('linux_drag', rawToX, rawToY, space, guarded.observation)
        await drag(env, from.x, from.y, to.x, to.y, BUTTONS[button], { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return {
          from_x: from.x,
          from_y: from.y,
          to_x: to.x,
          to_y: to.y,
          button,
          space,
          risks: guarded.risks.map(risk => risk.id),
        }
      },
    },

    {
      name: 'linux_type',
      description:
        'Type literal text into the focused Linux window, as if the user typed it on the keyboard. Requires a fresh linux_screenshot first; text matching destructive semantics (delete/pay/credential) always needs approval.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文本。' },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            typed: { type: 'string' },
            length: { type: 'integer' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['typed', 'length', 'risks'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已输入 ${value.length} 个字符：${value.typed}${
              value.risks.length > 0 ? `（命中敏感语义：${value.risks.join('、')}）` : ''
            }`,
          },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.length === 0) throw new Error('text 不能为空')
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_type',
          args: { ...args, text },
        })
        await typeText(env, text, { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return {
          typed: text,
          length: text.length,
          risks: guarded.risks.map(risk => risk.id),
        }
      },
    },

    {
      name: 'linux_key',
      description:
        'Send a key combination to the focused Linux window, e.g. "ctrl+s", "Return", "alt+Tab", "ctrl+shift+t". Requires a fresh linux_screenshot first.',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'string', description: 'xdotool 键名语法，如 ctrl+s / Return / alt+Tab。' },
        },
        required: ['keys'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            keys: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['keys', 'risks'],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `已发送按键组合：${value.keys}${
              value.risks.length > 0 ? `（命中敏感语义：${value.risks.join('、')}）` : ''
            }`,
          },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        const keys = requireText(args.keys, 'keys')
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_key',
          args: { ...args, keys },
        })
        await pressKey(env, keys, { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return { keys, risks: guarded.risks.map(risk => risk.id) }
      },
    },

    {
      name: 'linux_scroll',
      description:
        'Scroll the mouse wheel over the Linux desktop (or at a given position after moving the pointer there). Requires a fresh linux_screenshot first.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['up', 'down', 'left', 'right'],
            description: '滚动方向。',
          },
          amount: { type: 'integer', description: '滚动格数（1..20），默认 3。' },
          x: { type: 'integer', description: '可选：先移动到该 X 坐标再滚动。' },
          y: { type: 'integer', description: '可选：先移动到该 Y 坐标再滚动。' },
          space: {
            type: 'string',
            enum: ['screen', 'local'],
            description: 'x/y 的坐标空间，默认 screen（屏幕绝对像素）。',
          },
        },
        required: ['direction'],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            direction: { type: 'string' },
            amount: { type: 'integer' },
            space: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['direction', 'amount', 'space', 'risks'],
        },
        render: (_args, value) => [
          { type: 'text', text: `已向 ${value.direction} 滚动 ${value.amount} 格。` },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        const direction = requireText(args.direction, 'direction')
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          throw new Error(`未知滚动方向：${direction}`)
        }
        const amount = args.amount === undefined ? 3 : requireInt(args.amount, 'amount', 1, 20)
        const space = resolveSpace(args.space, 'linux_scroll')
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_scroll',
          args: { ...args, direction, amount },
        })
        if (typeof args.x === 'number' && typeof args.y === 'number') {
          const point = resolvePoint(
            'linux_scroll',
            Math.round(args.x),
            Math.round(args.y),
            space,
            guarded.observation,
          )
          await moveMouse(env, point.x, point.y, { timeoutMs: current.timeoutMs })
        }
        await scroll(env, direction, amount, { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return {
          direction,
          amount,
          space,
          risks: guarded.risks.map(risk => risk.id),
        }
      },
    },

    {
      name: 'linux_windows',
      description: 'List the open Linux windows with their ids, geometry and titles, plus the currently focused window.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            active: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
            windows: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  pid: { type: 'integer' },
                  desktop: { type: 'integer' },
                  x: { type: 'integer' },
                  y: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                  title: { type: 'string' },
                },
                required: ['id', 'title', 'x', 'y', 'width', 'height'],
              },
            },
            count: { type: 'integer' },
          },
          required: ['active', 'windows', 'count'],
        },
        render: (_args, value) => {
          const lines = value.windows.map(window =>
            `- ${window.id} "${window.title}" @ ${window.x},${window.y} ${window.width}x${window.height}`,
          )
          return [
            {
              type: 'text',
              text: [
                `<active>${value.active?.id ?? 'unknown'} "${value.active?.title ?? ''}"</active>`,
                `<count>${value.count}</count>`,
                '<windows>',
                ...lines,
                '</windows>',
              ].join('\n'),
            },
          ]
        },
      },
      async execute() {
        const current = settings()
        const env = buildEnv(current)
        const windows = await listWindows(env, { timeoutMs: current.timeoutMs })
        let active
        try {
          active = await activeWindow(env, { timeoutMs: current.timeoutMs })
        } catch {
          active = { id: '', title: '', x: 0, y: 0, width: 0, height: 0 }
        }
        return { active, windows, count: windows.length }
      },
    },

    {
      name: 'linux_activate_window',
      description:
        'Raise and focus a Linux window, selected by window id (e.g. 0x01400004) or by a case-insensitive title substring. Requires a fresh linux_screenshot first.',
      parameters: {
        type: 'object',
        properties: {
          window_id: { type: 'string', description: '窗口 id（十六进制字符串）。' },
          title_contains: { type: 'string', description: '窗口标题的子串（不区分大小写）。' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            activatedBy: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'title', 'activatedBy', 'risks'],
        },
        render: (_args, value) => [
          { type: 'text', text: `已激活窗口 ${value.id} "${value.title}"（via ${value.activatedBy}）。` },
        ],
      },
      async execute(args, execCtx) {
        const current = settings()
        const env = buildEnv(current)
        let windowId = typeof args.window_id === 'string' ? args.window_id.trim() : ''
        let title = ''
        if (!windowId) {
          const needle = typeof args.title_contains === 'string' ? args.title_contains.trim() : ''
          if (!needle) throw new Error('需要 window_id 或 title_contains 之一')
          const windows = await listWindows(env, { timeoutMs: current.timeoutMs })
          const lower = needle.toLowerCase()
          const matches = windows.filter(window => window.title.toLowerCase().includes(lower))
          if (matches.length === 0) throw new Error(`没有标题包含 "${needle}" 的窗口`)
          const match = matches[0]
          windowId = match.id
          title = match.title
        }
        const windows = await listWindows(env, { timeoutMs: current.timeoutMs })
        const known = windows.find(window => window.id.toLowerCase() === windowId.toLowerCase())
        if (known) title = known.title
        const guarded = await guardAction(ctx, current, execCtx, {
          toolName: 'linux_activate_window',
          args: { ...args, window_id: windowId, title_contains: title },
        })
        const activatedBy = await activateWindow(env, windowId, { timeoutMs: current.timeoutMs })
        invalidateObservation()
        return {
          id: windowId,
          title,
          activatedBy,
          risks: guarded.risks.map(risk => risk.id),
        }
      },
    },

    {
      name: 'linux_desktop_status',
      description: 'Report the state of the Linux desktop session: display, screen size, pointer position, focused window and the installed helper binaries.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            display: { type: 'string' },
            xauthority: { type: 'string' },
            screenWidth: { type: 'integer' },
            screenHeight: { type: 'integer' },
            pointerX: { type: 'integer' },
            pointerY: { type: 'integer' },
            activeWindow: { type: 'string' },
            requireApproval: { type: 'boolean' },
            approvalMode: { type: 'string' },
            ttlMs: { type: 'integer' },
            allowedWindows: { type: 'array', items: { type: 'string' } },
            observationAgeMs: {
              oneOf: [{ type: 'integer' }, { type: 'null' }],
            },
            observationFresh: { type: 'boolean' },
            configPath: { type: 'string' },
            binaries: {
              type: 'object',
              properties: {
                xdotool: { type: 'string' },
                wmctrl: { type: 'string' },
                scrot: { type: 'string' },
                ffmpeg: { type: 'string' },
              },
            },
          },
          required: [
            'display',
            'screenWidth',
            'screenHeight',
            'pointerX',
            'pointerY',
            'activeWindow',
            'requireApproval',
            'approvalMode',
            'ttlMs',
            'allowedWindows',
            'observationFresh',
            'configPath',
            'binaries',
          ],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: [
              `<display>${value.display || '未检测到'}</display>`,
              `<screen>${value.screenWidth}x${value.screenHeight}</screen>`,
              `<pointer>${value.pointerX},${value.pointerY}</pointer>`,
              `<active_window>${value.activeWindow || '无'}</active_window>`,
              `<require_approval>${value.requireApproval}</require_approval>`,
              `<approval_mode>${value.approvalMode}</approval_mode>`,
              `<observation_ttl_ms>${value.ttlMs}</observation_ttl_ms>`,
              `<allowed_windows>${value.allowedWindows.length > 0 ? value.allowedWindows.join(' | ') : '（未限制）'}</allowed_windows>`,
              `<observation>${value.observationFresh ? '新鲜' : '无有效观察（写操作会被拒绝）'}${
                value.observationAgeMs === null ? '' : `，${Math.round(value.observationAgeMs / 1000)} 秒前`
              }</observation>`,
              `<config_path>${value.configPath}</config_path>`,
              `<binaries>xdotool=${value.binaries.xdotool || '缺失'} wmctrl=${value.binaries.wmctrl || '缺失'} scrot=${value.binaries.scrot || '缺失'} ffmpeg=${value.binaries.ffmpeg || '缺失'}</binaries>`,
            ].join('\n'),
          },
        ],
      },
      async execute() {
        const current = settings()
        const env = buildEnv(current)
        const geometry = await displayGeometry(env, { timeoutMs: current.timeoutMs })
        let pointer = { x: 0, y: 0 }
        try {
          pointer = await pointerLocation(env, { timeoutMs: current.timeoutMs })
        } catch {
          // pointer position is optional
        }
        let activeTitle = ''
        try {
          const active = await activeWindow(env, { timeoutMs: current.timeoutMs })
          activeTitle = `${active.id} ${active.title}`.trim()
        } catch {
          // focused window is optional
        }
        const binaries = binaryStatus(env)
        const observation = getObservation()
        const age = observation ? Date.now() - observation.at : null
        return {
          display: current.display,
          xauthority: current.xauthority,
          screenWidth: geometry.width,
          screenHeight: geometry.height,
          pointerX: pointer.x,
          pointerY: pointer.y,
          activeWindow: activeTitle,
          requireApproval: current.requireApproval,
          approvalMode: current.approvalMode,
          ttlMs: current.ttlMs,
          allowedWindows: current.allowedWindows,
          observationAgeMs: age,
          observationFresh: observation ? !observation.stale && age <= current.ttlMs : false,
          configPath: current.configPath,
          binaries: {
            xdotool: binaries.xdotool ?? '',
            wmctrl: binaries.wmctrl ?? '',
            scrot: binaries.scrot ?? '',
            ffmpeg: binaries.ffmpeg ?? '',
          },
        }
      },
    },
    {
      name: 'linux_check_env',
      description: [
        'Check whether this machine can drive the Linux desktop: required and optional helper binaries,',
        'the X11 session (XTEST for input injection, EWMH for window management), DISPLAY/XAUTHORITY,',
        'and the plugin configuration file. Returns every problem found together with a fix hint.',
        'Read-only: it changes nothing.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            checkedAt: { type: 'string' },
            settings: {
              type: 'object',
              properties: {
                display: { type: 'string' },
                xauthority: { type: 'string' },
                approvalMode: { type: 'string' },
                requireApproval: { type: 'boolean' },
                ttlMs: { type: 'integer' },
                allowedWindows: { type: 'array', items: { type: 'string' } },
                timeoutMs: { type: 'integer' },
                configPath: { type: 'string' },
              },
            },
            binaries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  required: { type: 'boolean' },
                  purpose: { type: 'string' },
                  present: { type: 'boolean' },
                  path: { type: 'string' },
                  version: { type: 'string' },
                },
              },
            },
            x11: {
              type: 'object',
              properties: {
                display: { type: 'string' },
                socketPath: { type: 'string' },
                socketExists: { type: 'boolean' },
                xauthority: { type: 'string' },
                xauthorityExists: { type: 'boolean' },
                xtest: { type: 'boolean' },
                ewmh: { type: 'boolean' },
                geometry: { type: 'string' },
              },
            },
            config: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                exists: { type: 'boolean' },
                writable: { type: 'boolean' },
                values: { type: 'object' },
              },
            },
            summary: {
              type: 'object',
              properties: {
                errors: { type: 'integer' },
                warnings: { type: 'integer' },
                binariesPresent: { type: 'integer' },
                binariesTotal: { type: 'integer' },
              },
            },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  level: { type: 'string' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          required: ['ok', 'checkedAt', 'settings', 'binaries', 'x11', 'config', 'summary', 'issues'],
        },
        render: (_args, value) => {
          const lines = [
            `<result>${value.ok ? '依赖齐备' : '存在问题，请按 issues 修复'}</result>`,
            `<display>${value.x11?.display || '未检测到'}</display>`,
            `<xtest>${value.x11?.xtest ? '可用' : '不可用'}</xtest>`,
            `<ewmh>${value.x11?.ewmh ? '可用' : '不可用'}</ewmh>`,
            `<config_path>${value.config?.path || '未设置'}</config_path>`,
            '<binaries>',
            ...(value.binaries ?? []).map(entry =>
              `- ${entry.name}: ${entry.present ? (entry.version || '已安装') : '缺失'}${entry.required ? '（必需）' : '（可选）'} — ${entry.purpose}`,
            ),
            '</binaries>',
          ]
          if ((value.issues ?? []).length > 0) {
            lines.push('<issues>')
            for (const issue of value.issues ?? []) {
              lines.push(`- [${issue.level}] ${issue.message}`)
            }
            lines.push('</issues>')
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute() {
        return checkEnvironment({ config })
      },
    },
  ]
}
