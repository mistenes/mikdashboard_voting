import { useCallback, useEffect, useState, FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
// Firebase imports
import { initializeApp } from 'firebase/app';
import {
    Timestamp,
    doc,
    getFirestore,
    increment,
    onSnapshot,
    serverTimestamp,
    setDoc,
    updateDoc,
} from 'firebase/firestore';

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyBRXKJ53SS-2zmuzPGRo7orfbCxvV_jYkc",
  authDomain: "mikvoting.firebaseapp.com",
  projectId: "mikvoting",
  storageBucket: "mikvoting.appspot.com",
  messagingSenderId: "1089430048079",
  appId: "1:1089430048079:web:f4ab7500b7257b8deb093a",
  measurementId: "G-M8TJ9LLGHQ"
};

// Check if Firebase config is just a placeholder
const isFirebaseConfigured = firebaseConfig.projectId && firebaseConfig.projectId !== "your-project";

// Initialize Firebase only if configured
const app = isFirebaseConfigured ? initializeApp(firebaseConfig) : undefined;
const db = app ? getFirestore(app) : undefined;
const sessionDocRef = db ? doc(db, "session", "current") : undefined;

// --- Registered Voters ---
const voterCredentials = [
    { username: "voter1", password: "p1" },
    { username: "voter2", password: "p2" },
    { username: "voter3", password: "p3" },
    { username: "voter4", password: "p4" },
    { username: "voter5", password: "p5" },
    { username: "voter6", password: "p6" },
    { username: "voter7", password: "p7" },
    { username: "voter8", password: "p8" },
    { username: "voter9", password: "p9" },
    { username: "voter10", password: "p10" },
];


