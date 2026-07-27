import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles.css';
import { installHorizontalWheelScroll } from './utils/horizontalWheelScroll';

// System-wide: hovering any horizontally-scrolling container + mouse wheel scrolls it sideways.
installHorizontalWheelScroll();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
