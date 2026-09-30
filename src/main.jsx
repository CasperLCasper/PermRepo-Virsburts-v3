import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { LanguageProvider } from './LanguageContext';
import App from './App';
import BackupPage from './BackupPage';
import GuideButton from './GuideButton';
import './styles.css';
import './GuideButton.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <GuideButton />
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/backup" element={<BackupPage />} />
        </Routes>
      </LanguageProvider>
    </BrowserRouter>
  </React.StrictMode>
);
