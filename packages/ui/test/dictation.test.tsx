// @vitest-environment jsdom
/**
 * DictationField / useDictation — the Web Speech API mic overlaid on
 * text fields. SpeechRecognition is faked: emit() delivers a results
 * event in the API's cumulative shape (every result since session
 * start, interim flags included).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DictationField } from '../src/dictation';

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() {
    FakeRecognition.instances.push(this);
  }
  emit(transcripts: string[], finals = transcripts.map(() => true)) {
    const results = transcripts.map((t, i) => ({
      0: { transcript: t, confidence: 1 },
      isFinal: finals[i] ?? true,
      length: 1,
    }));
    this.onresult?.({ resultIndex: 0, results });
  }
  fail(error: string) {
    this.onerror?.({ error, message: '' });
  }
}

function installSpeech() {
  FakeRecognition.instances = [];
  Object.defineProperty(window, 'SpeechRecognition', {
    configurable: true,
    writable: true,
    value: FakeRecognition,
  });
  return FakeRecognition;
}

function uninstallSpeech() {
  (window as { SpeechRecognition?: unknown }).SpeechRecognition = undefined;
  (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition =
    undefined;
}

afterEach(() => {
  cleanup();
  uninstallSpeech();
  vi.restoreAllMocks();
});

/** Controlled input fixture — mirrors how every call site uses it. */
function Fixture({
  initial = '',
  onError,
  textarea = false,
}: {
  initial?: string;
  onError?: (m: string) => void;
  textarea?: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <DictationField {...(onError ? { onError } : {})}>
      {textarea ? (
        <textarea
          aria-label="field"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      ) : (
        <input
          aria-label="field"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      )}
    </DictationField>
  );
}

describe('DictationField', () => {
  it('renders no affordance when SpeechRecognition is unavailable', () => {
    render(<Fixture />);
    expect(screen.getByLabelText('field')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dictate/i })).toBeNull();
  });

  it('click starts a recognition session; transcript appends at the caret', () => {
    const Fake = installSpeech();
    render(<Fixture initial="hello" />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    input.setSelectionRange(5, 5);
    const btn = screen.getByRole('button', { name: 'Dictate' });
    fireEvent.click(btn);
    const rec = Fake.instances.at(-1);
    expect(rec?.start).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    rec?.emit([' world']);
    expect(input.value).toBe('hello world');
  });

  it('interim results rewrite in place rather than stacking', () => {
    const Fake = installSpeech();
    render(<Fixture />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    const rec = Fake.instances.at(-1);
    rec?.emit(['draft'], [false]);
    expect(input.value).toBe('draft');
    rec?.emit(['draft sentence'], [true]);
    expect(input.value).toBe('draft sentence');
  });

  it('a selected range is replaced by the transcript', () => {
    const Fake = installSpeech();
    render(<Fixture initial="say hello world" />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    input.setSelectionRange(4, 9); // "hello"
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    Fake.instances.at(-1)?.emit(['hi']);
    expect(input.value).toBe('say hi world');
  });

  it('a second click stops the session', () => {
    const Fake = installSpeech();
    render(<Fixture />);
    const btn = screen.getByRole('button', { name: 'Dictate' });
    fireEvent.click(btn);
    const rec = Fake.instances.at(-1);
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }));
    expect(rec?.stop).toHaveBeenCalled();
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('permission denial surfaces through onError', () => {
    const Fake = installSpeech();
    const onError = vi.fn();
    render(<Fixture onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    Fake.instances.at(-1)?.fail('not-allowed');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('denied'));
  });

  it('Enter in a single-line input ends dictation before submit', () => {
    const Fake = installSpeech();
    const onSubmit = vi.fn();
    render(
      <DictationField>
        <input
          aria-label="field"
          defaultValue=""
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
      </DictationField>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    const rec = Fake.instances.at(-1);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Enter' });
    expect(rec?.stop).toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalled();
  });

  it('works on a textarea child', () => {
    const Fake = installSpeech();
    render(<Fixture textarea />);
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }));
    Fake.instances.at(-1)?.emit(['multi', ' line']);
    expect((screen.getByLabelText('field') as HTMLTextAreaElement).value).toBe(
      'multi line',
    );
  });

  it('forwards injected props (Field id) onto the child', () => {
    installSpeech();
    render(
      <DictationField id="given-id">
        <input aria-label="field" defaultValue="" />
      </DictationField>,
    );
    expect(screen.getByLabelText('field').id).toBe('given-id');
  });

  it('preserves a ref the child already carried', () => {
    installSpeech();
    const outer: React.RefObject<HTMLInputElement> = { current: null };
    render(
      <DictationField>
        <input ref={outer} aria-label="field" defaultValue="" />
      </DictationField>,
    );
    expect(outer.current).toBe(screen.getByLabelText('field'));
  });
});
