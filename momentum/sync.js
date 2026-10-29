// Synchronizacja stanu portfela przez Supabase (logowanie e-mailem i hasłem).
window.MomentumSync = (function () {
    'use strict';
    const cfg = window.MOMENTUM_CONFIG || {};
    const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);
    const client = configured && window.supabase ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
    let user = null;

    async function init(onUser) {
        if (!client) return;
        const { data } = await client.auth.getSession();
        user = data.session?.user || null;
        onUser(user);
        client.auth.onAuthStateChange((_event, session) => {
            const next = session?.user || null;
            if (next?.id === user?.id) return;
            user = next;
            onUser(user);
        });
    }

    async function signIn(email, password) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
    }

    // zwraca true, gdy Supabase wymaga potwierdzenia adresu e-mail
    async function signUp(email, password) {
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } });
        if (error) throw error;
        return !data.session;
    }

    async function signOut() {
        await client.auth.signOut();
    }

    async function pull() {
        const { data, error } = await client.from('portfolios').select('data').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        return data?.data || null;
    }

    async function push(doc) {
        const { error } = await client.from('portfolios').upsert({ user_id: user.id, data: doc, updated_at: new Date().toISOString() });
        if (error) throw error;
    }

    return {
        configured,
        get available() { return Boolean(client); },
        get user() { return user; },
        init, signIn, signUp, signOut, pull, push,
    };
})();
