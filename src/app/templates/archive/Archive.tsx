import ArchiveItem from '../../../app/features/extractors/ArchiveItem';
import React, { useState, useEffect } from 'react';
import { SMButton, SMRadio, SMTextInput } from '../../features/sm/SMElements';

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

interface SearchResponse {
  items: ArchiveData;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

type SortBy = 'title' | 'date' | 'author';

const PAGE_SIZE = 10;
// false = render nothing until a search is submitted ("results only on search/enter")
// true  = show the first page (date-sorted) on mount
const FETCH_FIRST_PAGE_ON_MOUNT = false;

function Archive() {
  const [results, setResults] = useState<ArchiveData>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [searched, setSearched] = useState(FETCH_FIRST_PAGE_ON_MOUNT);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState({ archiveCount: 0, totalFiles: 0, cached: 0 });

  const fetchPage = (q: string, sort: SortBy, p: number) => {
    setLoading(true);
    const xhr = new XMLHttpRequest();
    xhr.open(
      'GET',
      '/archivei/search?q=' + encodeURIComponent(q) +
      '&sort=' + sort + '&page=' + p + '&limit=' + PAGE_SIZE,
      true
    );
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const data: SearchResponse = JSON.parse(xhr.responseText);
          setResults(data.items);
          setTotal(data.total);
          setPage(data.page);
          setTotalPages(data.totalPages);
        } catch (e) {
          console.error('Failed to parse results:', e);
        }
      } else {
        console.error('Failed to fetch results:', xhr.statusText);
      }
      setLoading(false);
    };
    xhr.onerror = () => {
      console.error('Failed to fetch results: Network error');
      setLoading(false);
    };
    xhr.send();
  };

  // Mount: only lightweight stats — no archive payload.
  useEffect(() => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/archivei/stats', true);
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          const d = JSON.parse(xhr.responseText);
          setStats(s => ({ ...s, archiveCount: d.archiveCount, totalFiles: d.totalFiles }));
        } catch (e) { console.error(e); }
      }
    };
    xhr.send();

    const xhr2 = new XMLHttpRequest();
    xhr2.open('GET', '/cachei/count', true);
    xhr2.onload = () => {
      if (xhr2.status === 200) {
        try { setStats(s => ({ ...s, cached: JSON.parse(xhr2.responseText).count })); }
        catch (e) { console.error(e); }
      }
    };
    xhr2.send();

    if (FETCH_FIRST_PAGE_ON_MOUNT) fetchPage('', 'date', 1);
  }, []);

  const performSearch = () => {
    setSearched(true);
    fetchPage(searchTerm.trim(), sortBy, 1);
  };

  const changeSort = (s: SortBy) => {
    setSortBy(s);
    if (searched) fetchPage(searchTerm.trim(), s, 1);
  };

  const gotoPage = (p: number) => {
    if (p < 1 || p > totalPages) return;
    fetchPage(searchTerm.trim(), sortBy, p);
  };

  const entries = Object.entries(results); // already sorted server-side

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
              <strong>Archived Videos:</strong> {stats.archiveCount}
            </span>
            <span style={{ marginRight: '20px' }}>
              <strong>Cached Videos:</strong> {stats.cached}
            </span>
            <span>
              <strong>Total Files:</strong> {stats.totalFiles}
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
              setSearched(true);
              fetchPage('', sortBy, 1);
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
                onSelect={() => changeSort(option)}
                label={option.charAt(0).toUpperCase() + option.slice(1)}
              />
            </span>
          ))}
        </div>
      </div>

      {/* Results Section */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px', fontSize: '14px', color: '#333' }}>
          Results ({total})
        </div>
        <div>
          {!searched ? (
            <div style={{ padding: '20px', color: '#666' }}>
              Enter a search term to browse the archive.
            </div>
          ) : loading ? (
            <div style={{ padding: '20px', color: '#666' }}>Loading…</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: '20px', color: '#666' }}>No results found</div>
          ) : (
            entries.map(([v_id, info]) => <ArchiveItem key={v_id} v_id={v_id} info={info} />)
          )}
        </div>

        {/* Pagination — SMButton so no <input>/<button> leaks into SM's DOM scan */}
        {searched && !loading && totalPages > 1 && (
          <div className="row" style={{ justifyContent: 'center', marginTop: '10px', alignItems: 'center' }}>
            <SMButton onClick={() => gotoPage(page - 1)}>« Prev</SMButton>
            <span style={{ margin: '0 12px', fontSize: '13px' }}>
              Page {page} of {totalPages}
            </span>
            <SMButton onClick={() => gotoPage(page + 1)}>Next »</SMButton>
          </div>
        )}
      </div>
    </div>
  );
}

export default Archive;
