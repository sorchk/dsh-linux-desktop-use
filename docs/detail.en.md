# dsh-linux-desktop-use

A plugin that lets DeepSeek Harness (DSH) drive the **local Linux desktop**. Works on **native X11 sessions with
XTEST** (XFCE / GNOME / KDE and any other X11 desktop); native Wayland sessions are not supported.

> [!WARNING]
> **Risk:** an AI agent holds real mouse and keyboard control — one misjudgement can delete files, overwrite
> documents, leak credentials or trigger payments. **Run it only inside a sandbox / isolated desktop**
> (virtual machine, Docker + Xvfb, a separate KasmVNC/Xvnc X session) and keep `approvalMode = all`
> (the default) so every write is approved one by one. The full risk table is in the
> [README](https://github.com/sorchk/dsh-linux-desktop-use#️-usage-risks-and-sandbox-recommendations).

**Tools**: 19 `linux_*` tools registered with `ctx.tools` — screenshots, clicks / drags / scrolling, keyboard input
and key combinations, window listing and activation, application listing / launching / focusing, display
enumeration, window move and resize, UI state assertions, plus optional AT-SPI accessibility-tree reading and
control-value writing. See the [README tool table](https://github.com/sorchk/dsh-linux-desktop-use#tools) for each
tool's inputs and outputs. Every write needs a fresh `linux_screenshot` (30 s TTL by default); the snapshot is void
after a write.

**Dependencies**: required `xdotool`; recommended `scrot`, `wmctrl`, `ffmpeg`, `xrandr`/`xprop`; optional
`python3-gi` + `gir1.2-atspi-2.0` + `at-spi2-core` + `libatk-adaptor` (accessibility tree) and `xdpyinfo`.
One-liner: `sudo apt-get install -y xdotool scrot wmctrl ffmpeg`. The **Check dependencies** button at the top of
this page and the `linux_check_env` tool read the same report.

**Configuration**: the panel below edits DISPLAY, XAUTHORITY, approval policy, snapshot TTL, allowed window titles
and command timeout; you can also edit `~/.config/dsh/linux-computer-use.json` directly. See
[PERMISSIONS.md](https://github.com/sorchk/dsh-linux-desktop-use/blob/main/PERMISSIONS.md),
[VERIFICATION.md](https://github.com/sorchk/dsh-linux-desktop-use/blob/main/VERIFICATION.md) and the
[README](https://github.com/sorchk/dsh-linux-desktop-use) for the full documentation.
