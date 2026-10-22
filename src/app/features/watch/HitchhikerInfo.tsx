import React, { useState } from 'react';
import { ArchiveInfo } from '../../../../ytjs/src/utils/archive';
import { formatPublished } from '../../utils/published';

// IE11 (build targets ['web','es5']):
//  - No grid / gap / aspect-ratio / flexbox / -webkit-line-clamp.
//  - Layout via block / inline-block / table only.
//  - 2-line clamp via fixed-height box + gradient overlay (not CSS clamp).
//  - No native <button>/<input>/<select>/<option> in SM's DOM scan path.

// Hitchhiker accent tokens (mirror SMControls.tsx).
const HK_RED = '#cc181e';   // active-tab underline + channel accent
const HK_BLUE = '#167ac6';  // link / divider labels
const BORDER = '#e2e2e2';
const TEXT = '#0f0f0f';
const TAB_INACTIVE = '#888';
const SUBTLE = '#666';
const PAGE_BG = '#fff';

// Must match the player's minWidth so left edges line up exactly.
const CONTENT_WIDTH = 754;

// Collapsed description: 2 lines at the line-height below.
const DESC_LINE_HEIGHT = 18; // px
const DESC_COLLAPSED_H = DESC_LINE_HEIGHT * 2; // 36px

type TabKey = 'about' | 'comments';

export default function HitchhikerInfo({ info }: { info: ArchiveInfo }) {
  const [tab, setTab] = useState<TabKey>('about');
  const [descExpanded, setDescExpanded] = useState(false);

  const description = info.description || '';
  // Only offer the toggle when there is more than ~2 lines of text.
  const isLong = description.length > 220;

  // One tab label: an inline-block span with a red underline when active.
  function tabLabel(key: TabKey, label: string) {
    var active = tab === key;
    return (
      <span
        onClick={function () {
          setTab(key);
        }}
        style={{
          display: 'inline-block', padding: '0 10px', cursor: 'pointer',
          userSelect: 'none', fontSize: '13px', fontWeight: 'bold',
          lineHeight: '22px',
          color: active ? TEXT : TAB_INACTIVE,
          borderBottom: active ? '3px solid ' + HK_RED : '3px solid transparent',
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <div
      className="hk-video-page"
      style={{
        width: CONTENT_WIDTH, maxWidth: '100%', margin: '0 auto',
        fontFamily: 'Arial, sans-serif', color: TEXT, background: PAGE_BG,
        // Attached to the player: no top gap, no rounded corners, no side borders.
        borderBottom: '1px solid ' + BORDER,
      }}
    >
      {/* Title row — title left (truncated), tabs top-right, same line */}
      <div
        className="hk-title-row"
        style={{ display: 'table', width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}
      >
        <div
          style={{
            display: 'table-cell', verticalAlign: 'bottom',
            paddingTop: '10px', paddingBottom: '6px',
            // flush with the player's left edge (no left padding).
          }}
        >
          <h1
            className="hk-video-title"
            title={info.title}
            style={{
              fontSize: '17px', fontWeight: 'bold', margin: 0, lineHeight: '1.3',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              userSelect: 'text', // long titles stay selectable
            }}
          >
            {info.title}
          </h1>
        </div>

        <div
          className="hk-tab-strip"
          style={{
            display: 'table-cell', verticalAlign: 'bottom', textAlign: 'right',
            whiteSpace: 'nowrap', width: '150px',
          }}
        >
          {tabLabel('about', 'About')}
          {tabLabel('comments', 'Comments')}
        </div>
      </div>

      {/* Body */}
      <div className="hk-tab-body" style={{ paddingTop: '8px', paddingBottom: '12px' }}>

        {tab === 'about' ? (
          <div className="hk-tab-about">
            {/* Publish date + artist on ONE line */}
            <div className="hk-video-subline" style={{ fontSize: '12px', color: SUBTLE, marginBottom: '8px' }}>
              <span
                style={{ display: 'inline-block', width: '3px', height: '11px', background: HK_RED, verticalAlign: 'middle', marginRight: '6px' }}
              />
              <a
                className="hk-channel-link"
                href={info.author_channel_url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: TEXT, fontWeight: 'bold', textDecoration: 'none', verticalAlign: 'middle' }}
              >
                {info.author_name}
              </a>
              {(() => {
                // Prefer an absolute date; fall back to relative; show nothing if neither exists.
                // formatPublished strips the "Premiered "/"Published " prefix stored by
                // older archives so we never render "Published Premiered Jan 7, 2022".
                var dateText = formatPublished(info.relative_date, info.published);
                return dateText
                  ? <span style={{ verticalAlign: 'middle' }}>{'  ·  ' + dateText}</span>
                  : null;
              })()}
            </div>

            {/* Description — 2-line clamp with gradient fade into Show more */}
            <div className="hk-description" style={{ fontSize: '13px' }}>
              <div
                className="hk-description-text"
                style={{
                  position: 'relative',
                  lineHeight: DESC_LINE_HEIGHT + 'px',
                  height: descExpanded ? 'auto' : DESC_COLLAPSED_H + 'px',
                  overflow: 'hidden',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {description}
                {!descExpanded ? (
                  // Gradient fade over the last line (IE10+ supports linear-gradient).
                  <span
                    style={{
                      position: 'absolute', left: 0, right: 0, bottom: 0,
                      height: DESC_LINE_HEIGHT + 'px',
                      background: 'linear-gradient(rgba(255,255,255,0), ' + PAGE_BG + ')',
                    }}
                  />
                ) : null}
              </div>

              {/* Clickable Show more / Show less (span, not a button) */}
              {isLong ? (
                <span
                  onClick={function () { setDescExpanded(!descExpanded); }}
                  style={{
                    display: 'inline-block', marginTop: '4px', cursor: 'pointer',
                    userSelect: 'none', fontSize: '12px', fontWeight: 'bold',
                    color: HK_BLUE, textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}
                >
                  {descExpanded ? 'Show less' : 'Show more'}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {tab === 'comments' ? (
          <div className="hk-tab-comments">
            {/* Load triggers on tab click; feature disabled for now. */}
            <div style={{ fontSize: '13px', color: SUBTLE, textAlign: 'center', padding: '12px 0' }}>
              {/* TODO: wire to a backend comments route (none exists yet) */}
              Comments are disabled for now.
            </div>
          </div>
        ) : null}

      </div>
    </div>
  );
}
