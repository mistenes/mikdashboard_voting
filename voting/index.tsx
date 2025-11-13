import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

// --- API helpers ---
type SessionStatus = 'WAITING' | 'IN_PROGRESS' | 'FINISHED';

type AppMode = 'default' | 'admin' | 'public';

const STATUS_MESSAGES: Record<SessionStatus, string> = {
    WAITING: 'A szavazás még nem indult el.',
    IN_PROGRESS: 'A szavazás jelenleg is tart.',
    FINISHED: 'A szavazás lezárult.',
};

const detectAppMode = (): AppMode => {
    const path = window.location.pathname.toLowerCase();
    if (path.startsWith('/admin')) {
        return 'admin';
    }
    if (path.startsWith('/public')) {
        return 'public';
    }
    return 'default';
};

interface SessionData {
    status: SessionStatus;
    results: { igen: number; nem: number; tartozkodott: number; };
    totalVoters: number;
    voteStartTime: string | null;
    voteEndTime: string | null;
    voteDurationSeconds: number;
    serverTimestamp: string | null;
    eventTitle: string | null;
    eventDate: string | null;
    delegateDeadline: string | null;
    isVotingEnabled: boolean;
}

interface SessionResponse {
    status?: SessionStatus;
    results?: Partial<Record<'igen' | 'nem' | 'tartozkodott', number>>;
    totalVoters?: number;
    voteStartTime?: string | null;
    voteEndTime?: string | null;
    voteDurationSeconds?: number;
    serverTimestamp?: string | null;
    eventTitle?: string | null;
    eventDate?: string | null;
    delegateDeadline?: string | null;
    isVotingEnabled?: boolean;
}

type UserRole = 'admin' | 'voter';

interface AuthUser {
    role: UserRole;
    username?: string;
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
    organizationId?: number | null;
    organizationFeePaid?: boolean | null;
    eventId?: number | null;
    eventTitle?: string | null;
    eventDate?: string | null;
    delegateDeadline?: string | null;
    isVotingEnabled?: boolean | null;
    mustChangePassword?: boolean;
    isEventDelegate?: boolean | null;
    source?: string;
}

interface AuthSessionResponse {
    user: AuthUser | null;
}

const DEFAULT_RESULTS: SessionData['results'] = { igen: 0, nem: 0, tartozkodott: 0 };

const DEFAULT_VOTE_DURATION = 10;

