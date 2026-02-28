import { configureStore } from '@reduxjs/toolkit';
import annotationReducer from './annotationSlice';

export const store = configureStore({
  reducer: {
    annotation: annotationReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;