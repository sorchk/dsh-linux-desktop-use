/**
 * Client half of the Linux computer-use plugin.
 *
 * Adds two things to the plugin's own detail page in the DSH Plugins screen:
 *   - a "检查依赖" button (plugins.detail.actions) that asks the Host for a
 *     dependency report, and
 *   - a section (plugins.detail.section) that shows the report and lets the
 *     operator edit the plugin configuration (display, Xauthority, approval
 *     policy, observation TTL, window allowlist, command timeout).
 *
 * The Host side is the same implementation the `linux_check_env` agent tool
 * uses, so the operator and the model read one report.
 *
 * The client half must stay import-free: it is shipped as a single plain
 * script and the runtime hands React in through the module loader.
 */
window.__ModuleLoader__.load({
  id: 'dsh-linux-desktop-use',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-linux-desktop-use'
    const PKG = 'dsh-linux-desktop-use'
    const BASE = '/dsh-linux-desktop-use'

    const DICT = {
      zh: {
        check: '检查依赖',
        checking: '检查中…',
        sectionTitle: '桌面控制依赖体检',
        sectionIntro: '本插件通过 X11 控制本机 Linux 桌面。下面的体检结果由插件宿主实时提供，模型侧的 linux_check_env 工具读到的是同一份数据。',
        binaryTitle: '依赖工具',
        required: '必需',
        optional: '可选',
        present: '已安装',
        missing: '缺失',
        x11Title: 'X11 会话',
        xtest: 'XTEST（输入注入）',
        ewmh: 'EWMH（窗口管理）',
        geometry: '屏幕尺寸',
        socket: 'DISPLAY 套接字',
        cookie: 'Xauthority 凭据',
        configTitle: '配置项',
        display: 'DISPLAY',
        xauthority: 'XAUTHORITY',
        approvalMode: '审批策略',
        ttl: '观察快照有效期 (ms)',
        allowedWindows: '允许的窗口标题',
        timeout: '命令超时 (ms)',
        configPath: '配置文件',
        save: '保存配置',
        saving: '保存中…',
        saved: '已保存',
        failed: '保存失败',
        approvalAll: '全部写操作都需批准',
        approvalDangerous: '仅危险操作需批准',
        approvalOff: '全部放行（不推荐）',
        emptyAllowed: '留空表示不限制',
        ok: '依赖齐备，可以正常控制桌面',
        failedCheck: '检查失败',
        reload: '重新检查',
        issues: '需要处理的问题',
        noIssues: '未发现问题',
      },
      en: {
        check: 'Check dependencies',
        checking: 'Checking…',
        sectionTitle: 'Desktop control dependency check',
        sectionIntro: 'This plugin drives the local Linux desktop through X11. The report below comes from the plugin Host at runtime; the model-facing linux_check_env tool reads the same data.',
        binaryTitle: 'Helper binaries',
        required: 'required',
        optional: 'optional',
        present: 'installed',
        missing: 'missing',
        x11Title: 'X11 session',
        xtest: 'XTEST (input injection)',
        ewmh: 'EWMH (window management)',
        geometry: 'Screen size',
        socket: 'DISPLAY socket',
        cookie: 'Xauthority cookie',
        configTitle: 'Configuration',
        display: 'DISPLAY',
        xauthority: 'XAUTHORITY',
        approvalMode: 'Approval policy',
        ttl: 'Observation TTL (ms)',
        allowedWindows: 'Allowed window titles',
        timeout: 'Command timeout (ms)',
        configPath: 'Settings file',
        save: 'Save configuration',
        saving: 'Saving…',
        saved: 'Saved',
        failed: 'Save failed',
        approvalAll: 'Approve every write',
        approvalDangerous: 'Approve dangerous writes only',
        approvalOff: 'Allow everything (not recommended)',
        emptyAllowed: 'Empty means no restriction',
        ok: 'All dependencies are present; the desktop can be controlled.',
        failedCheck: 'Check failed',
        reload: 'Check again',
        issues: 'Issues to fix',
        noIssues: 'No issues found',
      },
    }

    /** Shared state between the action button and the detail section. */
    const store = {
      report: null,
      checkError: '',
      checking: false,
      draft: null,
      configPath: '',
      saving: false,
      saved: false,
      saveError: '',
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      update(patch) {
        Object.assign(this, patch)
        for (const listener of this.listeners) listener()
      },
    }

    function useStore() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => store.subscribe(() => setTick(tick => tick + 1)), [])
    }

    function isOurPackage(subject) {
      return Boolean(subject) && subject.kind === 'bundle' && subject.pkg && subject.pkg.name === PKG
    }

    async function request(path, options) {
      const response = await fetch(`${BASE}${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status} ${text}`)
      }
      return response.json()
    }

    function draftFrom(values, settings) {
      return {
        display: String(values.display ?? settings.display ?? ''),
        xauthority: String(values.xauthority ?? settings.xauthority ?? ''),
        approvalMode: String(values.approvalMode ?? settings.approvalMode ?? 'all'),
        ttlMs: String(values.ttlMs ?? settings.ttlMs ?? 30000),
        allowedWindows: Array.isArray(values.allowedWindows)
          ? values.allowedWindows.join(', ')
          : String(values.allowedWindows ?? (settings.allowedWindows ?? []).join(', ') ?? ''),
        timeoutMs: String(values.timeoutMs ?? settings.timeoutMs ?? 20000),
      }
    }

    async function loadConfig(t) {
      try {
        const payload = await request('/config')
        store.update({
          draft: draftFrom(payload.values ?? {}, payload.settings ?? {}),
          configPath: payload.path ?? '',
        })
      } catch (error) {
        store.update({ saveError: String(error?.message ?? error) })
      }
    }

    async function runCheck(t) {
      store.update({ checking: true, checkError: '', saved: false })
      try {
        const report = await request('/check')
        store.update({ report, checking: false })
      } catch (error) {
        store.update({ checkError: String(error?.message ?? error), checking: false })
      }
    }

    async function saveConfig(t) {
      const draft = store.draft ?? {}
      const values = {
        display: draft.display ?? '',
        xauthority: draft.xauthority ?? '',
        approvalMode: draft.approvalMode ?? 'all',
        ttlMs: Number(draft.ttlMs),
        timeoutMs: Number(draft.timeoutMs),
        allowedWindows: String(draft.allowedWindows ?? '')
          .split(',')
          .map(entry => entry.trim())
          .filter(entry => entry.length > 0),
      }
      store.update({ saving: true, saveError: '', saved: false })
      try {
        const payload = await request('/config', {
          method: 'POST',
          body: JSON.stringify({ values }),
        })
        store.update({
          draft: draftFrom(payload.values ?? {}, payload.settings ?? {}),
          configPath: payload.path ?? store.configPath,
          saving: false,
          saved: true,
        })
        await runCheck(t)
      } catch (error) {
        store.update({ saving: false, saveError: String(error?.message ?? error) })
      }
    }

    function field(label, control) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '220px' } },
        h('label', { style: { fontSize: '12px', opacity: '0.75' } }, label),
        control,
      )
    }

    function textInput(value, onChange, options = {}) {
      return h('input', {
        type: 'text',
        value,
        onChange: event => onChange(event.target.value),
        style: {
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(128,128,128,0.4)',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          ...(options.style ?? {}),
        },
        ...(options.attrs ?? {}),
      })
    }

    function numberInput(value, onChange) {
      return h('input', {
        type: 'number',
        min: '1',
        value,
        onChange: event => onChange(event.target.value),
        style: {
          padding: '6px 8px',
          borderRadius: '6px',
          border: '1px solid rgba(128,128,128,0.4)',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
        },
      })
    }

    function selectInput(value, options, onChange) {
      return h(
        'select',
        {
          value,
          onChange: event => onChange(event.target.value),
          style: {
            padding: '6px 8px',
            borderRadius: '6px',
            border: '1px solid rgba(128,128,128,0.4)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
          },
        },
        options.map(option =>
          h('option', { key: option.value, value: option.value }, option.label),
        ),
      )
    }

    function button(label, onClick, options = {}) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: options.disabled,
          style: {
            padding: '6px 12px',
            borderRadius: '6px',
            border: '1px solid rgba(128,128,128,0.4)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: options.disabled ? 'default' : 'pointer',
            opacity: options.disabled ? '0.6' : '1',
          },
        },
        label,
      )
    }

    function CheckButton(props) {
      const { subject, t } = props
      useStore()
      if (!isOurPackage(subject)) return null
      return button(store.checking ? t('checking') : t('check'), () => runCheck(t), {
        disabled: store.checking,
      })
    }

    function reportBlock(t) {
      const report = store.report
      if (store.checkError) {
        return h('div', { style: { color: '#e06c75' } }, `${t('failedCheck')}: ${store.checkError}`)
      }
      if (!report) return null
      const binaries = report.binaries ?? []
      const x11 = report.x11 ?? {}
      const issues = report.issues ?? []
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h(
            'span',
            {
              style: {
                padding: '2px 8px',
                borderRadius: '999px',
                border: `1px solid ${report.ok ? 'rgba(80,200,120,0.6)' : 'rgba(224,108,117,0.6)'}`,
              },
            },
            report.ok ? t('ok') : `${report.summary?.errors ?? 0} error(s)`,
          ),
          button(t('reload'), () => runCheck(t), { disabled: store.checking }),
          h('span', { style: { opacity: '0.6', fontSize: '12px' } }, report.checkedAt ?? ''),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('div', { style: { fontWeight: '600' } }, t('binaryTitle')),
          binaries.map(entry =>
            h(
              'div',
              { key: entry.name, style: { display: 'flex', gap: '8px', fontSize: '13px' } },
              h('span', { style: { minWidth: '90px' } }, entry.name),
              h(
                'span',
                {
                  style: {
                    color: entry.present ? '#7ec699' : '#e06c75',
                    minWidth: '70px',
                  },
                },
                entry.present ? t('present') : t('missing'),
              ),
              h('span', { style: { opacity: '0.65' } }, entry.required ? t('required') : t('optional')),
              h('span', { style: { opacity: '0.65' } }, entry.purpose ?? ''),
              h('span', { style: { opacity: '0.45' } }, entry.version ?? ''),
            ),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' } },
          h('div', { style: { fontWeight: '600' } }, t('x11Title')),
          h('div', `${t('xtest')}: ${x11.xtest ? '✓' : '✗'} ${x11.display ?? ''}`),
          h('div', `${t('ewmh')}: ${x11.ewmh ? '✓' : '✗'}`),
          h('div', `${t('geometry')}: ${x11.geometry ?? '-'}`),
          h('div', `${t('socket')}: ${x11.socketPath ?? '-'} ${x11.socketExists ? '✓' : '✗'}`),
          h('div', `${t('cookie')}: ${x11.xauthority ?? '-'} ${x11.xauthorityExists ? '✓' : '✗'}`),
        ),
        issues.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' } },
              h('div', { style: { fontWeight: '600' } }, t('issues')),
              issues.map(issue =>
                h(
                  'div',
                  { key: issue.code, style: { opacity: '0.85' } },
                  `[${issue.level}] ${issue.message}`,
                ),
              ),
            )
          : h('div', { style: { fontSize: '13px', opacity: '0.7' } }, t('noIssues')),
      )
    }

    function configBlock(t) {
      const draft = store.draft
      if (!draft) return null
      const set = key => value => {
        store.update({ draft: { ...draft, [key]: value }, saved: false })
      }
      const approvalOptions = [
        { value: 'all', label: t('approvalAll') },
        { value: 'dangerous', label: t('approvalDangerous') },
        { value: 'off', label: t('approvalOff') },
      ]
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { fontWeight: '600' } }, t('configTitle')),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
          field(t('display'), textInput(draft.display, set('display'))),
          field(t('xauthority'), textInput(draft.xauthority, set('xauthority'))),
          field(t('approvalMode'), selectInput(draft.approvalMode, approvalOptions, set('approvalMode'))),
          field(t('ttl'), numberInput(draft.ttlMs, set('ttlMs'))),
          field(t('timeout'), numberInput(draft.timeoutMs, set('timeoutMs'))),
          field(
            t('allowedWindows'),
            textInput(draft.allowedWindows, set('allowedWindows'), {
              attrs: { placeholder: t('emptyAllowed') },
            }),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          button(store.saving ? t('saving') : t('save'), () => saveConfig(t), { disabled: store.saving }),
          store.saved ? h('span', { style: { color: '#7ec699', fontSize: '12px' } }, t('saved')) : null,
          store.saveError ? h('span', { style: { color: '#e06c75', fontSize: '12px' } }, store.saveError) : null,
        ),
        h(
          'div',
          { style: { fontSize: '12px', opacity: '0.65' } },
          `${t('configPath')}: ${store.configPath || '-'}`,
        ),
      )
    }

    /**
     * The configuration form and the dependency report, contributed to
     * `plugins.bundle.config`.
     *
     * That slot renders between the package description and the package rows,
     * which is where the operator expects a plugin's settings and status to
     * live. The report is rendered inside the same block so the operator sees
     * "what is missing" right above the values they may need to change.
     */
    function ConfigPanel(props) {
      const { view, t } = props
      useStore()
      React.useEffect(() => {
        if (!store.draft) loadConfig(t)
      }, [])
      if (view !== 'page') return null
      return h(
        'section',
        {
          style: {
            padding: '14px',
            borderRadius: '10px',
            border: '1px solid rgba(128,128,128,0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          },
        },
        h('div', { style: { fontWeight: '600' } }, t('sectionTitle')),
        h('div', { style: { fontSize: '12px', opacity: '0.7' } }, t('sectionIntro')),
        reportBlock(t),
        configBlock(t),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register(NS, DICT)
        const t = key => ctx.locale.translate(NS, key)
        ctx.slots.inject('plugins.detail.actions', () =>
          ctx.slots.register(
            { name: 'plugins.detail.actions', id: 'dsh-linux-desktop-use.check', order: 20 },
            props => h(CheckButton, { ...props, t }),
          ),
        )
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: PKG },
            props => h(ConfigPanel, { ...props, t }),
          ),
        )
      },
    }
  },
})
