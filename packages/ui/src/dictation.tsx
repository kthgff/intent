/**
 * Dictation — speech-to-text for text fields via the browser's Web
 * Speech API (`SpeechRecognition`/`webkitSpeechRecognition`).
 *
 * `DictationField` wraps a single `<input>`/`<textarea>` element and
 * renders a mic button overlaid on its end edge. Dictated text is
 * written straight into the DOM element (`setRangeText` + a dispatched
 * `input` event), which keeps controlled components in sync through
 * their existing `onChange` — call sites don't change their state
 * plumbing, they just wrap the field.
 *
 * Interim results rewrite the dictated span in place, so speech shows
 * live while refining; a user edit inside that span re-anchors the
 * session at the caret instead of clobbering the edit. Only one field
 * dictates at a time — starting a new session stops the previous one.
 * Browsers without the API render no button at all.
 */
import { Mic } from 'lucide-react';
import {
  type CSSProperties,
  type MutableRefObject,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type RefObject,
  cloneElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

type DictationEl = HTMLInputElement | HTMLTextAreaElement;

/** The active recognizer — one dictation session app-wide. */
let activeSession: { stop: () => void } | null = null;

const ERROR_COPY: Record<string, string> = {
  'not-allowed': 'Microphone access was denied — allow it to dictate.',
  'service-not-allowed': 'Microphone access was denied — allow it to dictate.',
  'no-speech': 'No speech detected — try again.',
  'audio-capture': 'No microphone found.',
  network: 'Dictation needs a network connection.',
};

/* `setRangeText` replaces the span without emitting `input` — dispatch
 * it so React's delegated listener fires the field's `onChange` with
 * the new DOM value. Non-text input types (number) reject setRangeText
 * and fall back to a plain value write. */
function writeSpan(el: DictationEl, start: number, end: number, text: string) {
  try {
    el.setRangeText(text, start, end, 'end');
  } catch {
    /* setRangeText rejects non-text input types (number) — splice the
       value manually instead. */
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* type without selectable text — caret position is moot. */
    }
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export interface DictationState {
  /** The Web Speech API exists in this browser. */
  supported: boolean;
  listening: boolean;
  toggle: () => void;
  stop: () => void;
}

export function useDictation(
  target: RefObject<DictationEl | null>,
  opts: { onError?: (msg: string) => void } = {},
): DictationState {
  const onError = useRef(opts.onError);
  onError.current = opts.onError;
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognition | null>(null);
  /** Field span owned by the session: `[start, start + text.length)`
   *  holds what dictation wrote; each result rewrites it. */
  const spanRef = useRef<{ start: number; text: string } | null>(null);
  const supported =
    typeof window !== 'undefined' &&
    (window.SpeechRecognition !== undefined ||
      window.webkitSpeechRecognition !== undefined);

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      stop();
      return;
    }
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    const el = target.current;
    if (!Ctor || !el || el.disabled || el.readOnly) return;
    activeSession?.stop();
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    recRef.current = rec;
    const caret = el.selectionStart ?? el.value.length;
    const span = {
      start: caret,
      /* Seed with the selected text so a selection is replaced by the
       * first transcript rather than appended around it. */
      text: el.value.substring(caret, el.selectionEnd ?? caret),
    };
    spanRef.current = span;
    const session = { stop: () => rec.stop() };
    activeSession = session;
    rec.onresult = (e: SpeechRecognitionEvent) => {
      const field = target.current;
      if (!field || spanRef.current !== span) return;
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i]?.[0]?.transcript ?? '';
      }
      /* The span no longer holds what we wrote — the user edited it
       * (or the field was cleared by a submit). Re-anchor at the
       * caret rather than rewriting their text. */
      if (
        field.value.substring(span.start, span.start + span.text.length) !==
        span.text
      ) {
        span.start = field.selectionStart ?? field.value.length;
        span.text = '';
      }
      field.focus();
      writeSpan(field, span.start, span.start + span.text.length, text);
      span.text = text;
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error === 'aborted') return;
      onError.current?.(
        ERROR_COPY[e.error] ?? `Dictation failed (${e.error}).`,
      );
    };
    rec.onend = () => {
      if (activeSession === session) activeSession = null;
      if (recRef.current === rec) recRef.current = null;
      spanRef.current = null;
      setListening(false);
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      recRef.current = null;
      if (activeSession === session) activeSession = null;
      spanRef.current = null;
    }
  }, [listening, stop, target]);

  /* Session outlives the field — abort silently on unmount. */
  useEffect(
    () => () => {
      const rec = recRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.abort();
      }
    },
    [],
  );

  return { supported, listening, toggle, stop };
}

/**
 * Wrap one `<input>`/`<textarea>` with an overlay mic button. The
 * child's existing `ref`/`onKeyDown` are preserved; extra props (e.g.
 * the `id` injected by `<Field>`) forward onto the child element.
 */
export function DictationField({
  children,
  onError,
  className,
  style,
  ...rest
}: {
  children: ReactElement;
  onError?: (msg: string) => void;
  /** Extra wrapper classes (e.g. `nodrag` inside a canvas node). */
  className?: string;
  /** Wrapper box styles — a field's fixed width/flex moves here. */
  style?: CSSProperties;
} & Record<string, unknown>) {
  const ref = useRef<DictationEl | null>(null);
  const { supported, listening, toggle, stop } = useDictation(ref, {
    ...(onError ? { onError } : {}),
  });
  const childProps = children.props as {
    disabled?: boolean;
    readOnly?: boolean;
    onKeyDown?: (e: ReactKeyboardEvent<DictationEl>) => void;
  };
  /* `ref` isn't in props — it hangs off the element itself. */
  const childRef = (children as unknown as { ref?: Ref<DictationEl> }).ref;
  const mergeRef = (el: DictationEl | null) => {
    ref.current = el;
    if (typeof childRef === 'function') childRef(el);
    else if (childRef) {
      (childRef as MutableRefObject<DictationEl | null>).current = el;
    }
  };

  const disabled = childProps.disabled === true;
  /* Enter in a single-line input is always submit intent — end the
   * session so the last transcript lands before the submit runs.
   * Textareas keep dictating (Enter = newline; the disabled-watcher
   * below catches sends that flip `busy`). */
  const onKeyDown = (e: ReactKeyboardEvent<DictationEl>) => {
    if (e.key === 'Enter' && ref.current instanceof HTMLInputElement) {
      stop();
    }
    childProps.onKeyDown?.(e);
  };

  /* A field that disables or goes read-only mid-session drops the mic
   * output — end the session cleanly. */
  const readOnly = childProps.readOnly === true;
  useEffect(() => {
    if (disabled || readOnly) stop();
  }, [disabled, readOnly, stop]);

  return (
    <span
      className={`dict-field${className ? ` ${className}` : ''}`}
      style={style}
    >
      {cloneElement(children as ReactElement<Record<string, unknown>>, {
        ...rest,
        ref: mergeRef,
        onKeyDown,
      })}
      {supported && !readOnly && (
        <button
          type="button"
          className={`dict-btn${listening ? ' listening' : ''}`}
          aria-label={listening ? 'Stop dictation' : 'Dictate'}
          aria-pressed={listening}
          title={listening ? 'Stop dictation' : 'Dictate'}
          disabled={disabled}
          onClick={toggle}
        >
          <Mic size={14} aria-hidden />
        </button>
      )}
    </span>
  );
}
