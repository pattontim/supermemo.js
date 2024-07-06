import { useState, useEffect } from 'react';

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
