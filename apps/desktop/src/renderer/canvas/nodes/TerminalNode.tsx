import { useCallback, useEffect, useRef } from 'react';
import type { NodeProps } from '@xyflow/react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

import type { FlashworkNode } from '../../state/canvasStore';

export function TerminalNode({ data, selected }: NodeProps<FlashworkNode>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  const fit = useCallback(() => {
    const fitAddon = fitRef.current;
    const term = termRef.current;
    if (!fitAddon || !term) return;
    try {
      fitAddon.fit();
      void window.flashwork?.pty.send({
        type: 'resize',
        sessionId: data.sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    } catch {
      // Ignore fit errors while the node is collapsing/unmounting.
    }
  }, [data.sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    const api = window.flashwork;
    if (!el || !api) return;

    const term = new Terminal({
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#0b1220',
        foreground: '#e2e8f0',
        cursor: '#93c5fd',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL optional — canvas/DOM renderer remains.
    }

    termRef.current = term;
    fitRef.current = fitAddon;

    let disposed = false;

    void (async () => {
      const scrollback = await api.pty.scrollback(data.sessionId);
      if (disposed) return;
      if (scrollback) {
        term.write(scrollback);
      }
      fit();
      term.focus();
    })();

    const unsubscribe = api.pty.onEvent((message) => {
      if (message.sessionId !== data.sessionId) return;
      if (message.type === 'data') {
        term.write(message.data);
      } else if (message.type === 'exit') {
        term.writeln(`\r\n[process exited: ${message.exitCode ?? 'null'}]`);
      }
    });

    const onData = term.onData((chunk) => {
      void api.pty.send({
        type: 'write',
        sessionId: data.sessionId,
        data: chunk,
      });
    });

    const observer = new ResizeObserver(() => {
      fit();
    });
    observer.observe(el);

    return () => {
      disposed = true;
      unsubscribe();
      onData.dispose();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [data.sessionId, fit]);

  return (
    <div className={`terminal-node ${selected ? 'is-selected' : ''}`}>
      <div className="terminal-node__header">
        <strong>{data.label}</strong>
        <span>{data.commandPreset}</span>
      </div>
      <div className="terminal-node__body nowheel nodrag nopan" ref={containerRef} />
    </div>
  );
}
