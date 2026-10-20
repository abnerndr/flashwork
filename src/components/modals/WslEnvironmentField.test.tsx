import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { wslStatus } from '../../lib/tauri'
import { WslEnvironmentField } from './WslEnvironmentField'

vi.mock('../../lib/platform', () => ({ isWindows: () => true }))
vi.mock('../../lib/tauri', () => ({ wslStatus: vi.fn() }))
vi.mock('../../lib/i18n', () => ({
  useT: () => (key: string, args?: Record<string, string>) =>
    `${key}${args ? ` ${Object.values(args).join(',')}` : ''}`,
}))

describe('WSL environment status', () => {
  beforeEach(() => vi.resetAllMocks())

  it('shows that WSL is active and switches back to PowerShell', async () => {
    vi.mocked(wslStatus)
      .mockResolvedValueOnce({ distros: ['Ubuntu-24.04'], running: ['Ubuntu-24.04'] })
      .mockResolvedValueOnce({ distros: ['Ubuntu-24.04'], running: [] })
    const onChange = vi.fn()
    render(<WslEnvironmentField value="Ubuntu-24.04" onChange={onChange} />)
    expect(await screen.findByText('wsl.running Ubuntu-24.04')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'wsl.powershell' }))
    expect(onChange).toHaveBeenCalledWith('')
    fireEvent.click(screen.getByRole('button', { name: 'wsl.refresh' }))
    expect(await screen.findByText('wsl.stopped')).toBeInTheDocument()
    expect(wslStatus).toHaveBeenCalledTimes(2)
  })

  it('enables WSL on the running user distribution', async () => {
    vi.mocked(wslStatus).mockResolvedValue({
      distros: ['docker-desktop', 'Ubuntu-24.04', 'Debian'],
      running: ['Ubuntu-24.04'],
    })
    const onChange = vi.fn()
    render(<WslEnvironmentField value="" onChange={onChange} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'wsl.useWsl' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'wsl.useWsl' }))
    expect(onChange).toHaveBeenCalledWith('Ubuntu-24.04')
  })

  it('reports detection failure and lets the user retry', async () => {
    vi.mocked(wslStatus)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ distros: [], running: [] })
    render(<WslEnvironmentField value="" onChange={() => {}} />)
    expect(await screen.findByText('wsl.unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'wsl.useWsl' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'wsl.refresh' }))
    await waitFor(() => expect(screen.getByText('wsl.notInstalled')).toBeInTheDocument())
  })
})
