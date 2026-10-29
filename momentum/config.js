// Konfiguracja synchronizacji portfela (Supabase → Project Settings → API).
// Klucz „anon public” jest jawny z założenia: dostęp do danych chroni Row Level Security (supabase/schema.sql).
// Puste wartości = aplikacja działa tylko na tym urządzeniu (pamięć przeglądarki).
window.MOMENTUM_CONFIG = {
    supabaseUrl: '',
    supabaseAnonKey: '',
};
