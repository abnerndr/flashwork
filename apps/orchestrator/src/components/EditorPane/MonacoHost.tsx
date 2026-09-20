import 'monaco-editor/min/vs/editor/editor.main.css'

import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { useEffect, useRef } from 'react'

import type { Theme } from '../../lib/types'
import styles from './EditorPane.module.css'
import { monacoThemeFor } from './monacoTheme'

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

export type MonacoHostProps = {
  value: string
  language: string
  path: string
  theme: Theme
  onChange: (value: string) => void
  onSave: () => void
}

export default function MonacoHost({
  value,
  language,
  path,
  theme,
  onChange,
  onSave,
}: MonacoHostProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const skipChangeRef = useRef(false)
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    const editor = monaco.editor.create(host, {
      value,
      language,
      theme: monacoThemeFor(theme),
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      wordWrap: 'on',
      padding: { top: 8 },
    })
    editorRef.current = editor
    const changeSub = editor.onDidChangeModelContent(() => {
      if (skipChangeRef.current) return
      onChangeRef.current(editor.getValue())
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current()
    })
    return () => {
      changeSub.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // Create once; value/language/theme sync through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel()
    if (!model) {
      editor.setValue(value)
      return
    }
    if (model.getValue() !== value) {
      skipChangeRef.current = true
      model.setValue(value)
      skipChangeRef.current = false
    }
    monaco.editor.setModelLanguage(model, language)
  }, [path, value, language])

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(theme))
  }, [theme])

  return <div ref={containerRef} className={styles.monacoHost} data-path={path} />
}
