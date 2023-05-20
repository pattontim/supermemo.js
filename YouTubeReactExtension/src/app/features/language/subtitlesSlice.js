import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  language: 'en',
};

const subtitlesSlice = createSlice({
  name: 'subtitles',
  initialState,
  reducers: {
    setLanguage(state, action) {
      state.language = action.payload;
    },
  },
});

export const { setLanguage } = subtitlesSlice.actions;

export default subtitlesSlice.reducer;
