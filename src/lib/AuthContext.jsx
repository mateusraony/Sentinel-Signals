import React, { createContext, useState, useContext, useEffect, useCallback } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/lib/firebaseClient';

const AuthContext = createContext();

// A profile document is created on first login for any Firebase Auth user.
// New profiles always start as role "user" — promoting to "admin" is done
// manually (Firestore console) to avoid a client-side privilege escalation path.
const loadOrCreateProfile = async (firebaseUser) => {
  const profileRef = doc(db, 'users', firebaseUser.uid);
  const snap = await getDoc(profileRef);
  if (snap.exists()) {
    return { uid: firebaseUser.uid, email: firebaseUser.email, ...snap.data() };
  }
  const profile = { role: 'user', email: firebaseUser.email, created_at: serverTimestamp() };
  await setDoc(profileRef, profile);
  return { uid: firebaseUser.uid, email: firebaseUser.email, role: 'user' };
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setIsLoadingAuth(true);
      setAuthError(null);
      try {
        if (firebaseUser) {
          const profile = await loadOrCreateProfile(firebaseUser);
          setUser(profile);
          setIsAuthenticated(true);
        } else {
          setUser(null);
          setIsAuthenticated(false);
        }
      } catch (error) {
        console.error('Auth state resolution failed:', error);
        setAuthError({ type: 'unknown', message: error.message || 'Failed to resolve authentication' });
        setUser(null);
        setIsAuthenticated(false);
      } finally {
        setIsLoadingAuth(false);
        setAuthChecked(true);
      }
    });
    return unsubscribe;
  }, []);

  const login = useCallback(async (email, password) => {
    setAuthError(null);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      const message = error.code === 'auth/invalid-credential'
        ? 'Email ou senha inválidos.'
        : error.message;
      setAuthError({ type: 'auth_required', message });
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    await firebaseSignOut(auth);
    setUser(null);
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      authError,
      authChecked,
      login,
      logout,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
