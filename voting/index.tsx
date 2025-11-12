import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

// --- API helpers ---
type SessionStatus = 'WAITING' | 'IN_PROGRESS' | 'FINISHED';

interface SessionData {
    status: SessionStatus;
    results: { igen: number; nem: number; tartozkodott: number; };
    totalVoters: number;
    voteStartTime: string | null;
}

interface SessionResponse {
    status?: SessionStatus;
    results?: Partial<Record<'igen' | 'nem' | 'tartozkodott', number>>;
    totalVoters?: number;
    voteStartTime?: string | null;
}

type UserRole = 'admin' | 'voter';

interface AuthUser {
    role: UserRole;
    username?: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    organizationId?: number | null;
    eventId?: number | null;
    eventTitle?: string | null;
}

interface AuthSessionResponse {
    user: AuthUser | null;
}

const DEFAULT_RESULTS: SessionData['results'] = { igen: 0, nem: 0, tartozkodott: 0 };

const toSessionData = (response: SessionResponse | null | undefined): SessionData => ({
    status: response?.status ?? 'WAITING',
    results: {
        igen: Number(response?.results?.igen ?? DEFAULT_RESULTS.igen),
        nem: Number(response?.results?.nem ?? DEFAULT_RESULTS.nem),
        tartozkodott: Number(response?.results?.tartozkodott ?? DEFAULT_RESULTS.tartozkodott),
    },
    totalVoters: Number(response?.totalVoters ?? 0),
    voteStartTime: response?.voteStartTime ?? null,
});

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
    };
    const response = await fetch(path, {
        ...init,
        headers,
        credentials: 'include',
    });

    if (!response.ok) {
        let message = '';
        try {
            const payload = await response.json();
            message = (payload?.detail as string) || (payload?.message as string) || '';
        } catch {
            message = await response.text();
        }
        throw new Error(message || `Request to ${path} failed with status ${response.status}`);
    }

    if (response.status === 204) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

async function fetchAuthSession(): Promise<AuthUser | null> {
    const response = await fetch('/api/auth/session', { credentials: 'include' });
    if (response.status === 401) {
        return null;
    }
    if (!response.ok) {
        let message = '';
        try {
            const payload = await response.json();
            message = (payload?.detail as string) || '';
        } catch {
            message = await response.text();
        }
        throw new Error(message || 'Nem sikerült betölteni a bejelentkezési állapotot.');
    }
    const payload = (await response.json()) as AuthSessionResponse;
    return payload.user;
}

// --- Helper Components ---

const SyncStatus = ({ lastUpdate }: { lastUpdate: Date | null }) => {
    if (!lastUpdate) return null;
    return (
        <div className="sync-status" aria-live="polite">
            Connected | Last sync: {lastUpdate.toLocaleTimeString()}
        </div>
    );
};

const ResultsDisplay = ({ results, totalVoters }: { results: SessionData['results'], totalVoters: number }) => {
    const totalVotes = results.igen + results.nem + results.tartozkodott;
    const nemSzavazott = Math.max(0, totalVoters - totalVotes);
    const totalPossibleVotes = totalVoters > 0 ? totalVoters : totalVotes;

    const getPercentage = (value: number) => {
        return totalPossibleVotes > 0 ? (value / totalPossibleVotes) * 100 : 0;
    };

    return (
        <div className="results-container">
            <div className="result-item">
                <div className="result-label">
                    <span>Igen</span>
                    <span>{results.igen}</span>
                </div>
                <div className="progress-bar">
                    <div className="progress igen" style={{ width: `${getPercentage(results.igen)}%` }} />
                </div>
            </div>
            <div className="result-item">
                <div className="result-label">
                    <span>Nem</span>
                    <span>{results.nem}</span>
                </div>
                <div className="progress-bar">
                    <div className="progress nem" style={{ width: `${getPercentage(results.nem)}%` }} />
                </div>
            </div>
            <div className="result-item">
                <div className="result-label">
                    <span>Tartózkodott</span>
                    <span>{results.tartozkodott}</span>
                </div>
                <div className="progress-bar">
                    <div className="progress tartozkodom" style={{ width: `${getPercentage(results.tartozkodott)}%` }} />
                </div>
            </div>
            <hr />
            <div className="result-summary">
                <span>Nem szavazott:</span>
                <strong>{nemSzavazott}</strong>
            </div>
             <div className="result-summary">
                <span>Összesen:</span>
                <strong>{totalVoters}</strong>
            </div>
        </div>
    );
};


