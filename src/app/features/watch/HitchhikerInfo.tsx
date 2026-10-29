import React, { useState } from 'react';
import { ArchiveInfo } from '../../../../ytjs/src/utils/archive';
import { formatPublished } from '../../utils/published';
import NndTool from './NndTool';

// IE11 (build targets ['web','es5']):
//  - No grid / gap / aspect-ratio / flexbox / -webkit-line-clamp.
//  - Layout via block / inline-block / table only.
//  - 2-line clamp via fixed-height box + gradient overlay (not CSS clamp).
//  - No native <button>/<input>/<select>/<option> in SM's DOM scan path.

// Theme tokens. Two palettes: the default Hitchhiker (light) one, and a
// PipePipe-derived dark one used when the player is showing a Niconico Douga
// video. Markup/layout is identical in both — only these values change.
//
// PipePipe values verified against PipePipeClient/app/src/main/res/values/
// colors.xml: dark_background_color #222222, dark_dialog_background_color
// #424242, dark_settings_accent_color #ff5252, dark_border_color #33FFFFFF,
// dark_card_item_background_color #313131. The cyan/orange/blue secondaries
// (#00FFFF / #FF9900 / #008FD6) are the same family PipePipe carries; they are
// split per element so the strip is not monochrome grey.
interface InfoTheme {
  pageBg: string;    // container background + description fade target
  fadeFrom: string;  // transparent stop matching pageBg (IE11 interpolates)
  text: string;      // title / channel name
  subtle: string;    // secondary text
  tabInactive: string;
  tabAccent: string; // active tab underline
  chanAccent: string;// channel accent bar
  link: string;      // "Show more" / link color
  border: string;
}

// Hitchhiker tokens (mirror SMControls.tsx).
const HK_THEME: InfoTheme = {
  pageBg: '#fff', fadeFrom: 'rgba(255,255,255,0)', text: '#0f0f0f',
  subtle: '#666', tabInactive: '#888',
  tabAccent: '#cc181e', chanAccent: '#cc181e', link: '#167ac6',
  border: '#e2e2e2',
};

// PipePipe dark surfaces. Primary accent #ff5252 stays on the tab underline;
// cyan marks the channel bar and blue carries links.
const NND_THEME: InfoTheme = {
  pageBg: '#222222', fadeFrom: 'rgba(34,34,34,0)', text: '#ffffff',
  subtle: '#aaaaaa', tabInactive: '#777777',
  tabAccent: '#ff5252', chanAccent: '#00ffff', link: '#008fd6',
  border: 'rgba(255,255,255,0.20)',
};

// The player's 16:9 box is width:100% with this same floor (SMPlayer.tsx
// minWidth on the player container). The strip's BACKGROUND must span that full
// width so its edges line up with the player, but the CONTENT stays in the
// original 754px column, centred.
const CONTENT_WIDTH = 754;

// Collapsed description: 2 lines at the line-height below.
const DESC_LINE_HEIGHT = 18; // px
const DESC_COLLAPSED_H = DESC_LINE_HEIGHT * 2; // 36px

type TabKey = 'about' | 'comments' | 'nnd';

