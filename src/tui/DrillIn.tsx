/**
 * Drill-in -- the foregrounded body view for the plugged-in line.
 *
 * The cursor lives on the body of the line so the operator reads it
 * end-to-end, navigating with the arrow keys. The cursor also walks across
 * draft annotations as a continuous extension of the body's navigation
 * axis. Annotations are first-class objects the operator may edit
 * (cursor + Enter) or delete (cursor + `x`) before hand-back.
 *
 * Cursor model:
 *   - `body[N]`        -- L1..Llast in the body viewport
 *   - `annotation[i]`  -- the i-th annotation in the focused draft
 *
 * Down-arrow on the last body line jumps to annotation 0 (if any drafts).
 * Up-arrow on annotation 0 returns to the last body line.
 *
 * In content step:
 *   - Enter commits. If editingIndex !== null, the existing annotation at
 *     that index is replaced (anchor preserved). Else a new annotation is
 *     appended.
 *   - Esc / up-arrow returns to navigate, content cleared.
 *   - Left-arrow falls through to TextInput natively so an in-progress
 *     cursor edit is never lost.
 *
 * `q` in navigate step is a third disconnect gesture alongside Esc and
 * left-arrow.
 *
 * The drill-in never flags annotations as stale -- it renders the
 * operator's curated set unconditionally. The system surfaces; the
 * operator judges.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { Line, LineDraft, Annotation } from '../types.js';
import { fitWindow, ANNOTATION_VIEWPORT_CAP } from './layout.js';
import { truncate } from './text.js';
import { nanoid } from 'nanoid';

type Step = 'navigate' | 'content';

type Cursor =
  | { kind: 'body'; line: number }
  | { kind: 'annotation'; index: number };

interface Props {
  line: Line;
  draft: LineDraft | null;
  /** Step state lifted to App so Esc/left-arrow can route correctly
   *  (content -> navigate stays in drill-in; navigate -> disconnect
   *  returns to board). Read-only in DrillIn except for the navigate ->
   *  content transition (`a` / right-arrow / Enter on annotation). */
  step: Step;
  setStep: (s: Step) => void;
  onAddAnnotation: (annotation: Annotation) => void;
  onUpdateAnnotation: (index: number, content: string) => void;
  onDeleteAnnotation: (index: number) => void;
  onDisconnect: () => void;
  /** Maximum body lines the viewport shows before scrolling. App computes
   *  this from terminal height minus the rows it reserves for Header /
   *  Board peripheral / Footer / DrillIn chrome. Defaults to the previous
   *  fixed value of 20 when not provided (test harness). */
  maxBodyViewport?: number;
  /** Total rows the annotation pane may emit (data + scroll indicators),
   *  computed by App from the same layout budget as the body. Defaults to the
   *  cap (5) plus room for both scroll indicators when not provided (test
   *  harness). 0 hides the pane when the terminal is too short to show it
   *  without starving the body. */
  maxAnnotationViewport?: number;
}

