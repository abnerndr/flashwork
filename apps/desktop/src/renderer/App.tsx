declare global {
  interface Window {
    flashwork?: {
      versions: {
        electron: string;
        chrome: string;
        node: string;
      };
    };
  }
}

export function App() {
  const versions = window.flashwork?.versions;

  return (
    <main className="shell">
      <h1>Flashwork</h1>
      <p>Shell Electron pronto. Canvas e agentes entram na Fase 1.</p>
      {versions ? (
        <p className="meta">
          Electron {versions.electron} · Chromium {versions.chrome} · Node {versions.node}
        </p>
      ) : (
        <p className="meta">Preload ainda não exposto (modo browser).</p>
      )}
    </main>
  );
}
