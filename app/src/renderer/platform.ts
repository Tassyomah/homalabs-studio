/** Platform-specific wording for the UI. The behaviour is identical; only names and key labels differ. */
export const isWin = window.narrate.platform === 'win32'
export const keys = isWin
  ? { pause: 'Ctrl+Shift+P', stop: 'Ctrl+Shift+S' }
  : { pause: '⌘⇧P', stop: '⌘⇧S' }
export const revealLabel = isWin ? 'Show in Explorer' : 'Show in Finder'
export const osName = isWin ? 'Windows' : 'macOS'
export const machine = isWin ? 'this PC' : 'this Mac'
