import { configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'
import { TypedUseSelectorHook, useDispatch, useSelector } from 'react-redux'
import { adoApi } from './api/adoApi'
import workspaceReducer from './workspaceSlice'
import recentSearchesReducer from './recentSearchesSlice'
import preferencesReducer from './preferencesSlice'

export const store = configureStore({
  reducer: {
    [adoApi.reducerPath]: adoApi.reducer,
    workspace: workspaceReducer,
    recentSearches: recentSearchesReducer,
    preferences: preferencesReducer
  },
  middleware: (getDefault) => getDefault().concat(adoApi.middleware)
})

setupListeners(store.dispatch)

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
