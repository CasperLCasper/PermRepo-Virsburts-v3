import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { translations } from './translations';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
    const [currentLanguage, setCurrentLanguage] = useState(() => {
        return localStorage.getItem('permrepo-language') || 'lv';
    });

    const t = useCallback((key) => {
        return translations[currentLanguage]?.[key] || translations.lv[key] || key;
    }, [currentLanguage]);

    const switchLanguage = useCallback((lang) => {
        if (!translations[lang]) return;
        setCurrentLanguage(lang);
        localStorage.setItem('permrepo-language', lang);
    }, []);

    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'permrepo-language' && e.newValue) {
                setCurrentLanguage(e.newValue);
            }
        };

        window.addEventListener('storage', handleStorageChange);
        return () => window.removeEventListener('storage', handleStorageChange);
    }, []);

    return (
        <LanguageContext.Provider value={{ currentLanguage, t, switchLanguage }}>
            {children}
        </LanguageContext.Provider>
    );
}

export function useLanguage() {
    const context = useContext(LanguageContext);
    if (!context) {
        throw new Error('useLanguage jāizmanto iekš LanguageProvider!');
    }
    return context;
}
