#!/usr/bin/env python3
"""atspi.py —— AT-SPI 无障碍树采集脚本（Node 侧 lib/atspi.js 的对端）。

协议：**stdin 收一个 JSON 请求，stdout 回一个 JSON 响应**，不打印任何其他内容到 stdout。

请求：
    {"op": "ping"}
    {"op": "tree", "maxDepth": 8}
    {"op": "setValue", "app": "应用名", "path": "0.1", "value": "文本"}

响应：
    {"ok": true, "apps": [...]}
    {"ok": false, "error": "错误说明"}

节点结构：
    {"role","name","description","states","box","text","editable","actions","path","children"}

设计约束：
- 只做「遍历 + 调接口」，一切判定逻辑（筛选、匹配、裁剪）都在 Node 侧，
  这样才能在没有 X 会话的环境里单元测试；
- 每个节点带一个 `path`（相对应用根的子节点下标路径，如 "0.1"），
  Node 侧据此定位目标控件，Python 侧按路径回走，避免两边各写一套匹配规则；
- 任何异常都转成 {"ok": false, "error": ...}，不让脚本非零退出而丢上下文。
"""

import json
import sys
import warnings

# gi 的弃用告警会打到 stderr，stdout 必须保持纯 JSON。
warnings.filterwarnings("ignore")

# 节点文本最大保留长度：避免把整屏文本一次性灌进模型上下文。
MAX_TEXT_LENGTH = 400

# 单个节点最多保留多少个子节点：防止超大树拖垮采集。
MAX_CHILDREN = 200


def fail(message):
    """输出失败响应并结束。"""
    sys.stdout.write(json.dumps({"ok": False, "error": str(message)}, ensure_ascii=False))
    sys.stdout.flush()
    sys.exit(0)


def load_atspi():
    """载入 Atspi 绑定；失败时给出可操作的中文提示。"""
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        return Atspi
    except Exception as error:  # noqa: BLE001 —— 任何失败都要转成可读提示
        fail(
            "AT-SPI 不可用：%s\n"
            "请先安装：sudo apt-get install -y at-spi2-core libatk-adaptor python3-gi gir1.2-atspi-2.0"
            % error
        )


def read_request():
    """从 stdin 读请求 JSON。"""
    try:
        raw = sys.stdin.read()
    except Exception as error:  # noqa: BLE001
        fail("无法读取请求：%s" % error)
    if not raw.strip():
        fail("请求为空")
    try:
        request = json.loads(raw)
    except Exception as error:  # noqa: BLE001
        fail("请求不是合法 JSON：%s" % error)
    if not isinstance(request, dict):
        fail("请求必须是 JSON 对象")
    return request


def safe_call(func, default=None):
    """调用 AT-SPI 接口；任何异常都退回默认值，不中断整棵树。"""
    try:
        return func()
    except Exception:  # noqa: BLE001
        return default


def node_states(node):
    """读取节点的状态集合，返回状态名列表。"""
    names = []

    def collect():
        state_set = node.get_state_set()
        if state_set is None:
            return
        for state in state_set.get_states():
            nick = getattr(state, "value_nick", None)
            if nick:
                names.append(str(nick))

    safe_call(collect)
    return names


def node_box(node, Atspi):
    """读取节点的屏幕绝对坐标矩形；取不到返回 None。"""
    holder = {}

    def collect():
        component = node.get_component_iface()
        if component is None:
            return
        extents = component.get_extents(Atspi.CoordType.SCREEN)
        if extents is None:
            return
        holder["box"] = {
            "x": int(extents.x),
            "y": int(extents.y),
            "width": int(extents.width),
            "height": int(extents.height),
        }

    safe_call(collect)
    return holder.get("box")


def node_text(node, Atspi):
    """读取节点的文本内容；过长则截断。取不到返回 None。"""
    holder = {}

    def collect():
        interface = node.get_text_iface()
        if interface is None:
            return
        # 注意：Accessible 上有同名的弃用方法会遮蔽接口方法，
        # 因此必须用未绑定形式 Atspi.Text.get_text(interface, 0, -1)。
        value = Atspi.Text.get_text(interface, 0, -1)
        if value is not None:
            holder["text"] = str(value)

    safe_call(collect)
    text = holder.get("text")
    if text is None:
        return None
    if len(text) > MAX_TEXT_LENGTH:
        return text[:MAX_TEXT_LENGTH] + "…"
    return text


def node_actions(node):
    """读取节点支持的动作（click / press / toggle 等）。"""
    actions = []

    def collect():
        interface = node.get_action_iface()
        if interface is None:
            return
        count = interface.get_n_actions()
        for index in range(count):
            name = safe_call(lambda i=index: interface.get_action_name(i), "") or ""
            description = safe_call(lambda i=index: interface.get_action_description(i), "") or ""
            actions.append({"name": str(name), "description": str(description)})

    safe_call(collect)
    return actions


def node_is_editable(node):
    """节点是否实现了 EditableText（即可写值）。"""
    return safe_call(lambda: node.get_editable_text_iface() is not None, False)


