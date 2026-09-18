import { useEffect, useMemo, useState } from 'react'

import { useT } from '../../lib/i18n'
import { groupServersByName } from '../../lib/mcp'
import { groupSkillsByName } from '../../lib/skills'
import { mcpScan, type SkillAgentSnapshot, skillsScan } from '../../lib/tauri'
import type { McpAgentSnapshot, TaskToolSelection } from '../../lib/types'
import styles from './TaskBoardView.module.css'

type Props = {
  /** Project working directory, used to also scan the project-scoped MCP config. */
  cwd: string | null
  toolSelection: TaskToolSelection
  onChange: (next: TaskToolSelection) => void
}

/**
 * Checkbox pickers for MCP servers and skills, gated behind a "restrict tools" switch.
 * When not restricted, the card inherits the project defaults at spawn time (see
 * `resolveToolSelection` in `lib/taskBoard/attachments.ts`).
 */
export function TaskToolPicker({ cwd, toolSelection, onChange }: Props) {
  const t = useT()
  const [serverSnapshots, setServerSnapshots] = useState<McpAgentSnapshot[] | null>(null)
  const [skillSnapshots, setSkillSnapshots] = useState<SkillAgentSnapshot[] | null>(null)

  useEffect(() => {
    let active = true
    Promise.all([
      mcpScan('global'),
      cwd ? mcpScan('project', cwd) : Promise.resolve<McpAgentSnapshot[]>([]),
    ])
      .then(([global, project]) => {
        if (active) setServerSnapshots([...global, ...project])
      })
      .catch(() => {
        if (active) setServerSnapshots([])
      })
    return () => {
      active = false
    }
  }, [cwd])

  useEffect(() => {
    let active = true
    skillsScan()
      .then((result) => {
        if (active) setSkillSnapshots(result)
      })
      .catch(() => {
        if (active) setSkillSnapshots([])
      })
    return () => {
      active = false
    }
  }, [])

  const serverGroups = useMemo(() => groupServersByName(serverSnapshots ?? []), [serverSnapshots])
  const skillGroups = useMemo(() => groupSkillsByName(skillSnapshots ?? []), [skillSnapshots])

  const restricted = toolSelection.mode === 'restrict'

  const toggleRestrict = () =>
    onChange({ ...toolSelection, mode: restricted ? 'projectDefault' : 'restrict' })

  const toggleServer = (name: string) =>
    onChange({
      ...toolSelection,
      mcpServerIds: toolSelection.mcpServerIds.includes(name)
        ? toolSelection.mcpServerIds.filter((id) => id !== name)
        : [...toolSelection.mcpServerIds, name],
    })

  const toggleSkill = (name: string) =>
    onChange({
      ...toolSelection,
      skillNames: toolSelection.skillNames.includes(name)
        ? toolSelection.skillNames.filter((id) => id !== name)
        : [...toolSelection.skillNames, name],
    })

  return (
    <div className={styles.toolPicker}>
      <label className={styles.toolPickerToggle}>
        <input type="checkbox" checked={restricted} onChange={toggleRestrict} />
        {t('taskBoard.restrictTools')}
      </label>
      {!restricted ? <p className={styles.hint}>{t('taskBoard.toolsDefault')}</p> : null}
      <div className={styles.toolPickerGroups}>
        <div className={styles.toolPickerColumn}>
          <span className={styles.toolPickerLabel}>{t('taskBoard.toolsMcpServers')}</span>
          {serverGroups.length === 0 ? (
            <p className={styles.hint}>{t('taskBoard.toolsEmptyServers')}</p>
          ) : (
            <ul className={styles.toolPickerList}>
              {serverGroups.map((group) => (
                <li key={group.name}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!restricted}
                      checked={toolSelection.mcpServerIds.includes(group.name)}
                      onChange={() => toggleServer(group.name)}
                    />
                    {group.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={styles.toolPickerColumn}>
          <span className={styles.toolPickerLabel}>{t('taskBoard.toolsSkills')}</span>
          {skillGroups.length === 0 ? (
            <p className={styles.hint}>{t('taskBoard.toolsEmptySkills')}</p>
          ) : (
            <ul className={styles.toolPickerList}>
              {skillGroups.map((group) => (
                <li key={group.name}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!restricted}
                      checked={toolSelection.skillNames.includes(group.name)}
                      onChange={() => toggleSkill(group.name)}
                    />
                    {group.name}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
