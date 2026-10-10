/**
 * tools/rail.tsx — the generalized canvas tool rail
 * (BOARD-CANVAS-TOOLS-TDD §2.1).
 *
 * Groups: pointer (select/pan), create (sticky/text/frame/connector/
 * link), collaborate (comment/vote), draw. Read mode (<900 px) keeps
 * pointer + collaborate groups — spec §3: select/vote/comment remain
 * available while mutation chrome (create/draw/present) hides
 * entirely rather than showing as misleadingly-active.
 */
import {
  Frame,
  Hand,
  Image as ImageIcon,
  Link as LinkIcon,
  ListTree,
  MessageSquare,
  MousePointer2,
  Network,
  PenLine,
  Play,
  StickyNote,
  ThumbsUp,
  Type,
} from 'lucide-react';
import type { CanvasTool } from '../model';

interface RailTool {
  id: CanvasTool;
  label: string;
  shortcut?: string;
  icon: typeof MousePointer2;
}

const GROUPS: { id: string; tools: RailTool[] }[] = [
  {
    id: 'pointer',
    tools: [
      { id: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
      { id: 'pan', label: 'Pan (or hold Space)', icon: Hand },
    ],
  },
  {
    id: 'create',
    tools: [
      { id: 'sticky', label: 'Sticky note', shortcut: 'N', icon: StickyNote },
      { id: 'text', label: 'Text', shortcut: 'T', icon: Type },
      { id: 'zone', label: 'Frame', shortcut: 'Z', icon: Frame },
      { id: 'connector', label: 'Connector', shortcut: 'C', icon: Network },
      { id: 'link', label: 'Link', shortcut: 'L', icon: LinkIcon },
    ],
  },
  {
    id: 'collab',
    tools: [
      { id: 'comment', label: 'Comment', shortcut: 'K', icon: MessageSquare },
      { id: 'vote', label: 'Vote', shortcut: 'O', icon: ThumbsUp },
    ],
  },
  {
    id: 'draw',
    tools: [{ id: 'draw', label: 'Draw', shortcut: 'D', icon: PenLine }],
  },
];

export function ToolRail({
  tool,
  onTool,
  objectsOpen,
  onToggleObjects,
  readOnly,
  drawEnabled,
  canPresent,
  onPresent,
}: {
  tool: CanvasTool;
  onTool: (t: CanvasTool) => void;
  objectsOpen: boolean;
  onToggleObjects: () => void;
  /** <900 px read mode — create/draw/present hide; select/comment/
   *  vote stay usable (TOOLS-TDD §3 read-adjacent participation). */
  readOnly: boolean;
  /** `ui.canvas_draw` flag — the draw group renders only when set. */
  drawEnabled: boolean;
  canPresent: boolean;
  onPresent: () => void;
}) {
  const groups = GROUPS.filter((g) => {
    if (readOnly) return g.id === 'pointer' || g.id === 'collab';
    if (g.id === 'draw') return drawEnabled;
    return true;
  });
  return (
    <nav className="canvas-tool-rail" aria-label="canvas tools">
      {groups.map((g, gi) => (
        <div className="rail-group" role="group" key={g.id}>
          {gi > 0 && <span className="rail-sep" aria-hidden />}
          {g.tools.map(({ id, label, shortcut, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-label={label}
              aria-pressed={tool === id}
              title={shortcut ? `${label} (${shortcut})` : label}
              className={tool === id ? 'active' : ''}
              onClick={() => onTool(id)}
            >
              <Icon size={19} />
            </button>
          ))}
          {g.id === 'create' && !readOnly && (
            <button
              type="button"
              aria-label="Image upload unavailable"
              title="Image upload isn't available yet"
              disabled
            >
              <ImageIcon size={19} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="rail-group" role="group">
          <span className="rail-sep" aria-hidden />
          <button
            type="button"
            aria-label="Present frames"
            title={
              canPresent
                ? 'Present frames in order'
                : 'No ordered frames — set a presentation order on a frame'
            }
            disabled={!canPresent}
            onClick={onPresent}
          >
            <Play size={19} />
          </button>
        </div>
      )}
      <div className="rail-group" role="group">
        <span className="rail-sep" aria-hidden />
        <button
          type="button"
          aria-label="Board objects list"
          aria-pressed={objectsOpen}
          title="Board objects — browse without spatial navigation"
          className={objectsOpen ? 'active' : ''}
          onClick={onToggleObjects}
        >
          <ListTree size={19} />
        </button>
      </div>
    </nav>
  );
}
