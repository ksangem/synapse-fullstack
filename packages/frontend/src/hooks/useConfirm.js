import { useContext } from 'react';
import { ConfirmContext } from '../contexts/ConfirmContext';

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return confirm;
}
