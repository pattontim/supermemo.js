import React from 'react';

/**
 * SM18-safe controls.
 *
 * SuperMemo's component parser collects INPUT fields positionally and treats
 * ANY OPTION element as an extract, so none of the primitives below may emit
 * <input>, <select>, or <option>. TEXTAREA is safe (already used as #log in
 * the SM-facing markup).
 */

export const SMCheckbox = ({ checked, onChange, label, requiresReload }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  requiresReload?: boolean;
}) => (
  <span
    onClick={() => onChange(!checked)}
    style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center' }}
  >
    <span style={{
      display: 'inline-block', width: '13px', height: '13px',
      border: '1px solid #767676', backgroundColor: checked ? '#0078d7' : '#fff',
      color: '#fff', fontSize: '11px', lineHeight: '13px', textAlign: 'center',
      marginRight: '6px', boxSizing: 'border-box', verticalAlign: 'middle',
    }}>
      {checked ? '✓' : ''}
    </span>
    {label}
    {requiresReload && (
      <span style={{ fontSize: '11px', color: '#a00', marginLeft: '6px' }}>(reload)</span>
    )}
  </span>
);

export const SMRadio = ({ checked, onSelect, label }: {
  checked: boolean;
  onSelect: () => void;
  label: string;
}) => (
  <span
    onClick={onSelect}
    style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center' }}
  >
    <span style={{
      display: 'inline-block', width: '13px', height: '13px',
      border: '1px solid #767676', borderRadius: '50%',
      marginRight: '5px', boxSizing: 'border-box', position: 'relative',
      verticalAlign: 'middle',
    }}>
      {checked && (
        <span style={{
          position: 'absolute', top: '2px', left: '2px',
          width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#0078d7',
        }} />
      )}
    </span>
    {label}
  </span>
);

export const SMButton = ({ onClick, children, style }: {
  onClick: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) => (
  <span
    onClick={onClick}
    style={{
      display: 'inline-block', padding: '0 12px', cursor: 'pointer',
      backgroundColor: '#e1e1e1', border: '1px solid #adadad',
      fontSize: '13px', lineHeight: '22px', userSelect: 'none', ...style,
    }}
  >
    {children}
  </span>
);

/** Single-line text field backed by TEXTAREA (unparsed by SM). */
export const SMTextInput = ({ value, onChange, onEnter, placeholder, style }: {
  value: string;
  onChange: (v: string) => void;
  onEnter?: () => void;
  placeholder?: string;
  style?: React.CSSProperties;
}) => (
  <textarea
    rows={1}
    value={value}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === 'Enter') { e.preventDefault(); onEnter && onEnter(); }
    }}
    style={{
      resize: 'none', overflow: 'hidden', whiteSpace: 'nowrap',
      padding: '8px', boxSizing: 'border-box',
      fontFamily: 'inherit', fontSize: '13px', ...style,
    }}
  />
);
