import React from 'react'
import { useSelector, useDispatch } from 'react-redux'
import { setLanguage } from './subtitlesSlice'

export default function Subtitles() {
  const subtitles = useSelector(state => state.subtitles)
  const dispatch = useDispatch()

  const popularLanguages = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish' },
    { code: 'fr', name: 'French' },
    { code: 'de', name: 'German' },
    { code: 'it', name: 'Italian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'pt', name: 'Portuguese' },
    { code: 'ru', name: 'Russian' },
    { code: 'zh', name: 'Chinese' },
  ];

  const handleLanguageChange = (event) => {
    console.log(event.target.value);
    dispatch(setLanguage(event.target.value));
  };

  return (
    <div>
      <label htmlFor="language-select">Select Language:</label>
      <select id="language-select" value={subtitles.language} onChange={handleLanguageChange}>
        {popularLanguages.map((lang) => (
          <option key={lang.code} value={lang.code}>{lang.name}</option>
        ))}
      </select>
      <button onClick={() => console.log(subtitles.language)}>Print</button>
    </div>
  );
}