export function DrillIn({
  line,
  draft,
  step,
  setStep,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onDisconnect,
  maxBodyViewport = 20,
  maxAnnotationViewport = ANNOTATION_VIEWPORT_CAP + 2,
}: Props) {
  const bundle = line.currentBundle;
  const rawBody = bundle?.body ?? '(no body content -- agent has not posted anything to read)';
  // Strip leading + trailing blank lines so the operator's body viewport
  // shows L1 = the first line with content. Agent-emitted bodies often
  // start with one or more blank lines from prompt formatting; without
  // this trim, the operator sees L1 / L2 blank and content starting at L3.
  const body = rawBody.replace(/^[ \t]*\n+/, '').replace(/\n+[ \t]*$/, '');
  const bodyLines = body.split('\n');
  const annotationCount = draft?.annotations.length ?? 0;

  const [cursor, setCursor] = useState<Cursor>({ kind: 'body', line: 0 });
  const [contentText, setContentText] = useState('');
  /** When non-null, the next commit replaces the annotation at this index
   *  instead of appending a new one. Set on Enter on a focused annotation
   *  during navigate step; cleared on commit / cancel. */
  const editingIndexRef = useRef<number | null>(null);

  // Keep body-line cursor within bounds when body length changes.
  useEffect(() => {
    if (cursor.kind === 'body' && cursor.line >= bodyLines.length) {
      setCursor({ kind: 'body', line: Math.max(0, bodyLines.length - 1) });
    }
  }, [bodyLines.length, cursor]);

  // Keep annotation cursor within bounds when annotations change (e.g.
  // after delete). If no annotations remain, snap back to the last body
  // line. If the cursor is past the new last annotation, clamp.
  useEffect(() => {
    if (cursor.kind === 'annotation') {
      if (annotationCount === 0) {
        setCursor({ kind: 'body', line: Math.max(0, bodyLines.length - 1) });
      } else if (cursor.index >= annotationCount) {
        setCursor({ kind: 'annotation', index: annotationCount - 1 });
      }
    }
  }, [annotationCount, cursor, bodyLines.length]);

  // Clear content surface state whenever App switches us back to navigate
  // (Esc / left-arrow / up-arrow in content step). Keeps the surface close
  // clean.
  useEffect(() => {
    if (step === 'navigate') {
      if (contentText !== '') setContentText('');
      editingIndexRef.current = null;
    }
  }, [step]);

  useInput((input, key) => {
    if (step === 'navigate') {
      // Continuous up/down across body + annotations.
      if (key.upArrow || input === 'k') {
        if (cursor.kind === 'body') {
          if (cursor.line > 0) setCursor({ kind: 'body', line: cursor.line - 1 });
        } else {
          // On an annotation. Index 0 -> last body line; else previous annotation.
          if (cursor.index === 0) {
            setCursor({ kind: 'body', line: Math.max(0, bodyLines.length - 1) });
          } else {
            setCursor({ kind: 'annotation', index: cursor.index - 1 });
          }
        }
        return;
      }
      if (key.downArrow || input === 'j') {
        if (cursor.kind === 'body') {
          if (cursor.line < bodyLines.length - 1) {
            setCursor({ kind: 'body', line: cursor.line + 1 });
          } else if (annotationCount > 0) {
            setCursor({ kind: 'annotation', index: 0 });
          }
        } else {
          if (cursor.index < annotationCount - 1) {
            setCursor({ kind: 'annotation', index: cursor.index + 1 });
          }
        }
        return;
      }
      // Open annotation:
      //   - on body: right-arrow / `a` opens fresh annotation at cursor.
      //   - on annotation: Enter opens content step pre-filled for in-place edit.
      if (cursor.kind === 'body' && (key.rightArrow || input === 'a')) {
        editingIndexRef.current = null;
        setContentText('');
        setStep('content');
        return;
      }
      if (cursor.kind === 'annotation' && key.return && draft) {
        const existing = draft.annotations[cursor.index];
        if (existing) {
          editingIndexRef.current = cursor.index;
          setContentText(existing.content);
          setStep('content');
        }
        return;
      }
      // Delete annotation: cursor + `x` (no confirmation -- one keystroke).
      if (cursor.kind === 'annotation' && input === 'x') {
        onDeleteAnnotation(cursor.index);
        return;
      }
      // `q` -- the drill-in's own disconnect gesture. It lives here rather
      // than in App's input handler because it must stay inert during the
      // content step, where TextInput owns every keystroke. Esc and
      // left-arrow are routed by App.tsx, which owns mode + step + the
      // disconnect history event -- the single canonical disconnect path.
      if (input === 'q') {
        onDisconnect();
        return;
      }
    }
    // Left-arrow during content step: passes through to TextInput for
    // native cursor edit so typed content is never lost.
  });

  function handleContentSubmit(value: string): void {
    const text = value.trim();
    setContentText('');
    if (!text) {
      editingIndexRef.current = null;
      setStep('navigate');
      return;
    }
    if (editingIndexRef.current !== null) {
      onUpdateAnnotation(editingIndexRef.current, text);
      editingIndexRef.current = null;
    } else {
      const bodyLine = cursor.kind === 'body' ? cursor.line + 1 : 1;
      const annotation: Annotation = {
        id: nanoid(10),
        anchor: { kind: 'body_position', line: bodyLine },
        content: text,
      };
      onAddAnnotation(annotation);
    }
    setStep('navigate');
  }

  const annotateAnchorLabel =
    editingIndexRef.current !== null
      ? `edit annotation ${editingIndexRef.current + 1}`
      : `annotate at L${cursor.kind === 'body' ? cursor.line + 1 : 1}`;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="round"
      borderColor="cyan"
      marginX={1}
    >
      <Box flexDirection="column" flexShrink={0}>
        <Text bold color="cyan" wrap="truncate-end">
          {line.title}
        </Text>
        <Text dimColor wrap="truncate-end">
          {line.projectName} · {line.state} · plugged in
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text dimColor>── body (cursor: arrows/j/k; right-arrow/a opens annotation) ──</Text>
        {renderBodyViewport(bodyLines, cursor, step, maxBodyViewport)}
      </Box>

      {step === 'content' && (
        <Box flexDirection="column" marginTop={1} paddingLeft={5}>
          <Text color="magenta">{annotateAnchorLabel}:</Text>
          <Box>
            <Text color="green">{'> '}</Text>
            <TextInput
              value={contentText}
              onChange={setContentText}
              onSubmit={handleContentSubmit}
              placeholder="type, Enter commits; Esc cancels"
              focus
            />
          </Box>
        </Box>
      )}

      {step === 'navigate' && draft && draft.annotations.length > 0 && maxAnnotationViewport > 0 && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text dimColor>── draft ({draft.annotations.length} item{draft.annotations.length === 1 ? '' : 's'}, persists on disconnect) ──</Text>
          {renderAnnotationViewport(draft.annotations, cursor, maxAnnotationViewport)}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {step === 'navigate'
            ? (cursor.kind === 'annotation'
                ? 'Enter edit · x delete · ↑/↓/j/k cursor · D defer · ←/Esc/q disconnect (drafts persist)'
                : '↑/↓/j/k cursor · →/a annotate · D defer · ←/Esc/q disconnect (drafts persist)')
            : '↑/Esc to cancel · ←/→ edit cursor · Enter commits'}
        </Text>
      </Box>
    </Box>
  );
}

