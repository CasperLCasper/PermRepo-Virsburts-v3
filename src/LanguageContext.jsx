import React, { createContext, useContext, useCallback, useRef, useState, useEffect } from 'react';
import { translations } from './translations';

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
    const languageRef = useRef(localStorage.getItem('permrepo-language') || 'lv');
    const [currentLanguage, setCurrentLanguage] = useState(languageRef.current);

    const t = useCallback((key) => {
        const lang = languageRef.current;
        return translations[lang]?.[key] || translations.lv[key] || key;
    }, []);

    const switchLanguage = useCallback((lang) => {
        if (!translations[lang]) return;
        languageRef.current = lang;
        setCurrentLanguage(lang);
        localStorage.setItem('permrepo-language', lang);
    }, []);

    useEffect(() => {
        const handleStorageChange = (e) => {
            if (e.key === 'permrepo-language' && e.newValue && translations[e.newValue]) {
                languageRef.current = e.newValue;
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
