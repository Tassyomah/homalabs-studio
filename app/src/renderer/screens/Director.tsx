import { useState } from 'react'
import type { Analysis, Proposal, ProposalType } from '../../shared/types'
import { fmt } from './Timeline'

export type DirectorState = { accepted: string[]; rejected: string[]; dismissedAt?: string }
export type DirectorStatus = { kind: 'idle' } | { kind: 'running'; step: string } | { kind: 'error'; message: string } | { kind: 'unavailable'; message: string }

const STEP: Record<string, string> = { audio: 'Listening for pauses…', screen: 'Looking for screen changes…', interaction: 'Reading cursor and clicks…', done: 'Done.' }
const LABEL: Record<ProposalType, (n: number, a: Analysis) => string> = {
  REMOVE: (n, a) => `${n} long pause${n === 1 ? '' : 's'} (${a.summary.removableSeconds.toFixed(1)} s)`,
  ZOOM: (n) => `${n} automatic zoom${n === 1 ? '' : 's'}`,
  CHAPTER: (n) => `${n} chapter boundar${n === 1 ? 'y' : 'ies'}`,
  HIGHLIGHT: (n) => `${n} highlight moment${n === 1 ? '' : 's'}`,
  SPEED: (n) => `${n} stretch${n === 1 ? '' : 'es'} to speed up`,
}
const VERB: Record<ProposalType, string> = { REMOVE: 'Remove', ZOOM: 'Zoom', CHAPTER: 'Chapter at', HIGHLIGHT: 'Highlight', SPEED: 'Speed up' }

/**
 * Smart Director (add-on §7–9): the analysis as a short summary with Apply all / Review / Dismiss, and on Review
 * every proposal with Accept / Reject. Zoom proposals are informational — the automatic zoom already applies them.
 */
export function Director({ analysis, status, state, onAccept, onReject, onAcceptAll, onDismiss, onSeek, onRerun }: {
  analysis: Analysis | null; status: DirectorStatus; state: DirectorState
  onAccept: (p: Proposal) => void; onReject: (p: Proposal) => void; onAcceptAll: (ps: Proposal[]) => void; onDismiss: () => void
  onSeek: (t: number) => void; onRerun: () => void
}) {
  const [review, setReview] = useState(false)
  if (status.kind === 'running') return <div className="director"><div className="spinner small" /><span>{STEP[status.step] ?? 'Analyzing…'} <b>Smart Director</b> is reviewing the recording.</span></div>
  if (status.kind === 'unavailable') return <div className="director muted"><b>Smart Director</b> — {status.message}</div>
  if (status.kind === 'error') return <div className="director muted"><b>Smart Director</b> — {status.message} <button onClick={onRerun}>Try again</button></div>
  if (!analysis) return null

  const pending = analysis.proposals.filter((p) => p.type !== 'ZOOM' && !state.accepted.includes(p.id) && !state.rejected.includes(p.id))
  const counts = (['REMOVE', 'SPEED', 'ZOOM', 'CHAPTER', 'HIGHLIGHT'] as ProposalType[]).map((k) => [k, analysis.summary[k] ?? 0] as const).filter(([, n]) => n > 0)
  if (state.dismissedAt && !review) return (
    <div className="director muted"><b>Smart Director</b> dismissed. <button onClick={() => setReview(true)}>Show suggestions</button> <button onClick={onRerun}>Analyze again</button></div>
  )
  if (counts.length === 0) return <div className="director muted"><b>Smart Director</b> — nothing to tidy: no long pauses, screen changes or busy moments found. <button onClick={onRerun}>Analyze again</button></div>

  return (
    <div className="director">
      <div className="head">
        <div>
          <b>Smart Director</b> — your {fmtShort(analysis.duration)} recording has been analyzed.
          <div className="facts">{counts.map(([k, n]) => <span key={k}><i className={state.accepted.some((id) => id.startsWith(k.toLowerCase())) || k === 'ZOOM' ? 'on' : ''}>✓</i> {LABEL[k](n, analysis)}</span>)}</div>
        </div>
        <div className="row">
          {pending.length > 0 && <button className="primary" onClick={() => onAcceptAll(pending)}>Apply all ({pending.length})</button>}
          <button onClick={() => setReview((r) => !r)}>{review ? 'Hide' : 'Review'}</button>
          {!state.dismissedAt && <button onClick={() => { onDismiss(); setReview(false) }}>Dismiss</button>}
        </div>
      </div>
      {review && (
        <div className="proposals">
          {analysis.proposals.map((p) => {
            const done = p.type === 'ZOOM' ? 'auto' : state.accepted.includes(p.id) ? 'accepted' : state.rejected.includes(p.id) ? 'rejected' : 'pending'
            return (
              <div key={p.id} className={`proposal ${p.type.toLowerCase()} ${done}`}>
                <button className="when" onClick={() => onSeek(p.start)} title="Jump there">{fmt(p.start)}{p.end > p.start + 0.05 ? ` – ${fmt(p.end)}` : ''}</button>
                <span className="what"><b>{VERB[p.type]}{p.type === 'SPEED' && p.rate ? ` ${p.rate}×` : ''}</b> · {p.reason} · <em>{p.confidence} confidence</em></span>
                <span className="act">
                  {done === 'auto' && <span className="tag">applied by auto-zoom</span>}
                  {done === 'accepted' && <span className="tag">accepted</span>}
                  {done === 'rejected' && <span className="tag">rejected</span>}
                  {done === 'pending' && <><button className="primary" onClick={() => onAccept(p)}>Accept</button><button onClick={() => onReject(p)}>Reject</button></>}
                </span>
              </div>
            )
          })}
          <div className="row"><span className="hint">Analyzed {new Date(analysis.analyzedAt).toLocaleString()}.</span><span className="spacer" /><button onClick={onRerun}>Analyze again</button></div>
        </div>
      )}
    </div>
  )
}

const fmtShort = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