// --- View Components ---

const AdminView = ({ sessionData, onLogout, onSessionUpdate }: {
    sessionData: SessionData,
    onLogout: () => void,
    onSessionUpdate: (session: SessionData) => void,
}) => {
    const VOTE_DURATION_S = 10;
    const [isLoading, setIsLoading] = useState(false);
    const [adminTimeLeft, setAdminTimeLeft] = useState<number | null>(null);

    const voteStartMs = useMemo(() => (
        sessionData.voteStartTime ? new Date(sessionData.voteStartTime).getTime() : null
    ), [sessionData.voteStartTime]);

    const handleFinish = useCallback(async () => {
        setIsLoading(true);
        try {
            const updated = await jsonRequest<SessionResponse>('/api/session/finish', {
                method: 'POST',
            });
            onSessionUpdate(toSessionData(updated));
        } catch (error) {
            console.error("Error finishing vote:", error);
            alert("Hiba a befejezés során.");
        } finally {
            setIsLoading(false);
        }
    }, [onSessionUpdate]);

    useEffect(() => {
        if (sessionData.status !== 'IN_PROGRESS' || !voteStartMs) {
            setAdminTimeLeft(null);
            return;
        }

        const interval = setInterval(() => {
            const nowMs = Date.now();
            const elapsedSeconds = Math.floor((nowMs - voteStartMs) / 1000);
            const newTimeLeft = Math.max(0, VOTE_DURATION_S - elapsedSeconds);
            setAdminTimeLeft(newTimeLeft);

            if (newTimeLeft === 0) {
                clearInterval(interval);
                if (sessionData.status === 'IN_PROGRESS') {
                    handleFinish();
                }
            }
        }, 500);

        return () => clearInterval(interval);
    }, [sessionData.status, voteStartMs, handleFinish]);

    const handleStartVote = async () => {
        setIsLoading(true);
        try {
            const updated = await jsonRequest<SessionResponse>('/api/session/start', {
                method: 'POST',
                body: JSON.stringify({ totalVoters: sessionData.totalVoters }),
            });
            onSessionUpdate(toSessionData(updated));
        } catch (error) {
            console.error("Error starting vote:", error);
            alert("Hiba a szavazás indításakor.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleReset = async () => {
        setIsLoading(true);
        try {
            const updated = await jsonRequest<SessionResponse>('/api/session/reset', {
                method: 'POST',
            });
            onSessionUpdate(toSessionData(updated));
        } catch (error) {
            console.error("Error resetting vote:", error);
            alert("Hiba a visszaállítás során.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="container admin-view">
            <h1>Adminisztrátor</h1>
            <p>Itt kezelheti a szavazási folyamatot.</p>
            
            <div className="admin-info">
                <span>Regisztrált szavazók:</span>
                <strong>{sessionData.totalVoters}</strong>
            </div>

            {sessionData.status === 'WAITING' && (
                <button onClick={handleStartVote} className="btn btn-primary btn-start-vote" disabled={isLoading}>
                    Szavazás Indítása
                </button>
            )}
            
            {sessionData.status === 'IN_PROGRESS' && (
                <div className="admin-timer-container">
                    <p>Hátralévő idő: <strong>{adminTimeLeft ?? VOTE_DURATION_S}s</strong></p>
                    <button onClick={handleFinish} className="btn btn-danger" disabled={isLoading}>
                        Szavazás Befejezése (most)
                    </button>
                </div>
            )}

            {sessionData.status === 'FINISHED' && (
                <button onClick={handleReset} className="btn btn-secondary" disabled={isLoading}>
                    Reset
                </button>
            )}

            <div className="admin-results">
                <h3>Eredmények</h3>
                {sessionData.status === 'WAITING' ? (
                    <p>A szavazás még nem kezdődött el.</p>
                ) : (
                    <ResultsDisplay results={sessionData.results} totalVoters={sessionData.totalVoters} />
                )}
            </div>

            <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
        </div>
    );
};

const VoterView = ({ sessionData, onLogout, eventTitle }: { sessionData: SessionData, onLogout: () => void, eventTitle?: string | null }) => {
    const VOTE_DURATION_S = 10;
    const [timeLeft, setTimeLeft] = useState(VOTE_DURATION_S);
    const [hasVoted, setHasVoted] = useState(false);

    const voteSessionId = sessionData?.voteStartTime ?? undefined;
    const voteStartMs = useMemo(() => (
        sessionData.voteStartTime ? new Date(sessionData.voteStartTime).getTime() : null
    ), [sessionData.voteStartTime]);

    useEffect(() => {
        if (voteSessionId) {
            const votedInThisSession = localStorage.getItem('votedInSession') === voteSessionId;
            setHasVoted(votedInThisSession);
        } else if (sessionData?.status === 'WAITING') {
            // Reset vote status when admin resets
            setHasVoted(false);
            localStorage.removeItem('votedInSession');
        }
    }, [voteSessionId, sessionData?.status]);
    
    useEffect(() => {
        if (sessionData.status !== 'IN_PROGRESS' || !voteStartMs || hasVoted) {
            return;
        }

        const interval = setInterval(() => {
            const nowMs = Date.now();
            const elapsedSeconds = Math.floor((nowMs - voteStartMs) / 1000);
            const newTimeLeft = Math.max(0, VOTE_DURATION_S - elapsedSeconds);
            setTimeLeft(newTimeLeft);

            if (newTimeLeft === 0) {
                clearInterval(interval);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [sessionData.status, voteStartMs, hasVoted]);

    useEffect(() => {
        if (sessionData.status !== 'IN_PROGRESS') {
            setTimeLeft(VOTE_DURATION_S);
        }
    }, [sessionData.status]);

     const handleVote = async (voteType: 'igen' | 'nem' | 'tartozkodott') => {
        if (hasVoted) return;
        setHasVoted(true);
        if(voteSessionId) {
           localStorage.setItem('votedInSession', voteSessionId);
        }

        try {
            await jsonRequest<SessionResponse>('/api/session/vote', {
                method: 'POST',
                body: JSON.stringify({ voteType }),
            });
        } catch (error) {
            console.error("Error casting vote:", error);
            alert("Hiba a szavazat leadásakor.");
            // Rollback UI state if firestore fails
            setHasVoted(false);
            localStorage.removeItem('votedInSession');
        }
    };
    
    const renderContent = () => {
        switch (sessionData.status) {
            case 'WAITING':
                return <h2>Várakozás a szavazásra...</h2>;
            case 'FINISHED':
                return <h2>Szavazás lezárult.</h2>;
            case 'IN_PROGRESS':
                if (hasVoted) {
                    return <div className="vote-cast-msg"><h2>Köszönjük, szavazatát rögzítettük!</h2></div>
                }
                if (timeLeft <= 0) {
                    return <h2>A szavazási idő lejárt.</h2>
                }
                return (
                    <div className="voting-interface">
                        <p>A szavazat leadására rendelkezésre álló idő:</p>
                        <div className="timer">{timeLeft}s</div>
                        <div className="vote-buttons">
                            <button onClick={() => handleVote('igen')} className="btn btn-igen">Igen</button>
                            <button onClick={() => handleVote('nem')} className="btn btn-nem">Nem</button>
                            <button onClick={() => handleVote('tartozkodott')} className="btn btn-tartozkodom">Tartózkodom</button>
                        </div>
                    </div>
                );
            default:
                return <p>Betöltés...</p>;
        }
    }

    const trimmedTitle = (eventTitle || '').trim();

    return (
        <div className="container view-container">
            <h1>Szavazó</h1>
            {trimmedTitle && <p className="event-banner">Aktív esemény: {trimmedTitle}</p>}
            <div className="voter-status-box">
                {renderContent()}
            </div>
            <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
        </div>
    );
};

const LoginScreen = ({ onLogin, error }: { onLogin: (email: string, password: string) => Promise<void> | void, error: string }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        await onLogin(email, password);
    };

    return (
        <div className="container">
            <form onSubmit={handleSubmit}>
                <h1>Szavazórendszer</h1>
                <p>Kérjük, jelentkezzen be a folytatáshoz, vagy használja a MikDashboard felületéről érkező egyszeri bejelentkezést.</p>
                <div className="form-group">
                    <label htmlFor="email">Email cím</label>
                    <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="form-group">
                    <label htmlFor="password">Jelszó</label>
                    <input type="password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <button type="submit" className="btn btn-primary">Bejelentkezés</button>
                {error && <p className="error-message">{error}</p>}
            </form>
        </div>
    );
};

// --- Main App Component ---

const App = () => {
    const [sessionData, setSessionData] = useState<SessionData | null>(null);
    const [user, setUser] = useState<AuthUser | null>(null);
    const [error, setError] = useState('');
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
    const [authChecked, setAuthChecked] = useState(false);
    const [connectionError, setConnectionError] = useState('');

    useEffect(() => {
        let isActive = true;
        const loadSession = async () => {
            try {
                const currentUser = await fetchAuthSession();
                if (isActive) {
                    setUser(currentUser);
                }
            } catch (err) {
                console.error('Failed to load authentication session', err);
            } finally {
                if (isActive) {
                    setAuthChecked(true);
                }
            }
        };
        loadSession();
        return () => {
            isActive = false;
        };
    }, []);

    // Effect for Render API connection
    useEffect(() => {
        let isActive = true;

        const loadInitialSession = async () => {
            try {
                const data = await jsonRequest<SessionResponse>('/api/session');
                if (isActive) {
                    setSessionData(toSessionData(data));
                    setConnectionError('');
                }
            } catch (err) {
                console.error('Failed to load session state', err);
                if (isActive) {
                    setConnectionError('Nem sikerült betölteni a szavazási állapotot.');
                }
            }
        };

        loadInitialSession();

        const eventSource = new EventSource('/api/session/stream');
        eventSource.onmessage = (event) => {
            const payload = JSON.parse(event.data) as SessionResponse;
            setSessionData(toSessionData(payload));
            setLastUpdate(new Date());
            setConnectionError('');
        };
        eventSource.onerror = (event) => {
            console.error('Session stream error', event);
            setConnectionError('A valós idejű kapcsolat megszakadt. Próbálja meg frissíteni az oldalt.');
        };

        return () => {
            isActive = false;
            eventSource.close();
        };
    }, []);

    const handleLogin = async (email: string, password: string): Promise<void> => {
        setError('');
        try {
            const payload = await jsonRequest<AuthSessionResponse>('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ email, password }),
            });
            setUser(payload.user);
            setAuthChecked(true);
        } catch (err) {
            const message = err instanceof Error ? err.message : '';
            setError(message || 'Hibás email cím vagy jelszó.');
        }
    };

    const handleLogout = async (): Promise<void> => {
        try {
            await jsonRequest('/api/auth/logout', { method: 'POST' });
        } catch (err) {
            console.error('Failed to log out', err);
        } finally {
            setUser(null);
            setError('');
        }
    };

    const handleSessionUpdate = (session: SessionData) => {
        setSessionData(session);
    };

    const renderView = () => {
        if (!authChecked) {
            return <div className="container"><h2>Hitelesítés folyamatban...</h2></div>;
        }
        
        if (!user) {
            return <LoginScreen onLogin={handleLogin} error={error} />;
        }
        
        if (!sessionData) {
            return <div className="container"><h2>Adatok betöltése...</h2></div>;
        }

        switch (user.role) {
            case 'admin':
                return <AdminView sessionData={sessionData} onLogout={handleLogout} onSessionUpdate={handleSessionUpdate} />;
            case 'voter':
                return <VoterView sessionData={sessionData} onLogout={handleLogout} eventTitle={user.eventTitle} />;
            default:
                return <LoginScreen onLogin={handleLogin} error={error} />;
        }
    };

    return (
        <>
            {connectionError && (
                <div className="connection-error" role="alert">
                    {connectionError}
                </div>
            )}
            {renderView()}
            {user && <SyncStatus lastUpdate={lastUpdate} />}
        </>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
