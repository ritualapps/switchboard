/**
 * Switchboard error boundary.
 *
 * Catches React render errors and renders a readable crash screen instead
 * of leaving the terminal in raw input mode. Press q / Esc / Ctrl+C to
 * exit cleanly.
 *
 * Process-level uncaught exceptions are handled in src/cli.ts.
 */
import React from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { truncate } from './text.js';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    process.stderr.write(
      `\nSWITCHBOARD crash: ${error.message}\n${error.stack ?? ''}\n${
        info.componentStack ?? ''
      }\n`
    );
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <CrashScreen
        error={this.state.error}
        componentStack={this.state.componentStack}
      />
    );
  }
}

function CrashScreen({
  error,
  componentStack,
}: {
  error: Error;
  componentStack: string | null;
}) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c') || key.escape) exit();
  });
  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="red">
      <Text color="red" bold>
        Switchboard crashed
      </Text>
      <Box marginTop={1}>
        <Text>{error.message}</Text>
      </Box>
      {error.stack && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Stack:</Text>
          <Text dimColor>{truncate(error.stack, 1200)}</Text>
        </Box>
      )}
      {componentStack && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Component stack:</Text>
          <Text dimColor>{truncate(componentStack, 800)}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text>Press q, Esc, or Ctrl-C to exit cleanly.</Text>
      </Box>
    </Box>
  );
}