// --- Interfaces ---
interface SessionData {
    status: 'WAITING' | 'IN_PROGRESS' | 'FINISHED';
    results: { igen: number; nem: number; tartozkodott: number; };
    totalVoters: number;
    voteStartTime?: Timestamp;
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

const AdminView = ({ sessionData, onLogout }: { sessionData: SessionData, onLogout: () => void }) => {
    const VOTE_DURATION_S = 10;
    const [isLoading, setIsLoading] = useState(false);
    const [adminTimeLeft, setAdminTimeLeft] = useState<number | null>(null);

    const handleFinish = useCallback(async () => {
        if (!sessionDocRef) {
            alert("A Firebase kapcsolat nincs konfigurálva.");
            return;
        }
        setIsLoading(true);
        try {
            await updateDoc(sessionDocRef, {
                status: 'FINISHED'
            });
        } catch (error) {
            console.error("Error finishing vote:", error);
            alert("Hiba a befejezés során.");
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (sessionData.status !== 'IN_PROGRESS' || !sessionData.voteStartTime) {
            setAdminTimeLeft(null);
            return;
        }

        const voteStartTimeMs = sessionData.voteStartTime.toMillis();

        const interval = setInterval(() => {
            const nowMs = Date.now();
            const elapsedSeconds = Math.floor((nowMs - voteStartTimeMs) / 1000);
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
    }, [sessionData.status, sessionData.voteStartTime, handleFinish]);

    const handleStartVote = async () => {
        if (!sessionDocRef) {
            alert("A Firebase kapcsolat nincs konfigurálva.");
            return;
        }
        setIsLoading(true);
        try {
            await setDoc(sessionDocRef, {
                status: 'IN_PROGRESS',
                results: { igen: 0, nem: 0, tartozkodott: 0 },
                totalVoters: voterCredentials.length,
                voteStartTime: serverTimestamp(),
            }, { merge: true });
        } catch (error) {
            console.error("Error starting vote:", error);
            alert("Hiba a szavazás indításakor.");
        } finally {
            setIsLoading(false);
        }
    };

    const handleReset = async () => {
        if (!sessionDocRef) {
            alert("A Firebase kapcsolat nincs konfigurálva.");
            return;
        }
        setIsLoading(true);
        try {
            await updateDoc(sessionDocRef, {
                status: 'WAITING'
            });
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
                <strong>{voterCredentials.length}</strong>
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

const VoterView = ({ sessionData, onLogout }: { sessionData: SessionData, onLogout: () => void }) => {
    const VOTE_DURATION_S = 10;
    const [timeLeft, setTimeLeft] = useState(VOTE_DURATION_S);
    const [hasVoted, setHasVoted] = useState(false);
    
    const voteSessionId = sessionData?.voteStartTime?.toMillis().toString();

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
        if (sessionData.status !== 'IN_PROGRESS' || !sessionData.voteStartTime || hasVoted) {
            return;
        }

        const voteStartTimeMs = sessionData.voteStartTime.toMillis();
        
        const interval = setInterval(() => {
            const nowMs = Date.now();
            const elapsedSeconds = Math.floor((nowMs - voteStartTimeMs) / 1000);
            const newTimeLeft = Math.max(0, VOTE_DURATION_S - elapsedSeconds);
            setTimeLeft(newTimeLeft);

            if (newTimeLeft === 0) {
                clearInterval(interval);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [sessionData.status, sessionData.voteStartTime, hasVoted]);
    
     const handleVote = async (voteType: 'igen' | 'nem' | 'tartozkodott') => {
        if (hasVoted) return;
        setHasVoted(true);
        if(voteSessionId) {
           localStorage.setItem('votedInSession', voteSessionId);
        }

        if (!sessionDocRef) {
            alert("A Firebase kapcsolat nincs konfigurálva.");
            setHasVoted(false);
            if (voteSessionId) {
                localStorage.removeItem('votedInSession');
            }
            return;
        }

        try {
            await updateDoc(sessionDocRef, {
                [`results.${voteType}`]: increment(1)
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

    return (
         <div className="container view-container">
            <h1>Szavazó</h1>
             <div className="voter-status-box">
                {renderContent()}
            </div>
            <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
        </div>
    );
};

const PublicView = ({ sessionData, onLogout }: { sessionData: SessionData, onLogout: () => void }) => {
     const renderContent = () => {
        switch (sessionData.status) {
            case 'WAITING':
                return <h2>Várakozás a szavazásra</h2>;
            case 'IN_PROGRESS':
                return <h2>Szavazás folyamatban...</h2>;
            case 'FINISHED':
                return (
                    <>
                        <h2>Eredmények</h2>
                        <ResultsDisplay results={sessionData.results} totalVoters={sessionData.totalVoters} />
                    </>
                );
            default:
                return <p>Betöltés...</p>;
        }
    }
    
    return (
        <div className="container view-container public-view">
            <h1>Publikus nézet</h1>
            {renderContent()}
            <button onClick={onLogout} className="btn btn-secondary logout-button">Kijelentkezés</button>
        </div>
    );
};

const LoginScreen = ({ onLogin, error }: { onLogin: (u: string, p: string) => void, error: string }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const handleSubmit = (e: FormEvent) => {
        e.preventDefault();
        onLogin(username, password);
    };

    return (
        <div className="container">
            <form onSubmit={handleSubmit}>
                <h1>Szavazórendszer</h1>
                <p>Kérjük, jelentkezzen be a folytatáshoz.</p>
                <div className="form-group">
                    <label htmlFor="username">Felhasználónév</label>
                    <input type="text" id="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
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

const FirebaseConfigError = () => (
    <div className="container">
        <h1>Konfiguráció szükséges</h1>
        <p style={{ textAlign: 'left', color: '#333' }}>
            A Firebase kapcsolat nincs beállítva. Kérjük, cserélje ki a placeholder konfigurációt a saját Firebase projektjének adataira az <strong>index.tsx</strong> fájlban.
        </p>
        <pre style={{
            backgroundColor: '#e9ecef',
            padding: '1rem',
            borderRadius: '6px',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: '0.8rem',
            lineHeight: '1.4'
        }}>
            <code>
{`// index.tsx

const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  // ...
};`}
            </code>
        </pre>
    </div>
);


// --- Main App Component ---

const App = () => {
    const [sessionData, setSessionData] = useState<SessionData | null>(null);
    const [user, setUser] = useState<{ role: 'admin' | 'voter' | 'public' } | null>(null);
    const [error, setError] = useState('');
    const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
    const [authChecked, setAuthChecked] = useState(false);

    // Effect for simulated SSO check
    useEffect(() => {
        try {
            const wpUserRaw = localStorage.getItem('wordpress_user');
            if (wpUserRaw) {
                const wpUser = JSON.parse(wpUserRaw);
                // Check for an active user from the simulated WordPress session
                if (wpUser && wpUser.username && wpUser.status === 'active') {
                    console.log(`SSO login for: ${wpUser.username}`);
                    setUser({ role: 'voter' });
                }
            }
        } catch (e) {
            console.error("Failed to parse WordPress user session", e);
        } finally {
            // Mark the authentication check as complete
            setAuthChecked(true);
        }
    }, []);

    // Effect for Firebase connection
    useEffect(() => {
        if (!isFirebaseConfigured || !sessionDocRef) {
            return;
        }
        
        const unsubscribe = onSnapshot(sessionDocRef, (doc) => {
            if (doc.exists()) {
                setSessionData(doc.data() as SessionData);
                setLastUpdate(new Date());
            } else {
                // Initialize the document if it doesn't exist
                setDoc(sessionDocRef, { 
                    status: 'WAITING', 
                    results: { igen: 0, nem: 0, tartozkodott: 0 },
                    totalVoters: voterCredentials.length
                });
            }
        }, (err) => {
            console.error("Firebase listener error:", err);
            setError("Hiba a kapcsolódás során. Kérjük, frissítse az oldalt.");
        });

        return () => unsubscribe();
    }, []);

    const handleLogin = (username, password) => {
        setError('');
        const isVoter = voterCredentials.some(
            cred => cred.username.toLowerCase() === username.toLowerCase() && cred.password === password
        );

        // NOTE: In a real application, use a secure authentication provider.
        if (username.toLowerCase() === 'admin' && password === 'admin') {
            setUser({ role: 'admin' });
        } else if (isVoter) {
            setUser({ role: 'voter' });
        } else if (username.toLowerCase() === 'public' && password === 'public') {
            setUser({ role: 'public' });
        } else {
            setError('Hibás felhasználónév vagy jelszó.');
        }
    };

    const handleLogout = () => {
        // Also clear the simulated WordPress session on logout for consistency
        localStorage.removeItem('wordpress_user');
        setUser(null);
    };

    if (!isFirebaseConfigured) {
        return <FirebaseConfigError />;
    }
    
    const renderView = () => {
        if (!authChecked) {
            return <div className="container"><h2>Authenticating...</h2></div>;
        }
        
        if (!user) {
            return <LoginScreen onLogin={handleLogin} error={error} />;
        }
        
        if (!sessionData) {
            return <div className="container"><h2>Adatok betöltése...</h2></div>;
        }

        switch (user.role) {
            case 'admin':
                return <AdminView sessionData={sessionData} onLogout={handleLogout} />;
            case 'voter':
                return <VoterView sessionData={sessionData} onLogout={handleLogout} />;
            case 'public':
                return <PublicView sessionData={sessionData} onLogout={handleLogout} />;
            default:
                return <LoginScreen onLogin={handleLogin} error={error} />;
        }
    };

    return (
        <>
            {renderView()}
            {user && <SyncStatus lastUpdate={lastUpdate} />}
        </>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