function BodyLine({
  n,
  text,
  focused,
  annotationOpenHere,
}: {
  n: number;
  text: string;
  focused: boolean;
  annotationOpenHere: boolean;
}) {
  return (
    <Box flexShrink={0}>
      <Box width={5} flexShrink={0}>
        <Text color={focused ? 'yellow' : undefined} dimColor={!focused}>
          {focused ? '▸' : ' '}L{n}
        </Text>
      </Box>
      <Text inverse={annotationOpenHere}>{text || ' '}</Text>
    </Box>
  );
}

function renderBodyViewport(
  lines: string[],
  cursor: Cursor,
  step: Step,
  viewportRows: number
): React.ReactNode {
  // Body viewport centres on the body cursor when cursor is on body. When
  // cursor is on an annotation, we keep the last body window visible so the
  // operator's context for the annotation (the body it was anchored against)
  // stays on screen.
  const anchor =
    cursor.kind === 'body' ? cursor.line : Math.max(0, lines.length - 1);
  // The window's total emit (data rows + the scroll indicators that actually
  // render) is bounded to `viewportRows` by fitWindow, so the body section
  // never exceeds the row budget App reserved for it. Combined with
  // flexShrink={0} on every row, that means no overflow for Yoga to resolve
  // by collapsing rows. fitWindow reserves indicator rows only when they
  // appear, so a top- or bottom-pinned body reclaims the row a fixed
  // two-row reservation used to waste.
  const { start, end, aboveHidden, belowHidden } = fitWindow(lines.length, anchor, viewportRows);
  const nodes: React.ReactNode[] = [];
  if (aboveHidden > 0) {
    nodes.push(
      <Box key="above" flexShrink={0}>
        <Text dimColor>↑ {aboveHidden} line{aboveHidden === 1 ? '' : 's'} above (j/k to scroll)</Text>
      </Box>
    );
  }
  const bodyCursorLine = cursor.kind === 'body' ? cursor.line : -1;
  for (let i = start; i < end; i++) {
    nodes.push(
      <BodyLine
        key={i}
        n={i + 1}
        text={lines[i] ?? ''}
        focused={step === 'navigate' && i === bodyCursorLine}
        annotationOpenHere={step !== 'navigate' && i === bodyCursorLine}
      />
    );
  }
  if (belowHidden > 0) {
    nodes.push(
      <Box key="below" flexShrink={0}>
        <Text dimColor>↓ {belowHidden} line{belowHidden === 1 ? '' : 's'} below</Text>
      </Box>
    );
  }
  return nodes;
}

