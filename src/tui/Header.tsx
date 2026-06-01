/**
 * Header -- a slim identity line.
 *
 * Renders product name + version. No zone counters, since zone state is
 * already visible on the board itself. No session-start time. The draft
 * count appears here only when drafts exist.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { VERSION } from '../version.js';

interface Props {
  draftCount: number;
}

export function Header({ draftCount }: Props) {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box>
        <Text bold color="cyan">
          SWITCHBOARD v{VERSION}
        </Text>
      </Box>
      {draftCount > 0 && (
        <Box>
          <Text color="magenta">
            {draftCount} draft{draftCount === 1 ? '' : 's'} pending · h hand-back
          </Text>
        </Box>
      )}
    </Box>
  );
}
