import { combineReducers } from '@reduxjs/toolkit';

import counterReducer from './features/counter/counterSlice';
import subtitlesReducer from './features/language/subtitlesSlice';

const rootReducer = combineReducers({
  counter: counterReducer,
  subtitles: subtitlesReducer,
});

export default rootReducer;
