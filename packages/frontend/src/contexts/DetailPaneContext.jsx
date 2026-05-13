import { createContext, useState, useCallback } from 'react';

export const DetailPaneContext = createContext();

export function DetailPaneProvider({ children }) {
  const [pane, setPane] = useState({
    isOpen: false,
    title: '',
    bodyContent: null,
    breadcrumb: '',
  });

  const openDetailPane = useCallback((title, bodyContent, breadcrumb) => {
    setPane({ isOpen: true, title, bodyContent, breadcrumb });
  }, []);

  const closeDetailPane = useCallback(() => {
    setPane({ isOpen: false, title: '', bodyContent: null, breadcrumb: '' });
  }, []);

  return (
    <DetailPaneContext.Provider value={{ ...pane, openDetailPane, closeDetailPane }}>
      {children}
    </DetailPaneContext.Provider>
  );
}
