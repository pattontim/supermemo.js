import ArchiveItem from '../../../app/features/extractors/ArchiveItem';
import React, { useState, useEffect } from 'react';
import { SMButton, SMRadio, SMTextInput } from '../../features/sm/SMControls';

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

interface ArchiveData {
  [v_id: string]: ArchiveInfoData;
}

interface CacheStats {
  totalCount: number;
}

type SortBy = 'title' | 'date' | 'author';

function Archive() {
  const [archive, setArchive] = useState<ArchiveData>({});
  const [filteredArchive, setFilteredArchive] = useState<ArchiveData>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [loading, setLoading] = useState(true);
  const [cacheStats, setCacheStats] = useState<CacheStats>({ totalCount: 0 });

  // Fetch archive data on mount
  useEffect(() => {
    const fetchArchive = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/archivei/', true);
      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            setArchive(data);
            setFilteredArchive(data);
          } catch (error) {
            console.error('Failed to parse archive data:', error);
          }
        } else {
          console.error('Failed to fetch archive:', xhr.statusText);
        }
        setLoading(false);
      };
      xhr.onerror = () => {
        console.error('Failed to fetch archive: Network error');
        setLoading(false);
      };
      xhr.send();
    };

    const fetchCacheStats = () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/cachei/', true);
      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const data = JSON.parse(xhr.responseText);
            setCacheStats({ totalCount: Object.keys(data).length });
          } catch (error) {
            console.error('Failed to parse cache stats:', error);
          }
        } else {
          console.error('Failed to fetch cache stats:', xhr.statusText);
        }
      };
      xhr.onerror = () => {
        console.error('Failed to fetch cache stats: Network error');
      };
      xhr.send();
    };

    fetchArchive();
    fetchCacheStats();
  }, []);

  const performSearch = () => {
    const term = searchTerm.toLowerCase();
    if (!term) {
      setFilteredArchive(archive);
      return;
    }

    const filtered = Object.entries(archive).reduce((acc, [v_id, info]) => {
      const searchableContent = [
        info.title,
        info.author_name,
        info.description,
        info.published,
        v_id,
      ]
        .join(' ')
        .toLowerCase();

      if (searchableContent.includes(term)) {
        acc[v_id] = info;
      }
      return acc;
    }, {} as ArchiveData);

    setFilteredArchive(filtered);
  };

  const sortedEntries = Object.entries(filteredArchive).sort(([, a], [, b]) => {
    switch (sortBy) {
      case 'title':
        return a.title.localeCompare(b.title);
      case 'author':
        return a.author_name.localeCompare(b.author_name);
      case 'date':
      default:
        return new Date(b.archived_on).getTime() - new Date(a.archived_on).getTime();
    }
  });

  if (loading) {
    return (
      <div className="app">
        <div className="col">
          <b>Archive</b>
        </div>
        <div style={{ padding: '20px' }}>Loading archive...</div>
      </div>
    );
  }

  const archiveCount = Object.keys(archive).length;
  const fileFormatsCount = Object.values(archive).reduce(
    (acc, info) => acc + Object.keys(info.file_formats || {}).length,
    0
  );

  return (
    <div className="app">
      {/* Stats Section */}
      <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>
          Stats
        </div>
        <div className="row">
          <div style={{ padding: '8px 12px' }}>
            <span style={{ marginRight: '20px' }}>
              <strong>Archived Videos:</strong> {archiveCount}
            </span>
            <span style={{ marginRight: '20px' }}>
              <strong>Cached Videos:</strong> {cacheStats.totalCount}
            </span>
            <span>
              <strong>Total Files:</strong> {fileFormatsCount}
            </span>
          </div>
        </div>
      </div>

      {/* Search Section */}
      <div style={{ marginBottom: '20px', paddingBottom: '16px', borderBottom: '2px solid #ddd' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>
          Search
        </div>
        <div className="row">
          <SMTextInput
            placeholder="Search by title, author, description..."
            value={searchTerm}
            onChange={setSearchTerm}
            onEnter={performSearch}
            style={{ flex: 1, minWidth: '250px', marginRight: '8px' }}
          />
          <SMButton onClick={performSearch}>Search</SMButton>
          <SMButton
            onClick={() => {
              setSearchTerm('');
              setFilteredArchive(archive);
            }}
            style={{ marginLeft: '4px' }}
          >
            Clear
          </SMButton>
        </div>

        {/* Sort Options */}
        <div className="row" style={{ marginTop: '10px', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', marginRight: '20px' }}>
            Sort by:
          </span>
          {(['date', 'title', 'author'] as const).map((option) => (
            <span key={option} style={{ display: 'flex', alignItems: 'center', marginRight: '15px' }}>
              <SMRadio
                checked={sortBy === option}
                onSelect={() => setSortBy(option)}
                label={option.charAt(0).toUpperCase() + option.slice(1)}
              />
            </span>
          ))}
        </div>
      </div>

      {/* Results Section */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>
          Results ({sortedEntries.length})
        </div>
        <div>
          {sortedEntries.length === 0 ? (
            <div style={{ padding: '20px', color: '#666' }}>No results found</div>
          ) : (
            sortedEntries.map(([v_id, info]) => <ArchiveItem key={v_id} v_id={v_id} info={info} />)
          )}
        </div>
      </div>
    </div>
  );
}

export default Archive;
