import React, { useState } from 'react';
import { SMButton } from '../sm/SMControls';

// TODO: pick from archive.ts
type ArchiveInfoData = {
  version: number;
  title: string;
  published: string;
  relative_date: string;
  author_name: string;
  description: string;
  archived_on: string;
  file_formats: { [filename: string]: any };
};

interface ArchiveItemProps {
  v_id: string;
  info: ArchiveInfoData;
}

function ArchiveItem({ v_id, info }: ArchiveItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const truncateDescription = (desc: string, length: number = 100) => {
    if (!desc) return '';
    return desc.length > length ? desc.substring(0, length) + '...' : desc;
  };

  const formatDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleDateString();
    } catch {
      return dateString;
    }
  };

  const fileCount = Object.keys(info.file_formats || {}).length;

  return (
    <div
      style={{
        border: '1px solid #ddd',
        marginBottom: '10px',
        borderRadius: '4px',
        overflow: 'hidden',
      }}
    >
      {/* Header - Click to expand */}
      <div
        onClick={() => setIsExpanded(!isExpanded)}
        style={{
          padding: '12px',
          backgroundColor: '#f9f9f9',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: isExpanded ? '1px solid #ddd' : 'none',
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 'bold', marginBottom: '5px', fontSize: '14px' }}>
            {info.title || 'Untitled'}
          </div>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '3px' }}>
            <span style={{ marginRight: '15px' }}>📺 {info.author_name || 'Unknown'}</span>
            <span style={{ marginRight: '15px' }}>📅 {info.relative_date || formatDate(info.archived_on)}</span>
            <span>📁 {fileCount} file(s)</span>
          </div>
          <div style={{ fontSize: '12px', color: '#999', marginTop: '5px' }}>
            {truncateDescription(info.description)}
          </div>
        </div>
        <div style={{ marginLeft: '15px', fontSize: '18px', color: '#666' }}>
          {isExpanded ? '−' : '+'}
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && (
        <div style={{ padding: '12px', backgroundColor: '#ffffff', borderTop: '1px solid #ddd' }}>
          {/* Metadata */}
          <div style={{ marginBottom: '15px', paddingBottom: '12px', borderBottom: '1px solid #eee' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '12px', color: '#555' }}>
              METADATA
            </div>
            <div style={{ fontSize: '13px', lineHeight: '1.6' }}>
              <div style={{ marginBottom: '5px' }}>
                <span style={{ color: '#666', fontWeight: '500' }}>Title:</span> {info.title || 'N/A'}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <span style={{ color: '#666', fontWeight: '500' }}>Author:</span> {info.author_name || 'Unknown'}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <span style={{ color: '#666', fontWeight: '500' }}>Published:</span> {info.published || 'N/A'}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <span style={{ color: '#666', fontWeight: '500' }}>Relative Date:</span> {info.relative_date || 'N/A'}
              </div>
              <div style={{ marginBottom: '5px' }}>
                <span style={{ color: '#666', fontWeight: '500' }}>Archived On:</span>{' '}
                {formatDate(info.archived_on)}
              </div>
            </div>
          </div>

          {/* Description */}
          <div style={{ marginBottom: '15px', paddingBottom: '12px', borderBottom: '1px solid #eee' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '12px', color: '#555' }}>
              DESCRIPTION
            </div>
            <div
              style={{
                fontSize: '13px',
                color: '#333',
                lineHeight: '1.5',
                maxHeight: '150px',
                overflowY: 'auto',
              }}
            >
              {info.description || 'No description'}
            </div>
          </div>

          {/* Files */}
          <div style={{ marginBottom: '15px', paddingBottom: '12px', borderBottom: '1px solid #eee' }}>
            <div style={{ fontWeight: 'bold', marginBottom: '8px', fontSize: '12px', color: '#555' }}>
              FILES ({fileCount})
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>
              {fileCount > 0 ? (
                <ul style={{ margin: '0', paddingLeft: '20px' }}>
                  {Object.keys(info.file_formats || {}).map((filename) => (
                    <li key={filename} style={{ marginBottom: '3px' }}>
                      {filename}
                    </li>
                  ))}
                </ul>
              ) : (
                'No files'
              )}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '8px' }}>
            <a
              href={`/archive/${v_id}/info.json`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                padding: '6px 12px',
                backgroundColor: '#f0f0f0',
                border: '1px solid #ddd',
                borderRadius: '3px',
                fontSize: '12px',
                cursor: 'pointer',
                textDecoration: 'none',
                color: '#333',
              }}
            >
              📋 Copy Link
            </a>
            <SMButton
              onClick={() => {
                const url = `/archive/${v_id}/info.json`;
                fetch(url, { method: 'GET' })
                  .then(() => {
                    // This would be implemented by the user in their backend
                    console.log('Would open:', url);
                  })
                  .catch((err) => console.error('Error:', err));
              }}
              style={{
                padding: '6px 12px',
                backgroundColor: '#f0f0f0',
                border: '1px solid #ddd',
                borderRadius: '3px',
                fontSize: '12px',
              }}
            >
              🌐 Open on Host
            </SMButton>
          </div>

          {/* Video ID */}
          <div style={{ marginTop: '10px', fontSize: '11px', color: '#999' }}>
            ID: <code style={{ backgroundColor: '#f5f5f5', padding: '2px 4px' }}>{v_id}</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default ArchiveItem;