export default function HitchhikerInfo({ info, nnd }: { info?: ArchiveInfo; nnd?: boolean }) {
  // NND gets the PipePipe dark palette; everything else keeps Hitchhiker light.
  const t: InfoTheme = nnd ? NND_THEME : HK_THEME;
  // Without archive metadata there is no About content, so open the tab that
  // is still useful (the NND import tool).
  const [tab, setTab] = useState<TabKey>('about');
  const [descExpanded, setDescExpanded] = useState(false);

  const description = (info && info.description) || '';
  // Only offer the toggle when there is more than ~2 lines of text.
  const isLong = description.length > 220;

  // One tab label: an inline-block span with a red underline when active.
  // Three tabs share the strip, so labels are 3 chars and horizontal padding
  // is squeezed; `title` keeps the full name on hover.
  function tabLabel(key: TabKey, label: string, fullName: string) {
    var active = tab === key;
    return (
      <span
        title={fullName}
        onClick={function () {
          setTab(key);
        }}
        style={{
          display: 'inline-block', padding: '0 5px', cursor: 'pointer',
          userSelect: 'none', fontSize: '13px', fontWeight: 'bold',
          lineHeight: '22px', letterSpacing: 0, whiteSpace: 'nowrap',
          color: active ? t.text : t.tabInactive,
          borderBottom: active ? '3px solid ' + t.tabAccent : '3px solid transparent',
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
        // Outer shell: full width (floored at the player's minWidth) so the
        // background and bottom border reach the player's left/right edges.
        // All layout lives in the inner column.
        width: '100%', minWidth: CONTENT_WIDTH, margin: 0,
        fontFamily: 'Arial, sans-serif', color: t.text, background: t.pageBg,
        // Attached to the player: no top gap, no rounded corners, no side borders.
        borderBottom: '1px solid ' + t.border,
        boxSizing: 'border-box',
      }}
    >
      {/* Content column: original fixed width, centred in the wider shell. */}
      <div
        className="hk-video-content"
        style={{ width: CONTENT_WIDTH, maxWidth: '100%', margin: '0 auto' }}
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
            title={info ? info.title : undefined}
            style={{
              fontSize: '17px', fontWeight: 'bold', margin: 0, lineHeight: '1.3',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              userSelect: 'text', // long titles stay selectable
            }}
          >
            {info ? info.title : ''}
          </h1>
        </div>

        <div
          className="hk-tab-strip"
          style={{
            display: 'table-cell', verticalAlign: 'bottom', textAlign: 'right',
            whiteSpace: 'nowrap', width: '150px',
          }}
        >
          {tabLabel('about', 'About', 'About')}
          {tabLabel('comments', 'Comments', 'Comments')}
          {tabLabel('nnd', 'NND', 'Niconico Douga import')}
        </div>
      </div>

      {/* Body */}
      <div className="hk-tab-body" style={{ paddingTop: '8px', paddingBottom: '12px' }}>

        {tab === 'about' ? (
          <div className="hk-tab-about">
            {info ? (
            <div>
            {/* Publish date + artist on ONE line */}
            <div className="hk-video-subline" style={{ fontSize: '12px', color: t.subtle, marginBottom: '8px' }}>
              <span
                style={{ display: 'inline-block', width: '3px', height: '11px', background: t.chanAccent, verticalAlign: 'middle', marginRight: '6px' }}
              />
              <a
                className="hk-channel-link"
                href={info.author_channel_url || '#'}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: t.text, fontWeight: 'bold', textDecoration: 'none', verticalAlign: 'middle' }}
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
                      background: 'linear-gradient(' + t.fadeFrom + ', ' + t.pageBg + ')',
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
                    color: t.link, textTransform: 'uppercase', letterSpacing: '0.5px',
                  }}
                >
                  {descExpanded ? 'Show less' : 'Show more'}
                </span>
              ) : null}
            </div>
            </div>
            ) : (
              <div style={{ fontSize: '13px', color: t.subtle, textAlign: 'center', padding: '12px 0' }}>
                No metadata for this video.
              </div>
            )}
          </div>
        ) : null}

        {tab === 'comments' ? (
          <div className="hk-tab-comments">
            {/* Load triggers on tab click; feature disabled for now. */}
            <div style={{ fontSize: '13px', color: t.subtle, textAlign: 'center', padding: '12px 0' }}>
              {/* TODO: wire to a backend comments route (none exists yet) */}
              Comments are disabled for now.
            </div>
          </div>
        ) : null}

        {/* NND import tool. Same body height as the other tabs; dark theme per
            PipePipe's dark surface palette. */}
        {tab === 'nnd' ? (
          <div className="hk-tab-nnd">
            <NndTool />
          </div>
        ) : null}

      </div>
      </div>
    </div>
  );
}
