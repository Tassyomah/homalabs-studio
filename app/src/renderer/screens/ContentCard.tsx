import { useState } from 'react'
import type { Content } from '../content'

/**
 * "CONTENT" (add-on §13): thumbnail candidates and ready-to-paste text, all derived from the recording. Each text
 * block has a Copy button; thumbnails can be opened in the file manager.
 */
export function ContentCard({ content, thumbs, thumbStatus, onMakeThumbs, onReveal, revealLabel, hasTranscript }: {
  content: Content | null; thumbs: { path: string; url: string }[]; thumbStatus: 'idle' | 'running' | string
  onMakeThumbs: () => void; onReveal: (p: string) => void; revealLabel: string; hasTranscript: boolean
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (k: string, text: string) => { navigator.clipboard.writeText(text).then(() => { setCopied(k); setTimeout(() => setCopied(null), 1200) }) }
  return (
    <div className="director content">
      <div className="head">
        <div><b>Content</b> <span className="hint">· thumbnails and copy drawn from this recording</span></div>
        <div className="row"><button onClick={onMakeThumbs} disabled={thumbStatus === 'running'}>{thumbStatus === 'running' ? 'Rendering…' : thumbs.length ? 'Re-render thumbnails' : 'Thumbnail candidates'}</button></div>
      </div>
      {typeof thumbStatus === 'string' && thumbStatus !== 'idle' && thumbStatus !== 'running' && <p className="err">{thumbStatus}</p>}
      {thumbs.length > 0 && (
        <div className="thumbs">
          {thumbs.map((t, i) => (
            <button key={t.path} className="thumb" onClick={() => onReveal(t.path)} title={revealLabel}>
              <img src={t.url} alt={`Thumbnail ${i + 1}`} /><span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      {content ? (
        <div className="copyblocks">
          <Block k="title" label="Title" text={content.title} copied={copied} onCopy={copy} />
          <Block k="description" label="Description" text={content.description} copied={copied} onCopy={copy} />
          <Block k="linkedin" label="LinkedIn post" text={content.linkedin} copied={copied} onCopy={copy} />
        </div>
      ) : (
        <p className="hint">{hasTranscript ? 'Nothing was said in this recording, so there is no text to build from.' : 'Create a transcript to get a title, description and LinkedIn copy built from what was said.'}</p>
      )}
    </div>
  )
}

function Block({ k, label, text, copied, onCopy }: { k: string; label: string; text: string; copied: string | null; onCopy: (k: string, t: string) => void }) {
  return (
    <div className="copyblock">
      <div className="lbl"><span>{label}</span><button onClick={() => onCopy(k, text)}>{copied === k ? 'Copied' : 'Copy'}</button></div>
      <pre>{text}</pre>
    </div>
  )
}
