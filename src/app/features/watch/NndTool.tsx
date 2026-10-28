import React, { useState } from 'react';
import { SMButton, SMTextInput } from '../sm/SMElements';
import { runtime } from '../../utils/runtime-detector';

/**
 * NND (Niconico Douga) import tool.
 *
 * SM only understands YouTube links, so an NND video is presented to SM as a
 * YouTube URL that carries the NND id verbatim (`?v=sm45831835`). NND ids are
 * `sm|nm|so|ca` + digits and can never collide with an 11-char YouTube id, so
 * the player dispatches on the id alone (see isValidSMId + isNndId).
 *
 * Dark theme mirrors PipePipe's dark surface palette:
 *   background #222222 / dialog #424242 / accent #ff5252 / border #33ffffff
 *
 * IE11 rules: no <input>, no <button>, no optional chaining. Controls come from
 * SMElements (span/textarea based) for the same reason.
 */

const BG = '#222222';
const SURFACE = '#313131';
const FIELD = '#424242';
const BORDER = 'rgba(255,255,255,0.20)';
const TEXT = '#ffffff';
const MUTED = '#aaaaaa';
const ACCENT = '#ff5252';

const NND_PREFIXED_ID_RE = /^(sm|nm|so|ca)\d+$/i;

export default function NndTool() {
  const [src, setSrc] = useState('');
  const [out, setOut] = useState('');
  const [err, setErr] = useState('');
  const [veiled, setVeiled] = useState(false);

  /** Accepts a bare NND id, a nicovideo.jp/watch/<id> or a nico.ms/<id> URL. */
  function extractId(input: string): string | null {
    const s = (input || '').replace(/^\s+|\s+$/g, '');
    if (!s) return null;
    const prefixed = s.match(NND_PREFIXED_ID_RE);
    if (prefixed) return prefixed[0].toLowerCase();
    const m = s.match(/(?:nicovideo\.jp\/watch\/|nico\.ms\/)((?:sm|nm|so|ca)\d+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function convert() {
    const id = extractId(src);
    if (!id) {
      setErr('Not a recognized Niconico Douga URL.');
      setOut('');
      return;
    }
    setErr('');
    const ytUrl = 'http://www.youtube.com/watch?v=' + id;
    setOut(ytUrl);
    runtime.copyToClipboard(ytUrl);
    setVeiled(true);
  }

  const fieldStyle: React.CSSProperties = {
    width: '420px', maxWidth: '100%', height: '24px',
    padding: '3px 6px', fontSize: '13px',
    backgroundColor: FIELD, color: TEXT,
    border: '1px solid ' + BORDER, boxSizing: 'border-box',
  };

  return (
    <div
      className="nnd-tool"
      style={{
        position: 'relative',
        backgroundColor: BG,
        color: TEXT,
        padding: '10px 0',
        minHeight: '72px',
        fontFamily: 'Arial, sans-serif',
      }}
    >
      <div style={{ marginBottom: '6px', fontSize: '13px', color: MUTED }}>
        Paste a Niconico Douga URL or id:
      </div>

      <div style={{ marginBottom: '8px' }}>
        <SMTextInput
          value={src}
          onChange={setSrc}
          onEnter={convert}
          placeholder="eg https://www.nicovideo.jp/watch/sm45831835"
          style={{ ...fieldStyle }}
        />
        <SMButton
          onClick={convert}
          style={{
            marginLeft: '6px', height: '24px', lineHeight: '22px',
            backgroundColor: SURFACE, color: TEXT,
            border: '1px solid ' + BORDER, fontSize: '12px', padding: '0 10px',
          }}
        >
          Convert
        </SMButton>
      </div>

      {err ? (
        <div style={{ fontSize: '12px', color: ACCENT, marginBottom: '6px' }}>{err}</div>
      ) : null}

      {out ? (
        <div>
          <div style={{ fontSize: '12px', color: MUTED, marginBottom: '4px' }}>
            YouTube URL for SM (already copied):
          </div>
          <SMTextInput
            value={out}
            onChange={function () { /* read-only */ }}
            style={{ ...fieldStyle, width: '560px' }}
          />
        </div>
      ) : null}

      {/* Veil: conceals the tool after hand-off. Click anywhere to hide.
          Arrow hugs the right edge pointing at the SM element list, which
          sits to the right of the player. */}
      {veiled ? (
        <div
          className="nnd-veil"
          onClick={function () { setVeiled(false); }}
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: 'rgba(34,34,34,0.88)',
            cursor: 'pointer',
            zIndex: 20,
          }}
        >
          <div
            style={{
              position: 'absolute', top: '38%', left: 0, right: 0,
              textAlign: 'center', fontSize: '16px', fontWeight: 'bold', color: TEXT,
            }}
          >
            Copied. Paste it into SM (+N) — click here to dismiss.
          </div>
          <div
            style={{
              position: 'absolute', right: '10px', top: '50%',
              marginTop: '-26px', fontSize: '44px', lineHeight: '44px',
              color: ACCENT,
            }}
          >
            &rarr;
          </div>
        </div>
      ) : null}
    </div>
  );
}
