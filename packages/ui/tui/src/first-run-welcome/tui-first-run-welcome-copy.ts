/**
 * Centrally owned version and all-locale Chinese copy for the shipped TUI first-run notice.
 *
 * A material wording change increments {@link TUI_FIRST_RUN_WELCOME_NOTICE_VERSION}
 * so every Harness home presents the revised notice once.
 * @module @deepseek-ai/dsh/tui-onboarding/tui-first-run-welcome-copy
 */

/** Copy version persisted after the user explicitly continues. */
export const TUI_FIRST_RUN_WELCOME_NOTICE_VERSION = 4

/** Locale-shaped text rendered by the first-run welcome overlay. */
export interface TuiFirstRunWelcomeNoticeCopy {
  /** Overlay heading. */
  readonly title: string
  /** Ordered prose paragraphs. */
  readonly paragraphs: readonly string[]
  /** Enter action label. */
  readonly continueLabel: string
  /** Hint shown when the prose is scrollable. */
  readonly scrollHint: string
  /** Status shown while the acknowledgement reaches disk. */
  readonly saving: string
  /** Retry message shown when the acknowledgement cannot be persisted. */
  readonly saveError: string
}

/** Complete Chinese notice used for every locale. */
const TUI_FIRST_RUN_WELCOME_CHINESE_COPY = Object.freeze<TuiFirstRunWelcomeNoticeCopy>({
  title: 'DeepSeek Harness',
  paragraphs: Object.freeze([
    '感谢您愿意拨冗试用 DeepSeek Harness。当前版本仍处于内部测试阶段，功能仍待完善，体验难免有些粗糙。',
    '“如切如磋，如琢如磨。” 产品的成长，离不开一次次真实的碰撞与坦诚的反馈。您在真实使用中发现的问题，也可能促使我们重新审视，甚至推翻已有的设计。',
    '为了帮助我们更准确地还原您真实使用中的问题，内测版本默认会上传所有 Session Log；如需关闭，请设置环境变量 DSH_TELEMETRY_DISABLED=1。另外，如果您有任何反馈与建议，请在企业微信群中留言告诉我们。每一条反馈，都会帮助我们把它打磨得更好。',
  ]),
  continueLabel: '继续',
  scrollHint: '↑/↓ 滚动',
  saving: '正在保存确认…',
  saveError: '无法保存确认，请按 Enter 重试。',
})

/** Locale map whose entries deliberately share the single Chinese owner copy. */
export const TUI_FIRST_RUN_WELCOME_NOTICE_COPY = Object.freeze({
  'zh-CN': TUI_FIRST_RUN_WELCOME_CHINESE_COPY,
  en: TUI_FIRST_RUN_WELCOME_CHINESE_COPY,
})

/** Locale presented by the shipped first-run notice. */
export const TUI_FIRST_RUN_WELCOME_NOTICE_LOCALE = 'zh-CN' as const