const toSessionData = (response: SessionResponse | null | undefined): SessionData => ({
    status: response?.status ?? 'WAITING',
    results: {
        igen: Number(response?.results?.igen ?? DEFAULT_RESULTS.igen),
        nem: Number(response?.results?.nem ?? DEFAULT_RESULTS.nem),
        tartozkodott: Number(response?.results?.tartozkodott ?? DEFAULT_RESULTS.tartozkodott),
    },
    totalVoters: Number(response?.totalVoters ?? 0),
    voteStartTime: response?.voteStartTime ?? null,
    voteEndTime: response?.voteEndTime ?? null,
    voteDurationSeconds: Number(response?.voteDurationSeconds ?? DEFAULT_VOTE_DURATION),
    serverTimestamp: response?.serverTimestamp ?? null,
    eventTitle: response?.eventTitle ?? null,
    eventDate: response?.eventDate ?? null,
    delegateDeadline: response?.delegateDeadline ?? null,
    isVotingEnabled: Boolean(response?.isVotingEnabled ?? false),
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

const formatDateTime = (value: string | null | undefined) => {
    if (!value) {
        return '';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return '';
    }
    return parsed.toLocaleString('hu-HU', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

const getUserDisplayName = (user: AuthUser | null): string => {
    if (!user) {
        return '';
    }
    const first = (user.firstName || '').trim();
    const last = (user.lastName || '').trim();
    const combined = [first, last].filter(Boolean).join(' ');
    if (combined) {
        return combined;
    }
    if (user.username && user.username.trim()) {
        return user.username.trim();
    }
    if (user.email) {
        return user.email;
    }
    return '';
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


const PublicView = ({ sessionData, lastUpdate }: { sessionData: SessionData, lastUpdate: Date | null }) => {
    const statusLabel = STATUS_MESSAGES[sessionData.status];
    const eventTitle = (sessionData.eventTitle || '').trim();
    const eventDateLabel = formatDateTime(sessionData.eventDate);
    const delegateDeadlineLabel = formatDateTime(sessionData.delegateDeadline);
    return (
        <div className="container public-view">
            <header className="view-header" id="overview">
                <h1>Nyilvános szavazás</h1>
                {eventTitle && <p className="event-banner">Esemény: {eventTitle}</p>}
            </header>
            <section className="event-meta" id="event-details">
                {eventDateLabel && <span>Időpont: {eventDateLabel}</span>}
                {delegateDeadlineLabel && <span>Delegált határidő: {delegateDeadlineLabel}</span>}
                <span>Szavazási felület: {sessionData.isVotingEnabled ? 'Engedélyezve' : 'Letiltva'}</span>
            </section>
            <section className="public-status" id="status">
                <div className={`public-status-badge public-status-${sessionData.status.toLowerCase()}`}>
                    {statusLabel}
                </div>
            </section>
            <section className="public-results" id="results">
                <ResultsDisplay results={sessionData.results} totalVoters={sessionData.totalVoters} />
            </section>
            <p className="public-note">
                {lastUpdate
                    ? `Utolsó frissítés: ${lastUpdate.toLocaleTimeString()}`
                    : 'A kijelző automatikusan frissül.'}
            </p>
        </div>
    );
};


const UnauthorizedAdminView = ({ onLogout }: { onLogout: () => void }) => (
    <div className="container">
        <h1>Nincs jogosultság</h1>
        <p>Az admin nézet eléréséhez adminisztrátori jogosultság szükséges.</p>
        <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
    </div>
);


// --- View Components ---

const AdminView = ({ sessionData, onLogout, onSessionUpdate, clockOffsetMs }: {
    sessionData: SessionData,
    onLogout: () => void,
    onSessionUpdate: (session: SessionData) => void,
    clockOffsetMs: number,
}) => {
    const [isLoading, setIsLoading] = useState(false);
    const [adminTimeLeft, setAdminTimeLeft] = useState<number | null>(null);

    const eventTitle = (sessionData.eventTitle || '').trim();
    const eventDateLabel = formatDateTime(sessionData.eventDate);
    const delegateDeadlineLabel = formatDateTime(sessionData.delegateDeadline);

    const voteEndMs = useMemo(() => (
        sessionData.voteEndTime ? new Date(sessionData.voteEndTime).getTime() : null
    ), [sessionData.voteEndTime]);

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
        if (sessionData.status !== 'IN_PROGRESS' || !voteEndMs) {
            setAdminTimeLeft(null);
            return;
        }

        const computeRemaining = () => {
            const nowMs = Date.now() + clockOffsetMs;
            const remainingSeconds = Math.ceil((voteEndMs - nowMs) / 1000);
            return Math.max(0, remainingSeconds);
        };

        setAdminTimeLeft(computeRemaining());

        const interval = setInterval(() => {
            const newTimeLeft = computeRemaining();
            setAdminTimeLeft(newTimeLeft);

            if (newTimeLeft === 0) {
                clearInterval(interval);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [sessionData.status, voteEndMs, clockOffsetMs]);

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
            <header className="view-header" id="overview">
                <h1>Adminisztrátor</h1>
                <p>Itt kezelheti a szavazási folyamatot.</p>
            </header>

            <section className="event-overview" id="event-overview">
                <h2>Aktív esemény</h2>
                {eventTitle ? (
                    <div className="event-overview-card">
                        <p className="event-overview-title">{eventTitle}</p>
                        <ul>
                            {eventDateLabel && <li>Esemény időpontja: <strong>{eventDateLabel}</strong></li>}
                            {delegateDeadlineLabel && <li>Delegált kijelölési határidő: <strong>{delegateDeadlineLabel}</strong></li>}
                            <li>Szavazási felület: <strong>{sessionData.isVotingEnabled ? 'Engedélyezve' : 'Letiltva'}</strong></li>
                        </ul>
                    </div>
                ) : (
                    <p className="muted">Nincs aktív szavazási esemény.</p>
                )}
            </section>

            <section className="admin-controls" id="controls">
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
                        <p>Hátralévő idő: <strong>{adminTimeLeft ?? sessionData.voteDurationSeconds}s</strong></p>
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
            </section>

            <section className="admin-results" id="results">
                <h3>Eredmények</h3>
                {sessionData.status === 'WAITING' ? (
                    <p>A szavazás még nem kezdődött el.</p>
                ) : (
                    <ResultsDisplay results={sessionData.results} totalVoters={sessionData.totalVoters} />
                )}
            </section>

            <div className="view-footer" id="logout">
                <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
            </div>
        </div>
    );
};

const VoterView = ({ sessionData, onLogout, eventTitle, clockOffsetMs }: { sessionData: SessionData, onLogout: () => void, eventTitle?: string | null, clockOffsetMs: number }) => {
    const voteEndMs = useMemo(() => (
        sessionData.voteEndTime ? new Date(sessionData.voteEndTime).getTime() : null
    ), [sessionData.voteEndTime]);

    const computeInitialTimeLeft = useCallback(() => {
        if (sessionData.status === 'IN_PROGRESS' && voteEndMs) {
            const nowMs = Date.now() + clockOffsetMs;
            const remainingSeconds = Math.ceil((voteEndMs - nowMs) / 1000);
            return Math.max(0, remainingSeconds);
        }
        return sessionData.voteDurationSeconds || DEFAULT_VOTE_DURATION;
    }, [sessionData.status, sessionData.voteDurationSeconds, voteEndMs, clockOffsetMs]);

    const [timeLeft, setTimeLeft] = useState<number>(() => computeInitialTimeLeft());
    const [hasVoted, setHasVoted] = useState(false);

    const voteSessionId = sessionData?.voteStartTime ?? undefined;

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
        if (sessionData.status !== 'IN_PROGRESS' || !voteEndMs || hasVoted) {
            return;
        }

        const computeRemaining = () => {
            const nowMs = Date.now() + clockOffsetMs;
            const remainingSeconds = Math.ceil((voteEndMs - nowMs) / 1000);
            return Math.max(0, remainingSeconds);
        };

        setTimeLeft(computeRemaining());

        const interval = setInterval(() => {
            const newTimeLeft = computeRemaining();
            setTimeLeft(newTimeLeft);

            if (newTimeLeft === 0) {
                clearInterval(interval);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [sessionData.status, voteEndMs, hasVoted, clockOffsetMs]);

    useEffect(() => {
        if (sessionData.status !== 'IN_PROGRESS') {
            setTimeLeft(computeInitialTimeLeft());
        }
    }, [sessionData.status, sessionData.voteDurationSeconds, computeInitialTimeLeft]);

    const canVoteNow = sessionData.status === 'IN_PROGRESS' && timeLeft > 0 && !hasVoted;

    const handleVote = async (voteType: 'igen' | 'nem' | 'tartozkodott') => {
        if (hasVoted) return;
        if (timeLeft <= 0) {
            alert('A szavazási idő lejárt.');
            return;
        }
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
            // Rollback UI state if the vote submission fails
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
                return (
                    <div className="voting-interface">
                        {timeLeft > 0 ? (
                            <>
                                <p>A szavazat leadására rendelkezésre álló idő:</p>
                                <div className="timer">{timeLeft}s</div>
                            </>
                        ) : (
                            <p className="timer-expired">A szavazás időkorlátja lejárt.</p>
                        )}
                        <div className="vote-buttons">
                            <button onClick={() => handleVote('igen')} className="btn btn-igen" disabled={!canVoteNow}>Igen</button>
                            <button onClick={() => handleVote('nem')} className="btn btn-nem" disabled={!canVoteNow}>Nem</button>
                            <button onClick={() => handleVote('tartozkodott')} className="btn btn-tartozkodom" disabled={!canVoteNow}>Tartózkodom</button>
                        </div>
                    </div>
                );
            default:
                return <p>Betöltés...</p>;
        }
    }

    const trimmedTitle = (sessionData.eventTitle || eventTitle || '').trim();

    return (
        <div className="container view-container voter-view">
            <header className="view-header" id="overview">
                <h1>Szavazó</h1>
                {trimmedTitle && <p className="event-banner">Aktív esemény: {trimmedTitle}</p>}
            </header>
            <section className="voter-status-section" id="voting">
                <div className="voter-status-box">
                    {renderContent()}
                </div>
            </section>
            <div className="view-footer" id="logout">
                <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
            </div>
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
        <div className="container login-container" id="login">
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
    const [clockOffsetMs, setClockOffsetMs] = useState(0);
    const mode = useMemo<AppMode>(() => detectAppMode(), []);

    const updateClockOffset = useCallback((session: SessionData) => {
        if (!session.serverTimestamp) {
            return;
        }
        const serverMs = new Date(session.serverTimestamp).getTime();
        if (Number.isFinite(serverMs)) {
            setClockOffsetMs(serverMs - Date.now());
        }
    }, []);

    useEffect(() => {
        if (mode === 'public') {
            setAuthChecked(true);
            return;
        }

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
    }, [mode]);

    // Effect for Render API connection
    useEffect(() => {
        let isActive = true;

        const loadInitialSession = async () => {
            try {
                const data = await jsonRequest<SessionResponse>('/api/session');
                const session = toSessionData(data);
                if (isActive) {
                    updateClockOffset(session);
                    setSessionData(session);
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
            const session = toSessionData(payload);
            updateClockOffset(session);
            setSessionData(session);
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
    }, [updateClockOffset]);

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
        updateClockOffset(session);
        setSessionData(session);
    };

    const renderView = () => {
        if (mode === 'public') {
            if (!sessionData) {
                return <div className="container"><h2>Adatok betöltése...</h2></div>;
            }
            return <PublicView sessionData={sessionData} lastUpdate={lastUpdate} />;
        }

        if (!authChecked) {
            return <div className="container"><h2>Hitelesítés folyamatban...</h2></div>;
        }

        if (!user) {
            return <LoginScreen onLogin={handleLogin} error={error} />;
        }

        if (!sessionData) {
            return <div className="container"><h2>Adatok betöltése...</h2></div>;
        }

        if (mode === 'admin' && user.role !== 'admin') {
            return <UnauthorizedAdminView onLogout={handleLogout} />;
        }

        switch (user.role) {
            case 'admin':
                return <AdminView sessionData={sessionData} onLogout={handleLogout} onSessionUpdate={handleSessionUpdate} clockOffsetMs={clockOffsetMs} />;
            case 'voter':
                return <VoterView sessionData={sessionData} onLogout={handleLogout} eventTitle={user.eventTitle} clockOffsetMs={clockOffsetMs} />;
            default:
                return <LoginScreen onLogin={handleLogin} error={error} />;
        }
    };

    return (
        <div className={`app-shell mode-${mode}`}>
            <main className="app-main">
                {connectionError && (
                    <div className="connection-error" role="alert">
                        {connectionError}
                    </div>
                )}
                <div className="app-main-content">
                    {renderView()}
                </div>
                <div className="app-main-footer">
                    {(user || mode === 'public') && <SyncStatus lastUpdate={lastUpdate} />}
                </div>
            </main>
        </div>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
