import { useState, useEffect } from 'react';

export enum StorageKey {
  /** Autoplay on hover in/out of clips */
  AUTO_HOVER = 'AUTO_HOVER',
  /** Apply auto hover to long clips too */
  AUTO_HOVER_LONG_CLIPS = 'AUTO_HOVER_LONG_CLIPS',
  AUTO_HOVER_OUTSIDE_CLIP_BOUNDS = 'AUTO_HOVER_OUTSIDE_CLIP_BOUNDS',

  /** Always autoplay shorts on start*/
  AUTO_PLAY_SHORTS_ALWAYS = 'AUTO_PLAY_SHORTS_ALWAYS',

  /** Fake fullscreen on short clips */
  FAKE_FULLSCREEN_SHORTS = 'FAKE_FULLSCREEN_SHORTS',

  /** Use the arrow keys to move bk/fwd frames  */
  ARROW_FRAME_MODE = 'ARROW_FRAME_MODE',

  /** Cleanup captions on archive (remove formatting issues, multiline spam, IE11 incompatibilities) */
  CLEANUP_CAPTIONS_ON_ARCHIVE = 'CLEANUP_CAPTIONS_ON_ARCHIVE',

  /** Click-to-zoom mode: magnify video 1.5x, recenter on click position */
  CLICK_ZOOM = 'CLICK_ZOOM',

  /** Mouse-follow zoom: magnify video 1.5x, viewport follows the cursor */
  FOLLOW_ZOOM = 'FOLLOW_ZOOM',
}

export function useLocalStorage<T>(key: string, initialValue: T, bufferTime: number = 1000) {
  const [value, setValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  useEffect(() => {
    const writeToStorage = () => {
      try {
        // console.log('sync writeToStorage', key, value);
        window.localStorage.setItem(key, JSON.stringify(value));
        (window as any).lastWritten = Date.now();
      } catch (error) {
        console.error(error);
      }
    };

    const now = Date.now();
    const lastWritten = (window as any).lastWritten || 0;

    if (now - lastWritten >= bufferTime) {
      writeToStorage();
    } else {
      const timeoutId = setTimeout(writeToStorage, bufferTime - (now - lastWritten));
      return () => clearTimeout(timeoutId);
    }
  }, [key, value, bufferTime]);

  return [value, setValue] as const;
}
