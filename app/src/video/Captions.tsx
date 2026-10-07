import type { CaptionStyle, Transcript, TranscriptSegment } from '../shared/types'

/** The transcript segment spoken at source time t (or the one about to start within 0.2 s). */
export function segmentAt(tr: Transcript, t: number): TranscriptSegment | null {
  for (const s of tr.segments) if (t >= s.start - 0.2 && t <= s.end + 0.3) return s
  return null
}

/**
 * Burned-in captions (spec §45): the current sentence at the bottom of the frame, inside the safe area, with the word
 * being spoken highlighted. Two presets for now: `minimal` (small pill) and `bold` (large, social-style).
 */
export const Captions: React.FC<{ transcript: Transcript; t: number; style: CaptionStyle; FW: number; FH: number; portrait: boolean }> =
  ({ transcript, t, style, FW, FH, portrait }) => {
  if (style === 'off') return null
  const seg = segmentAt(transcript, t)
  if (!seg) return null
  const bold = style === 'bold'
  const fontSize = Math.round(FW * (bold ? (portrait ? 0.065 : 0.034) : (portrait ? 0.048 : 0.024)))
  const bottom = Math.round(FH * (portrait ? 0.16 : 0.07))      // keeps clear of player controls and platform UI
  return (
    <div style={{ position: 'absolute', left: '6%', right: '6%', bottom, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div style={{ background: bold ? 'transparent' : 'rgba(20,20,15,0.82)', color: '#EFEEE8', borderRadius: 14, padding: bold ? 0 : `${Math.round(fontSize * 0.35)}px ${Math.round(fontSize * 0.7)}px`,
                    fontFamily: 'Aeonik, Archivo, Inter, system-ui, sans-serif', fontWeight: bold ? 800 : 600, fontSize, lineHeight: 1.25, textAlign: 'center',
                    textShadow: bold ? '0 3px 14px rgba(0,0,0,0.6), 0 0 2px rgba(0,0,0,0.8)' : undefined, maxWidth: '100%', textWrap: 'balance' as never }}>
        {seg.words.length ? seg.words.map((w, i) => {
          const now = t >= w.start && t < w.end
          return <span key={i} style={{ color: now ? '#F5C36A' : undefined, transition: 'color .05s' }}>{(i ? ' ' : '') + w.word}</span>
        }) : seg.text}
      </div>
    </div>
  )
}
