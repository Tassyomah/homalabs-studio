import { useEffect, useState } from 'react'
import type { Project, RecorderEvent } from '../shared/types'
import { Home } from './screens/Home'
import { Recording } from './screens/Recording'
import { Editor } from './screens/Editor'
import { ControlBar } from './screens/ControlBar'
import { isWin } from './platform'

type Screen = { name: 'home' } | { name: 'recording' } | { name: 'editor'; project: Project }

document.body.classList.add(isWin ? 'win' : 'mac')

export function App() {
  if (window.location.hash === '#bar') return <ControlBar />
  return <MainWindow />
}

function MainWindow() {
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [projects, setProjects] = useState<Project[]>([])
  const [lastEvent, setLastEvent] = useState<RecorderEvent | null>(null)
  const refresh = () => window.narrate.listProjects().then(setProjects)

  useEffect(() => {
    refresh()
    return window.narrate.onRecorderEvent((e) => {
      setLastEvent(e)
      if (e.event === 'started') setScreen({ name: 'recording' })
      if (e.event === 'ready') { refresh(); setScreen({ name: 'editor', project: e.project }) }
      if (e.event === 'error') setScreen({ name: 'home' })
    })
  }, [])

  return (
    <div className="shell">
      <div className="titlebar drag">
        <span className="brand">Narrate</span>
        {screen.name === 'editor' && <span className="crumb">/ {screen.project.name}</span>}
        <span className="spacer" />
        {screen.name === 'editor' && <button className="no-drag" onClick={() => { refresh(); setScreen({ name: 'home' }) }}>All recordings</button>}
      </div>
      <div className="content">
        {screen.name === 'home' && <Home projects={projects} onOpen={(p) => setScreen({ name: 'editor', project: p })} onChanged={refresh}
                                         lastError={lastEvent?.event === 'error' ? lastEvent.message : null} />}
        {screen.name === 'recording' && <Recording lastEvent={lastEvent} />}
        {screen.name === 'editor' && <Editor project={screen.project} />}
      </div>
    </div>
  )
}
