import { useContext } from 'react';
import { DetailPaneContext } from '../contexts/DetailPaneContext';

export function useDetailPane() {
  const context = useContext(DetailPaneContext);
  if (!context) {
    throw new Error('useDetailPane must be used within a DetailPaneProvider');
  }
  return context;
}