def build_node(node, Atspi, path, depth, max_depth):
    """把一个 AT-SPI 节点转成 JSON 友好的字典。"""
    result = {
        "role": str(safe_call(node.get_role_name, "") or ""),
        "name": str(safe_call(node.get_name, "") or ""),
        "description": str(safe_call(node.get_description, "") or ""),
        "states": node_states(node),
        "box": node_box(node, Atspi),
        "text": node_text(node, Atspi),
        "editable": node_is_editable(node),
        "actions": node_actions(node),
        "path": path,
        "children": [],
    }

    if depth >= max_depth:
        return result

    def collect():
        count = node.get_child_count()
        for index in range(min(count, MAX_CHILDREN)):
            child = node.get_child_at_index(index)
            if child is None:
                continue
            child_path = str(index) if path == "" else "%s.%d" % (path, index)
            result["children"].append(build_node(child, Atspi, child_path, depth + 1, max_depth))

    safe_call(collect)
    return result


def list_applications(Atspi):
    """列出无障碍总线上注册的应用（返回 Accessible 列表）。"""
    desktop = safe_call(lambda: Atspi.get_desktop(0))
    if desktop is None:
        return []
    apps = []
    count = safe_call(desktop.get_child_count, 0) or 0
    for index in range(count):
        app = safe_call(lambda i=index: desktop.get_child_at_index(i))
        if app is not None:
            apps.append(app)
    return apps


def handle_ping(Atspi):
    """探活：返回总线上的应用数量与名称。"""
    apps = list_applications(Atspi)
    names = []
    for app in apps:
        name = str(safe_call(app.get_name, "") or "")
        pid = safe_call(app.get_process_id, 0) or 0
        names.append({"name": name, "pid": int(pid)})
    return {"ok": True, "apps": names}


def handle_tree(Atspi, request):
    """采集所有应用的原始节点树。"""
    max_depth = request.get("maxDepth")
    if not isinstance(max_depth, int) or max_depth < 1:
        max_depth = 8
    max_depth = min(max_depth, 20)

    apps = []
    for app in list_applications(Atspi):
        name = str(safe_call(app.get_name, "") or "")
        pid = int(safe_call(app.get_process_id, 0) or 0)
        nodes = build_node(app, Atspi, "", 0, max_depth)
        apps.append({"name": name, "pid": pid, "nodes": nodes})
    return {"ok": True, "apps": apps}


def find_application(Atspi, wanted):
    """按名称找到应用；找不到返回 None。"""
    apps = list_applications(Atspi)
    if not wanted:
        return apps[0] if apps else None
    for app in apps:
        if str(safe_call(app.get_name, "") or "") == wanted:
            return app
    return None


def walk_path(app, path):
    """按 path（相对应用根的子节点下标路径）回走到目标节点。"""
    node = app
    if not path:
        return node
    for part in str(path).split("."):
        try:
            index = int(part)
        except ValueError:
            return None
        child = safe_call(lambda i=index: node.get_child_at_index(i))
        if child is None:
            return None
        node = child
    return node


def handle_set_value(Atspi, request):
    """给目标控件写入文本。"""
    value = request.get("value")
    if not isinstance(value, str):
        return {"ok": False, "error": "value 必须是字符串"}

    app_name = str(request.get("app") or "")
    path = str(request.get("path") or "")

    app = find_application(Atspi, app_name)
    if app is None:
        return {
            "ok": False,
            "error": "找不到应用「%s」：它可能没有注册到无障碍总线（安装依赖后需要重启该应用）。" % app_name,
        }

    node = walk_path(app, path)
    if node is None:
        return {
            "ok": False,
            "error": "控件已失效（路径 %s 不存在）：界面可能已经变化，请重新调用 linux_app_state。" % path,
        }

    editable = safe_call(lambda: node.get_editable_text_iface())
    if editable is None:
        return {
            "ok": False,
            "error": "该控件不可编辑：%s" % (safe_call(node.get_role_name, "") or "未知角色"),
        }

    before = node_text(node, Atspi)
    ok = safe_call(lambda: editable.set_text_contents(value), False)
    after = node_text(node, Atspi)

    return {
        "ok": True,
        "changed": bool(ok),
        "before": before,
        "after": after,
        "role": str(safe_call(node.get_role_name, "") or ""),
        "name": str(safe_call(node.get_name, "") or ""),
    }


def main():
    """入口：读请求 → 分派 → 输出 JSON。"""
    request = read_request()
    Atspi = load_atspi()

    try:
        Atspi.init()
    except Exception as error:  # noqa: BLE001
        fail(
            "无法连接无障碍总线：%s\n"
            "请确认 at-spi-bus-launcher 正在运行（安装 at-spi2-core 后通常由 D-Bus 自动激活）。" % error
        )

    op = str(request.get("op") or "tree")
    if op == "ping":
        result = handle_ping(Atspi)
    elif op == "tree":
        result = handle_tree(Atspi, request)
    elif op == "setValue":
        result = handle_set_value(Atspi, request)
    else:
        result = {"ok": False, "error": "未知操作：%s" % op}

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
