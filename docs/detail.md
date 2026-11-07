# dsh-linux-desktop-use

用 DeepSeek Harness（DSH）直接操控**本机 Linux 桌面**的插件。适用于**原生 X11 + XTEST 会话**（XFCE / GNOME / KDE 等任意 X11 桌面）；原生 Wayland 会话不适用。

> [!WARNING]
> **风险提示：AI Agent 拥有真实鼠标与键盘控制权**，一次误判就可能误删文件、覆盖文档、泄露凭据或误支付。
> **强烈建议只在沙盒 / 隔离桌面（虚机、Docker + Xvfb、KasmVNC/Xvnc 独立 X 会话）中使用**，
> 并保持 `approvalMode = all`（默认）逐次审批写操作。完整风险清单见
> [README「使用风险与沙盒建议」](https://github.com/sorchk/dsh-linux-desktop-use#️-使用风险与沙盒建议)。

**工具**：19 个 `linux_*` 工具注册进 `ctx.tools`——截图、点击 / 拖拽 / 滚动、键盘输入与组合键、窗口列举与激活、应用枚举 / 启动 / 聚焦、显示器枚举、窗口移动缩放、界面状态断言，以及可选的 AT-SPI 无障碍树读取与控件赋值。逐个工具的输入输出见 [README「工具一览」](https://github.com/sorchk/dsh-linux-desktop-use#工具一览)。写操作前需有一次新鲜的 `linux_screenshot`（TTL 30 秒），写后快照作废。

**依赖**：必需 `xdotool`；建议 `scrot`、`wmctrl`、`ffmpeg`、`xrandr`/`xprop`；可选 `python3-gi` + `gir1.2-atspi-2.0` + `at-spi2-core` + `libatk-adaptor`（无障碍树）、`xdpyinfo`（XTEST 探测）。一键安装：`sudo apt-get install -y xdotool scrot wmctrl ffmpeg`；详情页顶部 **「检查依赖」** 按钮与 `linux_check_env` 工具读同一份报告。

**配置**：下方「桌面控制依赖与配置」面板可编辑 DISPLAY、XAUTHORITY、审批策略、观察快照有效期、允许的窗口标题与命令超时；也可直接编辑 `~/.config/dsh/linux-computer-use.json`。逐项权限来源见 [PERMISSIONS.md](https://github.com/sorchk/dsh-linux-desktop-use/blob/main/PERMISSIONS.md)，实机验证记录见 [VERIFICATION.md](https://github.com/sorchk/dsh-linux-desktop-use/blob/main/VERIFICATION.md)，完整说明（工具输入输出、AT-SPI 细节、安装与发布流程）见 [README](https://github.com/sorchk/dsh-linux-desktop-use)。