/**
 * Annotation pane. The draft renders a scrolling window centred on the
 * focused annotation; an `↑ N above` / `↓ N below` indicator surfaces what is
 * offscreen. The cursor index still walks 0..N-1 logically -- only the
 * DISPLAY is windowed. Windowing goes through the same `fitWindow` helper as
 * the body, so the section's total emit (data + indicators) never exceeds
 * `viewportRows`, the budget App reserved for it. The previous version
 * treated `viewportRows` as a data-row count and let indicators render on
 * top, so a scrolling pane emitted viewportRows + 2 -- overflowing the
 * pinned column and (without flexShrink) collapsing a middle annotation row.
 */
function renderAnnotationViewport(
  annotations: Annotation[],
  cursor: Cursor,
  viewportRows: number
): React.ReactNode {
  const N = annotations.length;
  if (N === 0) return null;
  const anchorIdx =
    cursor.kind === 'annotation' ? cursor.index : N - 1;
  const { start, end, aboveHidden, belowHidden } = fitWindow(
    N,
    anchorIdx,
    viewportRows,
    ANNOTATION_VIEWPORT_CAP
  );
  const nodes: React.ReactNode[] = [];
  if (aboveHidden > 0) {
    nodes.push(
      <Box key="above" flexShrink={0}>
        <Text dimColor>↑ {aboveHidden} above</Text>
      </Box>
    );
  }
  for (let i = start; i < end; i++) {
    const a = annotations[i]!;
    nodes.push(
      <DraftRow
        key={a.id}
        annotation={a}
        index={i}
        focused={cursor.kind === 'annotation' && cursor.index === i}
      />
    );
  }
  if (belowHidden > 0) {
    nodes.push(
      <Box key="below" flexShrink={0}>
        <Text dimColor>↓ {belowHidden} below</Text>
      </Box>
    );
  }
  return nodes;
}

function DraftRow({
  annotation,
  index,
  focused,
}: {
  annotation: Annotation;
  index: number;
  focused: boolean;
}) {
  const a = annotation;
  const where =
    a.anchor.kind === 'body_position'
      ? `L${a.anchor.line}`
      : '--';
  // Ordinal mirrors the "edit annotation N" label so the number is the
  // identity, stable across display and edit. Without the ordinal, two
  // annotations sharing an anchor (both labelled `L21`) are ambiguous to
  // the cursor.
  const ordinal = `${index + 1}.`;
  return (
    <Box flexShrink={0}>
      <Box width={2} flexShrink={0}>
        <Text color="yellow">{focused ? '▸' : ' '}</Text>
      </Box>
      <Box width={4} flexShrink={0}>
        <Text color="yellow" inverse={focused}>{ordinal}</Text>
      </Box>
      <Box width={6} flexShrink={0}>
        <Text color="yellow" inverse={focused}>{where}</Text>
      </Box>
      <Text inverse={focused}>{truncate(a.content, 60)}</Text>
    </Box>
  );
}
